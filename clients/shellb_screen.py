#!/usr/bin/env python3
"""Shell:B Screen helper: lets Shell:B look at this computer's screen when an agent asks to, without a browser tab.

Run it on your own computer while you want Shell:B to be able to see your screen; stop it (Ctrl+C) and she can't.
It captures only when an agent calls look_at_screen and prints a line each time. Nothing is sent otherwise.

  pip install mss          (Pillow too, for smaller JPEG frames: pip install mss pillow)
  python shellb_screen.py

Settings → Screen → "Pair a computer" downloads a copy with the address and the device token filled in. Otherwise
pass --url https://<device>.<tailnet>.ts.net:8443 --token sbs_...  Unpairing it in Settings revokes the token.
The address must be one this computer can reach directly, e.g. the Tailscale HTTPS one; addresses behind Cloudflare
Access need a browser login and won't work here.
"""
import argparse
import io
import json
import platform
import socket
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = ""
DEFAULT_TOKEN = ""
DEFAULT_NAME = ""


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


try:
    import mss
    import mss.tools
except ImportError:
    die("This helper needs the mss package:  pip install mss pillow")
try:
    from PIL import Image
except ImportError:
    Image = None


class Client:
    def __init__(self, url, token):
        self.url, self.token = url.rstrip("/"), token

    def call(self, method, path, body=None, data=None, ctype="application/json", timeout=30, headers=None):
        h = {"x-shellb-screen": self.token, "user-agent": "shellb-screen/1"}
        h.update(headers or {})
        if body is not None:
            data = json.dumps(body).encode()
        if data is not None:
            h["content-type"] = ctype
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"null")


def monitors(sct):
    return [{"w": m["width"], "h": m["height"]} for m in sct.monitors[1:]]


def grab(sct, monitor, max_edge):
    mons = sct.monitors  # [0] = every monitor together, [1] = primary, ...
    n = 1 if monitor is None else max(0, min(int(monitor), len(mons) - 1))
    shot = sct.grab(mons[n])
    if Image is None:
        return mss.tools.to_png(shot.rgb, shot.size), "image/png", n, shot.size
    im = Image.frombytes("RGB", shot.size, shot.rgb)
    if max(im.size) > max_edge:
        k = max_edge / max(im.size)
        im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return buf.getvalue(), "image/jpeg", n, shot.size


def main():
    ap = argparse.ArgumentParser(description="Let Shell:B look at this screen when an agent asks.")
    ap.add_argument("--url", default=DEFAULT_URL, help="Shell:B's HTTPS address")
    ap.add_argument("--token", default=DEFAULT_TOKEN, help="device token from Settings → Screen")
    ap.add_argument("--name", default=DEFAULT_NAME or socket.gethostname(), help="name shown in Shell:B")
    a = ap.parse_args()
    if not a.url or not a.token:
        die("Give --url and --token, or download a paired copy from Shell:B: Settings → Screen → Pair a computer.")
    if not a.url.startswith("https://") and "://localhost" not in a.url and "://127.0.0.1" not in a.url:
        die("Use Shell:B's HTTPS address: screenshots shouldn't cross the network unencrypted.")
    c = Client(a.url, a.token)
    with mss.mss() as sct:
        sid, backoff = None, 2
        while True:
            try:
                if not sid:
                    sid = c.call("POST", "/api/screen/connect", {
                        "name": a.name, "label": f"{platform.system()} desktop", "monitors": monitors(sct)})["id"]
                    print(f"Connected to {a.url} as {a.name!r} ({len(sct.monitors) - 1} monitor(s)). "
                          "Shell:B can look at this screen until you stop this (Ctrl+C).", flush=True)
                    backoff = 2
                r = c.call("GET", f"/api/screen/next?id={sid}", timeout=60)["request"]
                if not r:
                    continue
                try:
                    data, ctype, n, size = grab(sct, r.get("monitor"), int(r.get("maxEdge") or 2560))
                    c.call("POST", f"/api/screen/frame/{r['rid']}?id={sid}", data=data, ctype=ctype, timeout=60)
                    which = "all monitors" if n == 0 else f"monitor {n}"
                    print(f"{time.strftime('%H:%M:%S')}  Shell:B looked at your screen ({which}, {size[0]}x{size[1]})", flush=True)
                except Exception as e:
                    print(f"{time.strftime('%H:%M:%S')}  capture failed: {e}", flush=True)
                    try:
                        c.call("POST", f"/api/screen/frame/{r['rid']}?id={sid}", data=b"",
                               headers={"x-screen-error": f"capture failed: {e}"[:200]})
                    except Exception:
                        pass
            except KeyboardInterrupt:
                if sid:
                    try:
                        c.call("POST", f"/api/screen/disconnect?id={sid}", data=b"", timeout=5)
                    except Exception:
                        pass
                raise
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    die("Shell:B doesn't recognise this helper any more (it was unpaired). Pair it again in Settings → Screen.")
                if e.code == 404:  # Shell:B restarted and forgot this source: connect again
                    sid = None
                    continue
                print(f"Shell:B answered {e.code}; retrying in {backoff} s", flush=True)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                print(f"Can't reach Shell:B ({getattr(e, 'reason', e)}); retrying in {backoff} s", flush=True)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
                sid = None


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped. Shell:B can no longer see this screen.")
