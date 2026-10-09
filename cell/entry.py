"""Shell:B Guest cell entry point: runs inside a guest's container (server/cells.py starts it).

The container has no network. Shell:B's code reaches its model services at fixed local addresses (localhost:11434
for Ollama, :8001 HERMES, :8188 ComfyUI ...), so this forwards each of those ports to the host broker's socket for
that service (/run/shellb/<name>.sock), which decides what may pass. Then it runs Shell:B itself in cell mode on
/run/web/web.sock, the socket the guest gateway (guest_app.py) proxies the guest's browser to.

SHELLB_CELL_FORWARD lists the ports: "11434:ollama,8001:hermes,...".
"""
import asyncio
import os
import sys

SOCKS = "/run/shellb"
WEB_SOCK = "/run/web/web.sock"
CHUNK = 64 * 1024


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        while data := await reader.read(CHUNK):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def _forward(name: str, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        up_reader, up_writer = await asyncio.open_unix_connection(f"{SOCKS}/{name}.sock")
    except OSError:
        writer.close()
        return
    await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))


async def main():
    os.umask(0o077)
    for item in filter(None, os.environ.get("SHELLB_CELL_FORWARD", "").split(",")):
        port, name = item.split(":", 1)
        for host in ("127.0.0.1", "::1"):  # "localhost" may resolve to either
            try:
                await asyncio.start_server(lambda r, w, n=name: _forward(n, r, w), host, int(port))
            except OSError as e:
                if host == "127.0.0.1":
                    print(f"cell: can't forward {host}:{port}: {e}", file=sys.stderr, flush=True)

    sys.path.insert(0, "/app/server")
    os.chdir("/app/server")
    import uvicorn
    config = uvicorn.Config("app:app", uds=WEB_SOCK, lifespan="on", log_level="warning", proxy_headers=False,
                            timeout_graceful_shutdown=5)
    await uvicorn.Server(config).serve()


if __name__ == "__main__":
    asyncio.run(main())
