"""Shell:B Guest cell data archive: runs in a throwaway container from the cell image, as the cell's own uid, with only
the cell's data folder mounted at /c (server/cells.py export_data and import_data, for server/backup.py). The owner's
process can't read that folder (it belongs to the cell's uid), and the cell itself has no backups (cell mode leaves
them out), so this is how a cell's data gets into the owner's archives and back.

    datatar.py export '<json>'   writes a tar of /c to stdout. shellb.db goes through SQLite's online backup, so a
                                 running cell's database is consistent. Sockets, pipes and devices are left out, and so
                                 are the names in "exclude" (anywhere) and the paths in "secret".
    datatar.py import '<json>'   replaces everything in /c with the tar on stdin, keeping the "keep" paths this machine
                                 has when the tar doesn't carry them (the Codex key, like the owner's own restore).

A path that can't be read is reported on stderr as "skip: <path>: <reason>" and never stops the archive.
"""
import io
import json
import os
import shutil
import sqlite3
import stat
import sys
import tarfile

ROOT = "/c"
IN_MEMORY = 256 * 2**20  # files up to this size are read whole first, so one changing mid-read can't break the stream


def skip(rel: str, err) -> None:
    print(f"skip: {rel}: {err}", file=sys.stderr, flush=True)


def export(opts: dict) -> None:
    exclude, secret = set(opts.get("exclude", [])), set(opts.get("secret", []))
    tar = tarfile.open(fileobj=sys.stdout.buffer, mode="w|")

    def add(rel: str):
        p = os.path.join(ROOT, rel)
        st = os.lstat(p)
        if stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
            tar.add(p, arcname=rel, recursive=False)
            return stat.S_ISDIR(st.st_mode)
        if not stat.S_ISREG(st.st_mode):
            return False  # a socket, pipe or device: nothing to keep
        with open(p, "rb") as f:
            info = tar.gettarinfo(arcname=rel, fileobj=f)
            if info.size <= IN_MEMORY:
                data = f.read()
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            else:
                tar.addfile(info, f)
        return False

    def walk(rel: str):
        try:
            names = sorted(os.listdir(os.path.join(ROOT, rel)))
        except OSError as e:
            skip(rel or ".", e)
            return
        for n in names:
            r = f"{rel}/{n}" if rel else n
            if n in exclude or r in secret or r == "shellb.db":
                continue
            try:
                if add(r):
                    walk(r)
            except OSError as e:
                skip(r, e)

    walk("")
    db = os.path.join(ROOT, "shellb.db")
    if os.path.isfile(db):
        try:
            src, dst = sqlite3.connect(db), sqlite3.connect("/tmp/shellb.db")
            src.backup(dst)
            src.close()
            dst.close()
            tar.add("/tmp/shellb.db", arcname="shellb.db")
        except (OSError, sqlite3.Error) as e:
            skip("shellb.db", e)
    tar.close()


def import_(opts: dict) -> None:
    kept = {r: open(os.path.join(ROOT, r), "rb").read() for r in opts.get("keep", []) if os.path.isfile(os.path.join(ROOT, r))}
    for n in os.listdir(ROOT):
        p = os.path.join(ROOT, n)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.unlink(p)
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as tar:
        tar.extractall(ROOT, filter="data")
    for r, data in kept.items():
        p = os.path.join(ROOT, r)
        if not os.path.exists(p):
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)
            os.chmod(p, 0o600)


if __name__ == "__main__":
    cmd, opts = sys.argv[1], json.loads(sys.argv[2] if len(sys.argv) > 2 else "{}")
    {"export": export, "import": import_}[cmd](opts)
