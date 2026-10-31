#!/usr/bin/env python3
"""FR System - camera worker. Reads cameras, finds faces, matches the watchlist, reports to the server.
Run on the same PC as server.py, or on an edge PC near the cameras (set FRS_SERVER and FRS_SERVICE_KEY)."""
import base64, collections, json, os, sys, threading, time, urllib.request
import cv2, numpy as np
import face

ROOT = os.path.dirname(os.path.abspath(__file__))
SERVER = os.environ.get("FRS_SERVER", "http://localhost:8000").rstrip("/")
THRESH = float(os.environ.get("FRS_THRESHOLD", "0.55"))     # cosine similarity; raise it to cut false alerts
CONFIRM = int(os.environ.get("FRS_CONFIRM_FRAMES", "2"))    # same person in N frames within WINDOW seconds
WINDOW = float(os.environ.get("FRS_WINDOW", "6"))
FPS = float(os.environ.get("FRS_FPS", "2"))
MIN_FACE = int(os.environ.get("FRS_MIN_FACE", "60"))        # ignore faces smaller than this many pixels wide
LOCAL_COOLDOWN = 60

def key():
    k = os.environ.get("FRS_SERVICE_KEY")
    if k: return k
    p = os.path.join(os.environ.get("FRS_DATA", os.path.join(ROOT, "data")), "service_key.txt")
    return open(p).read().strip()
KEY = key()

def call(method, path, body=None):
    r = urllib.request.Request(SERVER + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={"Content-Type": "application/json", "X-Service-Key": KEY})
    with urllib.request.urlopen(r, timeout=20) as x: return json.load(x)

class Watchlist:
    def __init__(self): self.ids, self.names, self.M, self.lock = [], [], np.zeros((0, 512), np.float32), threading.Lock()
    def refresh(self):
        wl = call("GET", "/api/watchlist"); ids, names, vecs = [], [], []
        for p in wl:
            for b in p["vecs"]:
                ids.append(p["id"]); names.append(p["name"]); vecs.append(np.frombuffer(base64.b64decode(b), np.float32))
        with self.lock:
            self.ids, self.names = ids, names
            self.M = np.stack(vecs) if vecs else np.zeros((0, 512), np.float32)
        print(f"[watchlist] {len(set(ids))} people, {len(ids)} face vectors")
    def best(self, emb):
        with self.lock:
            if not len(self.ids): return None
            s = self.M @ emb; i = int(s.argmax()); return self.ids[i], self.names[i], float(s[i])

def snapshot(frame, box):
    f = frame.copy(); x1, y1, x2, y2 = box
    cv2.rectangle(f, (x1, y1), (x2, y2), (0, 0, 255), 3)
    k = min(1.0, 640 / max(f.shape[:2])); f = cv2.resize(f, None, fx=k, fy=k)
    ok, buf = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()

def watch(cam, wl, eng):
    cid, name, src = cam["id"], cam.get("name", cam["id"]), cam["source"]
    src = int(src) if str(src).isdigit() else src
    hits, last_sent = collections.defaultdict(collections.deque), {}
    while True:
        cap = cv2.VideoCapture(src)
        if not cap.isOpened(): print(f"[{cid}] cannot open camera, retry in 10s"); time.sleep(10); continue
        print(f"[{cid}] connected"); nxt = 0
        while True:
            ok = cap.grab()
            if not ok: print(f"[{cid}] stream lost"); break
            if time.time() < nxt: continue
            nxt = time.time() + 1.0 / FPS
            ok, frame = cap.retrieve()
            if not ok: continue
            for box, emb, ds in eng.faces(frame):
                if box[2] - box[0] < MIN_FACE: continue
                m = wl.best(emb)
                if not m or m[2] < THRESH: continue
                pid, pname, score = m; now = time.time(); q = hits[pid]
                q.append(now)
                while q and now - q[0] > WINDOW: q.popleft()
                if len(q) >= CONFIRM and now - last_sent.get(pid, 0) > LOCAL_COOLDOWN:
                    last_sent[pid] = now; q.clear()
                    try:
                        r = call("POST", "/api/events", {"camera_id": cid, "camera_name": name, "person_id": pid, "score": round(score, 3), "snapshot": snapshot(frame, box)})
                        print(f"[{cid}] MATCH {pname} score={score:.2f} -> {r}")
                    except Exception as e: print(f"[{cid}] could not report: {e}")
        cap.release(); time.sleep(3)

def main():
    cams = json.load(open(os.environ.get("FRS_CAMERAS", os.path.join(ROOT, "cameras.json"))))
    eng = face.engine()
    if eng is None: sys.exit("Face engine not available: " + str(face.error()) + "\nInstall: pip install -r requirements-face.txt")
    wl = Watchlist(); wl.refresh()
    for c in cams: threading.Thread(target=watch, args=(c, wl, eng), daemon=True).start()
    while True:
        time.sleep(60)
        try: wl.refresh()
        except Exception as e: print("[watchlist] refresh failed:", e)

if __name__ == "__main__": main()
