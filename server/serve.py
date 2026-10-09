"""Start Shell:B Web on chosen addresses only (uvicorn's --host takes a single address).

SHELLB_HOSTS is a comma-separated list, default 127.0.0.1. Nothing on it should be reachable from the LAN: browsers
come in over HTTPS (`tailscale serve` and the Cloudflare tunnel both proxy to it). An address that doesn't exist yet,
such as a Docker bridge gateway while dockerd is still starting, is retried for BIND_WAIT seconds and then skipped.

Shell:B Guest (guests.py) listens on the same addresses (or SHELLB_GUEST_HOSTS) at SHELLB_GUEST_PORT, default 8220;
0 turns it off. guest_app.root sends connections on that port to the guest app and everything else to app.app.
"""
import os
import socket
import sys
import time

import uvicorn

PORT = int(os.environ.get("SHELLB_PORT", "8200"))
HOSTS = [h.strip() for h in os.environ.get("SHELLB_HOSTS", "127.0.0.1").split(",") if h.strip()]
GUEST_PORT = int(os.environ.get("SHELLB_GUEST_PORT", "8220"))
GUEST_HOSTS = [h.strip() for h in os.environ.get("SHELLB_GUEST_HOSTS", ",".join(HOSTS)).split(",") if h.strip()]
BIND_WAIT = 60


def bind(host: str, port: int = PORT) -> socket.socket | None:
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
    deadline = time.time() + BIND_WAIT
    while True:
        s = socket.socket(fam, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            s.listen(2048)
            s.set_inheritable(True)
            return s
        except OSError as e:
            s.close()
            if time.time() > deadline or e.errno != 99:  # 99 = EADDRNOTAVAIL: the interface isn't up yet
                print(f"serve: skipping {host}:{port}: {e}", file=sys.stderr, flush=True)
                return None
            time.sleep(2)


def main():
    socks = [s for s in (bind(h) for h in HOSTS) if s]
    if not socks:
        sys.exit(f"serve: could not listen on any of {HOSTS}")
    guest = [s for s in (bind(h, GUEST_PORT) for h in GUEST_HOSTS) if s] if GUEST_PORT else []
    print("serve: listening on " + ", ".join(f"{s.getsockname()[0]}:{s.getsockname()[1]}" for s in socks + guest), flush=True)
    os.environ["SHELLB_GUEST_PORT"] = str(GUEST_PORT)  # guest_app.root routes by it
    uvicorn.Server(uvicorn.Config("guest_app:root", timeout_graceful_shutdown=5)).run(sockets=socks + guest)


if __name__ == "__main__":
    main()
