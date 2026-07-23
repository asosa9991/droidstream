#!/usr/bin/env python3
"""POST a JSON body -> displays it in the json-deeplink-viewer app on a
DroidStream session -> responds with a PNG screenshot of the result.

Bridges DroidStream's ephemeral, pooled sessions (created via the control
plane's own /api/sessions API) to the same adb-deeplink pattern used for
Cuttlefish and the local headless emulator. Reuses an existing ready
session if one exists; otherwise creates one and waits for it to boot.
The APK is installed once per (ephemeral) session -- a fresh redroid
container never has it pre-baked in.

Needs `adb` and the `docker` CLI (for `docker port` -- the control plane's
public API intentionally does not expose a session's internal adb port;
see gcp/README.md). Pillow is needed only for `?full=1` (filmstrip mode);
plain single-shot `/api/json` works with stdlib alone.
"""
import io
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    from PIL import Image, ImageChops
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False

ADB = os.environ.get("ADB", "adb")
APK_PATH = os.environ.get("APK_PATH", "/app/assets/app-debug.apk")
COMPONENT = os.environ.get("JSON_VIEWER_COMPONENT", "com.cuttlefish.jsonviewer/.MainActivity")
DEEPLINK = os.environ.get("JSON_VIEWER_DEEPLINK", "jsonviewer://open")
CONTROL_PLANE = os.environ.get("CONTROL_PLANE_URL", "http://127.0.0.1:8080")
PORT = int(os.environ.get("PORT", "8600"))
MAX_JSON_BYTES = int(os.environ.get("MAX_JSON_BYTES", str(8 * 1024 * 1024)))
RENDER_WAIT_SEC = float(os.environ.get("RENDER_WAIT_SEC", "1.2"))
SESSION_WAIT_TIMEOUT_SEC = float(os.environ.get("SESSION_WAIT_TIMEOUT_SEC", "45"))
SCROLL_SETTLE_SEC = float(os.environ.get("SCROLL_SETTLE_SEC", "0.35"))
MAX_SCROLLS = int(os.environ.get("MAX_SCROLLS", "25"))
FILMSTRIP_GUTTER = int(os.environ.get("FILMSTRIP_GUTTER", "8"))
FILMSTRIP_COLS = int(os.environ.get("FILMSTRIP_COLS", "3"))

# Tracks which ephemeral sessions already have the APK installed, so a
# reused session doesn't reinstall on every request. Cleared implicitly
# when a session id stops being returned by the control plane (nothing to
# do -- the set just grows unboundedly slowly; sessions are hex ids, this
# process restarts on redeploy anyway).
_installed = set()


def cp_get(path, timeout=10):
    with urllib.request.urlopen(CONTROL_PLANE + path, timeout=timeout) as r:
        return json.load(r)


def cp_post(path, body=None, timeout=15):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        CONTROL_PLANE + path, data=data,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def find_or_create_session():
    sessions = cp_get("/api/sessions")["sessions"]
    for s in sessions:
        if s["state"] == "ready":
            return s["id"]
    starting = [s["id"] for s in sessions if s["state"] == "starting"]
    session_id = starting[0] if starting else cp_post("/api/sessions", {})["id"]

    deadline = time.time() + SESSION_WAIT_TIMEOUT_SEC
    while time.time() < deadline:
        st = cp_get(f"/api/sessions/{session_id}")
        if st.get("state") == "ready":
            return session_id
        if st.get("state") in ("failed", "error"):
            raise RuntimeError(f"session {session_id} failed: {st.get('error')}")
        time.sleep(2)
    raise RuntimeError(f"session {session_id} did not become ready within {SESSION_WAIT_TIMEOUT_SEC}s")


def adb_serial_for(session_id):
    name = f"droidstream-{session_id}"
    r = subprocess.run(["docker", "port", name, "5555/tcp"], capture_output=True, text=True, timeout=10)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"could not resolve adb port for {name}: {r.stderr.strip() or 'no output'}")
    return r.stdout.strip().splitlines()[0]  # "127.0.0.1:NNNNN"


def adb(*args, serial, timeout=30):
    return subprocess.run([ADB, "-s", serial, *args], capture_output=True, text=True, timeout=timeout)


def ensure_device_ready(session_id, serial):
    subprocess.run([ADB, "connect", serial], capture_output=True, text=True, timeout=15)
    if session_id in _installed:
        return
    r = adb("install", "-r", APK_PATH, serial=serial, timeout=60)
    if r.returncode != 0 or "Success" not in (r.stdout + r.stderr):
        raise RuntimeError(f"apk install failed: {(r.stderr or r.stdout).strip()}")
    _installed.add(session_id)


def show_json_on_device(serial, json_text, theme=None):
    # Same POSIX-single-quote escaping as the Cuttlefish/local sidecars --
    # `adb shell` re-parses its argument through a shell on-device, so a
    # JSON payload full of double quotes gets torn apart otherwise.
    escaped = "'" + json_text.replace("'", "'\\''") + "'"
    theme_extra = " --es theme '%s'" % theme if theme else ""
    remote_cmd = "am start -W -a android.intent.action.VIEW -d '%s' --es json %s%s %s" % (
        DEEPLINK, escaped, theme_extra, COMPONENT
    )
    return adb("shell", remote_cmd, serial=serial, timeout=30)


def screenshot_png(serial):
    r = subprocess.run([ADB, "-s", serial, "exec-out", "screencap", "-p"],
                       capture_output=True, timeout=30)
    return r.stdout if r.returncode == 0 else None


def screen_size(serial):
    r = adb("shell", "wm size", serial=serial, timeout=10)
    m = re.search(r"(\d+)x(\d+)", r.stdout)
    if not m:
        raise RuntimeError("could not parse `wm size` output: %r" % r.stdout)
    return int(m.group(1)), int(m.group(2))


def swipe_scroll(serial, width, height):
    x = width // 2
    y_start, y_end = int(height * 0.85), int(height * 0.20)
    adb("shell", "input swipe %d %d %d %d 400" % (x, y_start, x, y_end), serial=serial, timeout=10)
    time.sleep(SCROLL_SETTLE_SEC)


def scroll_to_top(serial, width, height):
    # Best-effort: the app resets its own scroll position on every fresh
    # payload, but this guards against any other stale scroll state.
    x = width // 2
    for _ in range(4):
        adb("shell", "input swipe %d %d %d %d 400" % (x, int(height * 0.20), x, int(height * 0.85)),
            serial=serial, timeout=10)
        time.sleep(SCROLL_SETTLE_SEC)


def capture_filmstrip_png(serial, theme=None):
    """Scrolls through the page, capturing one full screenshot per position,
    and lays them out in a grid (FILMSTRIP_COLS per row) rather than trying
    to reconstruct a single seamless page. Much simpler than stitching: no
    overlap/alignment math needed, just "does scrolling still change
    anything" to know when to stop."""
    width, height = screen_size(serial)
    scroll_to_top(serial, width, height)

    def shot():
        return Image.open(io.BytesIO(screenshot_png(serial))).convert("RGB")

    frames = [shot()]
    for _ in range(MAX_SCROLLS):
        swipe_scroll(serial, width, height)
        cur = shot()
        if ImageChops.difference(frames[-1], cur).getbbox() is None:
            break  # nothing changed -> reached the bottom
        frames.append(cur)

    # All frames share one device resolution, so a uniform grid is exact --
    # no per-cell size handling needed.
    cols = min(FILMSTRIP_COLS, len(frames))
    rows = -(-len(frames) // cols)  # ceil
    w, h = frames[0].size
    total_w = cols * w + FILMSTRIP_GUTTER * (cols - 1)
    total_h = rows * h + FILMSTRIP_GUTTER * (rows - 1)
    gutter_color = (244, 245, 240) if theme == "light" else (12, 12, 16)  # matches the app's bg per theme
    filmstrip = Image.new("RGB", (total_w, total_h), gutter_color)
    for i, f in enumerate(frames):
        col, row = i % cols, i // cols
        filmstrip.paste(f, (col * (w + FILMSTRIP_GUTTER), row * (h + FILMSTRIP_GUTTER)))

    buf = io.BytesIO()
    filmstrip.save(buf, format="PNG")
    return buf.getvalue(), len(frames)


class Handler(BaseHTTPRequestHandler):
    server_version = "droidstream-json-bridge/1.0"

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            try:
                health = cp_get("/api/health", timeout=5)
                self._json(200, {"ok": True, "control_plane": health})
            except Exception as e:
                self._json(200, {"ok": False, "error": str(e)})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        parsed_url = urlparse(self.path)
        if parsed_url.path != "/api/json":
            return self._json(404, {"error": "not found"})
        query = parse_qs(parsed_url.query)
        filmstrip = query.get("full", ["0"])[0] not in ("0", "", "false")
        if filmstrip and not HAVE_PIL:
            return self._json(501, {"error": "filmstrip mode needs Pillow in the json-bridge image"})
        theme = query.get("theme", [None])[0]
        if theme not in (None, "light", "dark"):
            return self._json(400, {"error": "theme must be 'light' or 'dark' if given"})

        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return self._json(400, {"error": "empty body"})
        if length > MAX_JSON_BYTES:
            return self._json(413, {"error": "payload too large (max %d bytes)" % MAX_JSON_BYTES})

        raw = self.rfile.read(length)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return self._json(400, {"error": "body is not valid UTF-8"})
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as e:
            return self._json(400, {"error": "invalid JSON: %s" % str(e)})

        normalized = json.dumps(parsed)  # ensure_ascii=True -> safe for shell transport

        try:
            session_id = find_or_create_session()
            serial = adb_serial_for(session_id)
            ensure_device_ready(session_id, serial)
            r = show_json_on_device(serial, normalized, theme=theme)
            output = (r.stdout + r.stderr).strip()
            if r.returncode != 0 or "Error:" in output:
                return self._json(500, {"error": output or "am start failed", "session": session_id})

            time.sleep(RENDER_WAIT_SEC)
            frame_count = None
            if filmstrip:
                png, frame_count = capture_filmstrip_png(serial, theme=theme)
            else:
                png = screenshot_png(serial)
            if not png:
                return self._json(500, {"error": "screenshot failed", "session": session_id})
        except urllib.error.URLError as e:
            return self._json(502, {"error": "control plane unreachable: %s" % e})
        except Exception as e:
            return self._json(500, {"error": str(e)})

        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(png)))
        self.send_header("X-Json-Bytes", str(len(normalized)))
        self.send_header("X-Session-Id", session_id)
        if frame_count is not None:
            self.send_header("X-Filmstrip-Frames", str(frame_count))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(png)

    def log_message(self, fmt, *args):
        print("[json-bridge] " + fmt % args, flush=True)


if __name__ == "__main__":
    print("[json-bridge] listening on :%d, control plane %s" % (PORT, CONTROL_PLANE), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
