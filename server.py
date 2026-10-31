#!/usr/bin/env python3
"""FR System - Part 1: records server. Pure Python 3.9+, no installs needed."""
import base64, hashlib, hmac, json, mimetypes, os, re, secrets, sqlite3, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("FRS_DATA", os.path.join(ROOT, "data"))
WEB = os.path.join(ROOT, "web")
PHOTOS = os.path.join(DATA, "photos")
PORT = int(os.environ.get("FRS_PORT", "8000"))
SESSION_HOURS = 8
ROLES = ("admin", "officer", "viewer")
PERSON_STATUS = ("wanted", "absconder", "arrested", "under_investigation", "convicted", "cleared")
CASE_STATUS = ("registered", "investigation", "in_court", "convicted", "acquitted", "closed")
os.makedirs(PHOTOS, exist_ok=True)

_local = threading.local()
def db():
    if not hasattr(_local, "c"):
        c = sqlite3.connect(os.path.join(DATA, "frs.db"), timeout=15)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        _local.c = c
    return _local.c

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER DEFAULT 1, must_change INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS persons(id INTEGER PRIMARY KEY, name TEXT NOT NULL, father_name TEXT, alias TEXT, cnic TEXT,
  dob TEXT, gender TEXT, phone TEXT, address TEXT, height TEXT, marks TEXT, status TEXT NOT NULL DEFAULT 'wanted',
  notes TEXT, has_photo INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_p_cnic ON persons(cnic);
CREATE TABLE IF NOT EXISTS cases(id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES persons(id), fir_no TEXT NOT NULL,
  police_station TEXT, fir_date TEXT, sections TEXT, location TEXT, status TEXT NOT NULL DEFAULT 'registered', court TEXT,
  next_hearing TEXT, details TEXT, archived INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_c_person ON cases(person_id);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER, username TEXT, action TEXT, target TEXT, ip TEXT);
"""

def hash_pw(pw, salt):
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000).hex()

def add_user(username, name, role, pw, must_change=0):
    salt = secrets.token_hex(16)
    db().execute("INSERT INTO users(username,name,role,salt,hash,must_change,created_at) VALUES(?,?,?,?,?,?,?)",
                 (username, name, role, salt, hash_pw(pw, salt), must_change, int(time.time())))
    db().commit()

def init():
    db().executescript(SCHEMA)
    if db().execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        pw = secrets.token_urlsafe(9)
        add_user("admin", "Administrator", "admin", pw, must_change=1)
        with open(os.path.join(DATA, "INITIAL_ADMIN_PASSWORD.txt"), "w") as f:
            f.write(f"username: admin\npassword: {pw}\n(Delete this file after first login.)\n")
        print("=" * 56, f"\n FIRST RUN  ->  username: admin   password: {pw}\n (also saved in data/INITIAL_ADMIN_PASSWORD.txt)\n" + "=" * 56)

def log(user, action, target="", ip=""):
    db().execute("INSERT INTO audit(ts,username,action,target,ip) VALUES(?,?,?,?,?)", (int(time.time()), user, action, str(target), ip))
    db().commit()

_fails = {}
def locked(u):
    f = [t for t in _fails.get(u, []) if t > time.time() - 600]
    _fails[u] = f
    return len(f) >= 5

class Err(Exception):
    def __init__(s, code, msg): s.code, s.msg = code, msg

def s(v, n=300):
    return (str(v).strip()[:n]) if v is not None else ""

PERSON_F = ["name", "father_name", "alias", "cnic", "dob", "gender", "phone", "address", "height", "marks", "status", "notes"]
CASE_F = ["fir_no", "police_station", "fir_date", "sections", "location", "status", "court", "next_hearing", "details"]

def clean_person(d):
    p = {k: s(d.get(k), 1000 if k in ("notes", "address", "marks") else 120) for k in PERSON_F}
    if not p["name"]: raise Err(400, "name_required")
    p["cnic"] = re.sub(r"\D", "", p["cnic"])
    if p["cnic"] and len(p["cnic"]) != 13: raise Err(400, "cnic_invalid")
    if p["status"] not in PERSON_STATUS: p["status"] = "wanted"
    return p

def clean_case(d):
    c = {k: s(d.get(k), 2000 if k == "details" else 200) for k in CASE_F}
    if not c["fir_no"]: raise Err(400, "fir_required")
    if c["status"] not in CASE_STATUS: c["status"] = "registered"
    return c

def save_photo(pid, data_url):
    m = re.match(r"data:image/jpeg;base64,(.+)$", data_url or "", re.S)
    if not m: raise Err(400, "photo_invalid")
    raw = base64.b64decode(m.group(1))
    if raw[:3] != b"\xff\xd8\xff" or len(raw) > 3_000_000: raise Err(400, "photo_invalid")
    with open(os.path.join(PHOTOS, f"{pid}.jpg"), "wb") as f: f.write(raw)

def need(u, *roles):
    if u["role"] not in roles: raise Err(403, "forbidden")

# ---------------- API handlers ----------------
def api(method, path, q, body, user, ip):
    parts = path.strip("/").split("/")[1:]  # drop 'api'
    r = parts[0] if parts else ""
    if r == "login" and method == "POST":
        un = s(body.get("username"), 60).lower()
        if locked(un): raise Err(429, "locked")
        row = db().execute("SELECT * FROM users WHERE username=? AND active=1", (un,)).fetchone()
        if not row or not hmac.compare_digest(hash_pw(s(body.get("password"), 200), row["salt"]), row["hash"]):
            _fails.setdefault(un, []).append(time.time()); log(un, "login_failed", "", ip); raise Err(401, "bad_login")
        tok = secrets.token_urlsafe(32)
        db().execute("DELETE FROM sessions WHERE expires<?", (int(time.time()),))
        db().execute("INSERT INTO sessions VALUES(?,?,?)", (tok, row["id"], int(time.time()) + SESSION_HOURS * 3600)); db().commit()
        log(un, "login", "", ip)
        return {"token": tok, "user": pub(row)}
    if not user: raise Err(401, "auth")
    if r == "me": return pub(user)
    if r == "logout": db().execute("DELETE FROM sessions WHERE user_id=?", (user["id"],)); db().commit(); return {"ok": 1}
    if r == "password" and method == "POST":
        new = s(body.get("new"), 200)
        if len(new) < 8: raise Err(400, "pw_short")
        if not hmac.compare_digest(hash_pw(s(body.get("old"), 200), user["salt"]), user["hash"]): raise Err(400, "pw_wrong")
        salt = secrets.token_hex(16)
        db().execute("UPDATE users SET salt=?,hash=?,must_change=0 WHERE id=?", (salt, hash_pw(new, salt), user["id"])); db().commit()
        log(user["username"], "password_changed", "", ip); return {"ok": 1}
    if user["must_change"]: raise Err(403, "must_change")
    if r == "dashboard":
        c = db().execute
        by = {x["status"]: x["n"] for x in c("SELECT status,COUNT(*) n FROM persons WHERE archived=0 GROUP BY status")}
        today = time.strftime("%Y-%m-%d"); week = time.strftime("%Y-%m-%d", time.localtime(time.time() + 7 * 86400))
        hear = [dict(x) for x in c("SELECT c.id,c.fir_no,c.next_hearing,c.court,p.id pid,p.name FROM cases c JOIN persons p ON p.id=c.person_id WHERE c.archived=0 AND p.archived=0 AND c.next_hearing BETWEEN ? AND ? ORDER BY c.next_hearing LIMIT 10", (today, week))]
        rec = [dict(x) for x in c("SELECT id,name,status,cnic,has_photo FROM persons WHERE archived=0 ORDER BY id DESC LIMIT 6")]
        return {"by_status": by, "total": sum(by.values()), "cases": c("SELECT COUNT(*) FROM cases WHERE archived=0").fetchone()[0], "hearings": hear, "recent": rec}
    if r == "persons":
        if len(parts) == 1 and method == "GET":
            qs, st = s(q.get("q", [""])[0], 80), s(q.get("status", [""])[0], 30)
            sql, a = "SELECT id,name,father_name,cnic,status,has_photo FROM persons WHERE archived=0", []
            if st in PERSON_STATUS: sql += " AND status=?"; a.append(st)
            if qs:
                like = f"%{qs}%"; dig = re.sub(r"\D", "", qs)
                sql += " AND (name LIKE ? OR alias LIKE ? OR father_name LIKE ? OR (?<>'' AND cnic LIKE ?) OR id IN (SELECT person_id FROM cases WHERE fir_no LIKE ? OR sections LIKE ?))"
                a += [like, like, like, dig, f"%{dig}%", like, like]
                log(user["username"], "search", qs, ip)
            return [dict(x) for x in db().execute(sql + " ORDER BY id DESC LIMIT 200", a)]
        if len(parts) == 1 and method == "POST":
            need(user, "admin", "officer"); p = clean_person(body); now = int(time.time())
            cur = db().execute(f"INSERT INTO persons({','.join(PERSON_F)},created_by,created_at,updated_at) VALUES({','.join('?'*len(PERSON_F))},?,?,?)",
                               [p[k] for k in PERSON_F] + [user["username"], now, now])
            pid = cur.lastrowid
            if body.get("photo"): save_photo(pid, body["photo"]); db().execute("UPDATE persons SET has_photo=1 WHERE id=?", (pid,))
            db().commit(); log(user["username"], "person_create", pid, ip); return {"id": pid}
        pid = int(parts[1]); row = db().execute("SELECT * FROM persons WHERE id=? AND archived=0", (pid,)).fetchone()
        if not row: raise Err(404, "not_found")
        if method == "GET":
            log(user["username"], "person_view", pid, ip)
            d = dict(row); d["cases"] = [dict(x) for x in db().execute("SELECT * FROM cases WHERE person_id=? AND archived=0 ORDER BY id DESC", (pid,))]
            return d
        need(user, "admin", "officer")
        if method == "PUT":
            p = clean_person(body)
            db().execute(f"UPDATE persons SET {','.join(k+'=?' for k in PERSON_F)},updated_at=? WHERE id=?", [p[k] for k in PERSON_F] + [int(time.time()), pid])
            if body.get("photo"): save_photo(pid, body["photo"]); db().execute("UPDATE persons SET has_photo=1 WHERE id=?", (pid,))
            db().commit(); log(user["username"], "person_update", pid, ip); return {"ok": 1}
        if method == "DELETE":
            db().execute("UPDATE persons SET archived=1,updated_at=? WHERE id=?", (int(time.time()), pid)); db().commit()
            log(user["username"], "person_archive", pid, ip); return {"ok": 1}
    if r == "persons" and len(parts) == 3 and parts[2] == "cases" and method == "POST":
        need(user, "admin", "officer"); c = clean_case(body); now = int(time.time())
        cur = db().execute(f"INSERT INTO cases(person_id,{','.join(CASE_F)},created_by,created_at,updated_at) VALUES(?,{','.join('?'*len(CASE_F))},?,?,?)",
                           [int(parts[1])] + [c[k] for k in CASE_F] + [user["username"], now, now]); db().commit()
        log(user["username"], "case_create", cur.lastrowid, ip); return {"id": cur.lastrowid}
    if r == "cases" and len(parts) == 2:
        need(user, "admin", "officer"); cid = int(parts[1])
        if method == "PUT":
            c = clean_case(body)
            db().execute(f"UPDATE cases SET {','.join(k+'=?' for k in CASE_F)},updated_at=? WHERE id=?", [c[k] for k in CASE_F] + [int(time.time()), cid]); db().commit()
            log(user["username"], "case_update", cid, ip); return {"ok": 1}
        if method == "DELETE":
            db().execute("UPDATE cases SET archived=1 WHERE id=?", (cid,)); db().commit(); log(user["username"], "case_archive", cid, ip); return {"ok": 1}
    if r == "users":
        need(user, "admin")
        if len(parts) == 1 and method == "GET": return [pub(x) | {"active": x["active"]} for x in db().execute("SELECT * FROM users ORDER BY id")]
        if len(parts) == 1 and method == "POST":
            un, pw = s(body.get("username"), 60).lower(), s(body.get("password"), 200)
            if not re.fullmatch(r"[a-z0-9_.-]{3,30}", un) or len(pw) < 8 or body.get("role") not in ROLES or not s(body.get("name")): raise Err(400, "user_invalid")
            try: add_user(un, s(body.get("name"), 80), body["role"], pw, must_change=1)
            except sqlite3.IntegrityError: raise Err(409, "user_exists")
            log(user["username"], "user_create", un, ip); return {"ok": 1}
        if len(parts) == 2 and method == "PUT":
            uid = int(parts[1])
            if uid == user["id"]: raise Err(400, "self_edit")
            if body.get("role") in ROLES: db().execute("UPDATE users SET role=? WHERE id=?", (body["role"], uid))
            if "active" in body: db().execute("UPDATE users SET active=? WHERE id=?", (1 if body["active"] else 0, uid)); db().execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            if s(body.get("password"), 200):
                if len(body["password"]) < 8: raise Err(400, "pw_short")
                salt = secrets.token_hex(16); db().execute("UPDATE users SET salt=?,hash=?,must_change=1 WHERE id=?", (salt, hash_pw(body["password"], salt), uid))
            db().commit(); log(user["username"], "user_update", uid, ip); return {"ok": 1}
    if r == "audit" and method == "GET":
        need(user, "admin"); return [dict(x) for x in db().execute("SELECT * FROM audit ORDER BY id DESC LIMIT 300")]
    raise Err(404, "not_found")

def pub(u): return {"id": u["id"], "username": u["username"], "name": u["name"], "role": u["role"], "must_change": u["must_change"]}

# ---------------- HTTP ----------------
class H(BaseHTTPRequestHandler):
    server_version = "FRS"
    def log_message(self, *a): pass
    def ip(self): return self.client_address[0]
    def send(self, code, data, ctype="application/json", extra=None):
        b = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text") or ctype == "application/json" else ""))
        self.send_header("Content-Length", str(len(b))); self.send_header("X-Content-Type-Options", "nosniff"); self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def user(self):
        t = (self.headers.get("Authorization") or "")[7:]
        row = db().execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1", (t, int(time.time()))).fetchone() if t else None
        return row
    def handle_any(self, method):
        u = urlparse(self.path)
        try:
            if u.path.startswith("/api/"):
                body = {}
                n = int(self.headers.get("Content-Length") or 0)
                if n > 6_000_000: raise Err(413, "too_large")
                if n: body = json.loads(self.rfile.read(n) or b"{}")
                user = self.user()
                m = re.fullmatch(r"/api/photo/(\d+)", u.path)
                if m and method == "GET":
                    if not user: raise Err(401, "auth")
                    fp = os.path.join(PHOTOS, f"{int(m.group(1))}.jpg")
                    if not os.path.exists(fp): raise Err(404, "not_found")
                    return self.send(200, open(fp, "rb").read(), "image/jpeg", {"Cache-Control": "private, max-age=300"})
                return self.send(200, api(method, u.path, parse_qs(u.query), body, user, self.ip()), extra={"Cache-Control": "no-store"})
            if method != "GET": raise Err(405, "method")
            rel = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
            fp = os.path.realpath(os.path.join(WEB, rel))
            if not fp.startswith(os.path.realpath(WEB) + os.sep) or not os.path.isfile(fp): raise Err(404, "not_found")
            ct = mimetypes.guess_type(fp)[0] or "application/octet-stream"
            if fp.endswith(".woff"): ct = "font/woff"
            self.send(200, open(fp, "rb").read(), ct, {"Cache-Control": "public, max-age=86400" if "/fonts/" in fp else "no-cache"})
        except Err as e: self.send(e.code, {"error": e.msg})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError): self.send(400, {"error": "bad_request"})
        except Exception as e: print("ERR", e, file=sys.stderr); self.send(500, {"error": "server"})
    def do_GET(self): self.handle_any("GET")
    def do_POST(self): self.handle_any("POST")
    def do_PUT(self): self.handle_any("PUT")
    def do_DELETE(self): self.handle_any("DELETE")

if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True); init()
    print(f"FR System running:  http://localhost:{PORT}   (other devices: http://<this-PC-IP>:{PORT})")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
