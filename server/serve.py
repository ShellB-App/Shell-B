"""Start Shell:B Web on chosen addresses only (uvicorn's --host takes a single address).

SHELLB_HOSTS is a comma-separated list, default 127.0.0.1. Nothing on it should be reachable from the LAN: browsers
come in over HTTPS (`tailscale serve` and the Cloudflare tunnel both proxy to it). An address that doesn't exist yet,
such as a Docker bridge gateway while dockerd is still starting, is retried for BIND_WAIT seconds and then skipped.
"""
import os
import socket
import sys
import time

import uvicorn

PORT = int(os.environ.get("SHELLB_PORT", "8200"))
HOSTS = [h.strip() for h in os.environ.get("SHELLB_HOSTS", "127.0.0.1").split(",") if h.strip()]
BIND_WAIT = 60


def bind(host: str) -> socket.socket | None:
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
    deadline = time.time() + BIND_WAIT
    while True:
        s = socket.socket(fam, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, PORT))
            s.listen(2048)
            s.set_inheritable(True)
            return s
        except OSError as e:
            s.close()
            if time.time() > deadline or e.errno != 99:  # 99 = EADDRNOTAVAIL: the interface isn't up yet
                print(f"serve: skipping {host}:{PORT}: {e}", file=sys.stderr, flush=True)
                return None
            time.sleep(2)


def main():
    socks = [s for s in (bind(h) for h in HOSTS) if s]
    if not socks:
        sys.exit(f"serve: could not listen on any of {HOSTS}")
    print("serve: listening on " + ", ".join(f"{s.getsockname()[0]}:{PORT}" for s in socks), flush=True)
    uvicorn.Server(uvicorn.Config("app:app", timeout_graceful_shutdown=5)).run(sockets=socks)


if __name__ == "__main__":
    main()
