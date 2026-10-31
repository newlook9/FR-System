"""FR System - face engine (InsightFace / ArcFace). Optional: server runs without it."""
import os, threading
import numpy as np
_lock = threading.Lock()

MODEL = os.environ.get("FRS_FACE_MODEL", "buffalo_l")   # buffalo_s = lighter for weak CPUs
MIN_DET = float(os.environ.get("FRS_MIN_DET", "0.6"))   # face-detector confidence
_engine = None
_err = None

class FakeEngine:
    """TEST ONLY (FRS_TEST_FAKE_ENGINE=1): embedding from image bytes' mean colour. Never use in production."""
    def faces(self, bgr):
        h, w = bgr.shape[:2]
        v = np.zeros(512, np.float32); m = bgr.reshape(-1, 3).mean(0)
        v[:3] = m / (np.linalg.norm(m) + 1e-6); v[3:] = 0.01
        return [((0, 0, w, h), v / np.linalg.norm(v), 0.99)]

class InsightEngine:
    def __init__(self):
        from insightface.app import FaceAnalysis
        prov = os.environ.get("FRS_PROVIDERS", "CPUExecutionProvider").split(",")
        self.app = FaceAnalysis(name=MODEL, providers=prov)
        self.app.prepare(ctx_id=0 if "CUDAExecutionProvider" in prov else -1, det_size=(640, 640))
    def faces(self, bgr):
        out = []
        for f in self.app.get(bgr):
            if f.det_score >= MIN_DET:
                out.append((tuple(int(x) for x in f.bbox), f.normed_embedding.astype(np.float32), float(f.det_score)))
        return out

def engine():
    """Returns the engine, or None if libraries/models are not installed."""
    global _engine, _err
    with _lock:
        if _engine is None and _err is None:
            try:
                _engine = FakeEngine() if os.environ.get("FRS_TEST_FAKE_ENGINE") == "1" else InsightEngine()
            except Exception as e:
                _err = str(e)
    return _engine

def error():
    return _err

def embed_jpeg(raw):
    """Largest face in a JPEG -> (embedding, det_score) or None."""
    import cv2
    e = engine()
    if e is None: return None
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None: return None
    fs = e.faces(img)
    if not fs: return None
    b = max(fs, key=lambda f: (f[0][2] - f[0][0]) * (f[0][3] - f[0][1]))
    return b[1], b[2]
