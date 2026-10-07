"""Backup and restore subsystem for Shell:B Web.

Safely archives and restores:
1. SQLite database (shellb.db) via SQLite online backup API (100% consistent snapshot).
2. Filesystem data (workspaces, assets, codex, projects, skills, groups, etc.).

Features:
- Dual scope: 'full' (all data) or 'core' (database + metadata/configs + codex + skills + projects, omitting heavy media).
- Automatic pre-restore safety snapshot so disaster recovery is always reversible.
- Background automated daily backups with retention policy (7 daily, 4 weekly).
- CLI commands for standalone disaster recovery from the terminal.
- REST API endpoints for UI integration.
"""
import argparse
import asyncio
import datetime
import json
import os
import re
import shutil
import sqlite3
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

import auth
import db

router = APIRouter(prefix="/api/backup")

BACKUP_DIR = db.DATA / "backups"
BACKUP_DIR.mkdir(parents=True, exist_ok=True)
INDEX_FILE = BACKUP_DIR / "manifests.json"

# Directories under db.DATA to include
CORE_DIRS = [
    "projects", "project-meta", "codex", "skills", "groups",
    "research", "sky", "files", "selfmod", "cells", "cli-home", "ssh", "worlds", "notify"
]
MEDIA_DIRS = ["workspaces", "assets", "asset-thumbs"]
ALL_DATA_DIRS = CORE_DIRS + MEDIA_DIRS

INDIVIDUAL_FILES = ["admin.key", "datasets.json"]

EXCLUDE_PATTERNS = {
    "backups", "asset-tmp", "doc-cache", "mcp-logs", ".restore_staging",
    "__pycache__", ".git", "shellb.db-wal", "shellb.db-shm", ".lock"
}


def _now_ts() -> float:
    return time.time()


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _fmt_bytes(num_bytes: int) -> str:
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if num_bytes < 1024.0:
            return f"{num_bytes:.1f} {unit}" if unit != "B" else f"{num_bytes} B"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} PB"


# ── SQLite safe dump ─────────────────────────────────────────────────────────

def dump_db_safely(dest_path: Path) -> dict:
    """Uses SQLite online backup API to copy the database atomically."""
    with db.conn() as src:
        dest_conn = sqlite3.connect(dest_path)
        src.backup(dest_conn)
        dest_conn.close()

    # Verify integrity and gather table stats
    chk = sqlite3.connect(dest_path)
    cur = chk.cursor()
    cur.execute("PRAGMA integrity_check;")
    result = cur.fetchall()
    if not result or result[0][0] != "ok":
        chk.close()
        raise RuntimeError(f"Database integrity check failed: {result}")

    stats = {}
    for table in ["conversations", "messages", "memories", "artifacts", "projects", "codex_entries", "groups", "skills"]:
        try:
            cur.execute(f"SELECT count(*) FROM {table}")
            stats[table] = cur.fetchone()[0]
        except Exception:
            pass
    chk.close()
    return stats


# ── Manifest index ──────────────────────────────────────────────────────────

def _load_index() -> list[dict]:
    if not INDEX_FILE.exists():
        return _rebuild_index()
    try:
        data = json.loads(INDEX_FILE.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return _rebuild_index()


def _save_index(items: list[dict]):
    try:
        INDEX_FILE.write_text(json.dumps(items, indent=1))
    except Exception:
        pass


def _rebuild_index() -> list[dict]:
    items = []
    for archive in sorted(BACKUP_DIR.glob("shellb-backup-*.tar.gz"), reverse=True):
        m = inspect_archive(archive)
        if m:
            items.append(m)
    _save_index(items)
    return items


def inspect_archive(archive_path: Path) -> dict | None:
    if not archive_path.exists():
        return None
    try:
        with tarfile.open(archive_path, "r:gz") as tar:
            try:
                member = tar.getmember("manifest.json")
                f = tar.extractfile(member)
                if f:
                    manifest = json.loads(f.read().decode())
                    manifest["sizeBytes"] = archive_path.stat().st_size
                    manifest["sizeFormatted"] = _fmt_bytes(manifest["sizeBytes"])
                    manifest["filename"] = archive_path.name
                    return manifest
            except KeyError:
                pass
            # Fallback if no manifest.json inside
            st = archive_path.stat()
            return {
                "id": archive_path.stem.replace(".tar", ""),
                "filename": archive_path.name,
                "scope": "unknown",
                "source": "manual",
                "note": "Legacy or external backup",
                "createdAt": st.st_mtime,
                "createdAtIso": datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc).isoformat(),
                "sizeBytes": st.st_size,
                "sizeFormatted": _fmt_bytes(st.st_size),
                "dbStats": {},
                "directories": [],
                "version": "1.0",
            }
    except Exception:
        return None


# ── Create Backup ────────────────────────────────────────────────────────────

def create_backup(
    scope: Literal["full", "core"] = "full",
    note: str = "",
    source: Literal["manual", "auto", "pre-restore"] = "manual"
) -> dict:
    """Creates a compressed .tar.gz backup of the SQLite database and data directories."""
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    short_id = uuid.uuid4().hex[:8]
    prefix = f"shellb-backup-{stamp}-{short_id}"
    if source == "pre-restore":
        prefix = f"shellb-pre-restore-{stamp}-{short_id}"

    archive_filename = f"{prefix}.tar.gz"
    final_archive_path = BACKUP_DIR / archive_filename

    # Create in temporary location first, then atomically move
    with tempfile.TemporaryDirectory(prefix="shellb_bk_") as tmpdir:
        staging = Path(tmpdir) / prefix
        staging.mkdir(parents=True)

        # 1. Safely dump SQLite database
        db_dump_path = staging / "shellb.db"
        db_stats = dump_db_safely(db_dump_path)

        # 2. Copy selected filesystem directories
        included_dirs = CORE_DIRS if scope == "core" else ALL_DATA_DIRS
        actual_dirs = []

        for d_name in included_dirs:
            src_dir = db.DATA / d_name
            if src_dir.exists() and src_dir.is_dir():
                dst_dir = staging / d_name
                shutil.copytree(
                    src_dir,
                    dst_dir,
                    ignore=shutil.ignore_patterns(*EXCLUDE_PATTERNS),
                    symlinks=True
                )
                actual_dirs.append(d_name)

        # 3. Copy individual files
        for f_name in INDIVIDUAL_FILES:
            src_file = db.DATA / f_name
            if src_file.exists() and src_file.is_file():
                shutil.copy2(src_file, staging / f_name)

        # 4. Write manifest
        manifest = {
            "id": short_id,
            "filename": archive_filename,
            "scope": scope,
            "source": source,
            "note": note,
            "createdAt": _now_ts(),
            "createdAtIso": _now_iso(),
            "dbStats": db_stats,
            "directories": actual_dirs,
            "version": "1.0",
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2))

        # 5. Build tar.gz
        temp_archive = Path(tmpdir) / archive_filename
        with tarfile.open(temp_archive, "w:gz", compresslevel=1) as tar:
            for item in staging.iterdir():
                tar.add(item, arcname=item.name)

        # 6. Move to destination
        shutil.move(str(temp_archive), str(final_archive_path))

    size = final_archive_path.stat().st_size
    manifest["sizeBytes"] = size
    manifest["sizeFormatted"] = _fmt_bytes(size)

    # Update index
    index = _load_index()
    index = [m for m in index if m["filename"] != archive_filename]
    index.insert(0, manifest)
    _save_index(index)

    return manifest


# ── Restore Backup ───────────────────────────────────────────────────────────

def find_archive(identifier: str) -> Path | None:
    """Finds backup archive by path, filename, or short ID."""
    if Path(identifier).exists() and Path(identifier).is_file():
        return Path(identifier)
    for p in BACKUP_DIR.glob("*.tar.gz"):
        if p.name == identifier or identifier in p.name:
            return p
    return None


def restore_backup(archive_identifier: str, create_safety: bool = True) -> dict:
    """Restores database and data directories from a backup archive.
    
    archive_identifier can be an ID, filename, or direct file path.
    """
    archive_path = find_archive(archive_identifier)
    if not archive_path or not archive_path.exists():
        raise FileNotFoundError(f"Backup archive not found: {archive_identifier}")

    # 1. Create safety snapshot first if requested
    safety_info = None
    if create_safety:
        safety_info = create_backup(scope="core", note="Automatic safety snapshot before restore", source="pre-restore")

    # 2. Extract to staging directory
    staging_dir = db.DATA / ".restore_staging"
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True)

    try:
        with tarfile.open(archive_path, "r:gz") as tar:
            # Prevent path traversal attacks
            for member in tar.getmembers():
                if member.name.startswith("/") or ".." in member.name:
                    raise ValueError(f"Dangerous path in archive: {member.name}")
            tar.extractall(staging_dir)

        # 3. Verify extracted SQLite database
        staged_db = staging_dir / "shellb.db"
        if not staged_db.exists():
            raise RuntimeError("Corrupt backup: missing shellb.db inside archive.")

        chk = sqlite3.connect(staged_db)
        cur = chk.cursor()
        cur.execute("PRAGMA integrity_check;")
        res = cur.fetchall()
        chk.close()
        if not res or res[0][0] != "ok":
            raise RuntimeError(f"Extracted database failed integrity check: {res}")

        # 4. Read manifest if present
        manifest_path = staging_dir / "manifest.json"
        manifest = {}
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text())
            except Exception:
                pass

        # 5. Overwrite database files safely
        # Remove WAL and SHM files so SQLite starts clean
        wal_file = db.DATA / "shellb.db-wal"
        shm_file = db.DATA / "shellb.db-shm"
        if wal_file.exists():
            wal_file.unlink(missing_ok=True)
        if shm_file.exists():
            shm_file.unlink(missing_ok=True)

        shutil.copy2(staged_db, db.DB_PATH)

        # 6. Overwrite data directories
        for item in staging_dir.iterdir():
            if item.name in ("shellb.db", "manifest.json"):
                continue
            dst = db.DATA / item.name
            if item.is_dir():
                if dst.exists():
                    shutil.rmtree(dst)
                shutil.copytree(item, dst, symlinks=True)
            elif item.is_file():
                shutil.copy2(item, dst)

        return {
            "ok": True,
            "message": f"Successfully restored from {archive_path.name}",
            "restoredManifest": manifest,
            "safetyBackup": safety_info,
        }
    finally:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)


# ── Retention Policy & Scheduled Runner ──────────────────────────────────────

def prune_automated_backups(keep_daily: int = 7, keep_weekly: int = 4):
    """Enforces retention policy on automated backups only."""
    index = _load_index()
    auto_backups = [m for m in index if m.get("source") == "auto"]
    if len(auto_backups) <= keep_daily:
        return

    # Sort newest first
    auto_backups.sort(key=lambda m: m.get("createdAt", 0), reverse=True)
    to_keep = set()
    weekly_buckets = set()

    for m in auto_backups:
        ts = m.get("createdAt", 0)
        dt = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)
        # Daily quota
        if len(to_keep) < keep_daily:
            to_keep.add(m["filename"])
            continue
        # Weekly quota: 1 per ISO calendar week
        week_key = f"{dt.year}-W{dt.isocalendar()[1]}"
        if week_key not in weekly_buckets and len(weekly_buckets) < keep_weekly:
            weekly_buckets.add(week_key)
            to_keep.add(m["filename"])

    for m in auto_backups:
        if m["filename"] not in to_keep:
            f = BACKUP_DIR / m["filename"]
            if f.exists():
                f.unlink(missing_ok=True)

    _rebuild_index()


async def scheduled_backup_loop():
    """Background task running every hour to ensure daily automated backup."""
    while True:
        try:
            now = time.time()
            index = _load_index()
            recent_auto = [m for m in index if m.get("source") == "auto" and now - m.get("createdAt", 0) < 86400]
            if not recent_auto:
                # Perform daily backup
                create_backup(scope="full", note="Scheduled daily automated backup", source="auto")
                prune_automated_backups()
        except Exception as e:
            print(f"[BackupScheduler] Error: {e}")
        await asyncio.sleep(3600)


_scheduler_task = None


def start_scheduler():
    global _scheduler_task
    if _scheduler_task is None or _scheduler_task.done():
        loop = asyncio.get_event_loop()
        _scheduler_task = loop.create_task(scheduled_backup_loop())


def stop_scheduler():
    global _scheduler_task
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
        _scheduler_task = None


def init():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    _rebuild_index()


# ── FastAPI Routes ──────────────────────────────────────────────────────────

def _check_admin(req: Request):
    """Restricted to logged-in owner or localhost session."""
    if not auth.is_owner(req) and req.scope.get("shellb_auth") != "local":
        raise HTTPException(401, "login-required")


@router.get("")
def list_backups(req: Request):
    _check_admin(req)
    return _load_index()


@router.post("")
async def api_create_backup(req: Request):
    _check_admin(req)
    body = {}
    try:
        body = await req.json()
    except Exception:
        pass
    scope = body.get("scope", "full")
    if scope not in ("full", "core"):
        scope = "full"
    note = str(body.get("note", ""))
    res = create_backup(scope=scope, note=note, source="manual")
    db.audit_log("backup:create", {"scope": scope, "id": res.get("id") if isinstance(res, dict) else None})
    return res


@router.get("/{backup_id}/download")
def download_backup(backup_id: str, req: Request):
    _check_admin(req)
    p = find_archive(backup_id)
    if p:
        return FileResponse(p, filename=p.name, media_type="application/gzip")
    raise HTTPException(404, "Backup not found")


@router.post("/upload")
async def upload_backup(req: Request, file: UploadFile = File(...)):
    _check_admin(req)
    if not file.filename or not file.filename.endswith(".tar.gz"):
        raise HTTPException(400, "Only .tar.gz backup files are supported.")

    dest = BACKUP_DIR / file.filename
    # Avoid collisions
    if dest.exists():
        stem = file.filename[:-7]
        dest = BACKUP_DIR / f"{stem}-{uuid.uuid4().hex[:4]}.tar.gz"

    with dest.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    manifest = inspect_archive(dest)
    if not manifest:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "Invalid backup archive: missing manifest or unreadable tar.gz.")

    _rebuild_index()
    db.audit_log("backup:upload", {"file": dest.name})
    return manifest


@router.post("/{backup_id}/restore")
def api_restore_backup(backup_id: str, req: Request):
    _check_admin(req)
    # Logged before the restore: the live DB (and its audit table) is replaced mid-way.
    db.audit_log("backup:restore", {"id": backup_id})
    try:
        res = restore_backup(backup_id, create_safety=True)
        return res
    except Exception as e:
        db.audit_log("backup:restore_failed", {"id": backup_id, "error": str(e)[:300]})
        raise HTTPException(500, f"Restore failed: {e}")


@router.delete("/{backup_id}")
def delete_backup(backup_id: str, req: Request):
    _check_admin(req)
    p = find_archive(backup_id)
    if p:
        p.unlink(missing_ok=True)
        _rebuild_index()
        db.audit_log("backup:delete", {"id": backup_id})
        return {"ok": True}
    raise HTTPException(404, "Backup not found")


@router.get("/{backup_id}/inspect")
def inspect_backup_endpoint(backup_id: str, req: Request):
    _check_admin(req)
    p = find_archive(backup_id)
    if p:
        manifest = inspect_archive(p)
        if manifest:
            return manifest
    raise HTTPException(404, "Backup not found")


# ── Standalone CLI Interface ────────────────────────────────────────────────

def cli():
    parser = argparse.ArgumentParser(description="Shell:B Backup & Restore CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    # create
    p_create = sub.add_parser("create", help="Create a new backup")
    p_create.add_argument("--scope", choices=["full", "core"], default="full", help="Scope of backup (default: full)")
    p_create.add_argument("--note", default="", help="Optional note to attach to backup")

    # list
    sub.add_parser("list", help="List all available backups")

    # restore
    p_restore = sub.add_parser("restore", help="Restore system from a backup")
    p_restore.add_argument("backup_id", help="Backup ID, filename, or full path to .tar.gz archive")
    p_restore.add_argument("--no-safety", action="store_true", help="Skip creating a safety snapshot before restoring")
    p_restore.add_argument("--restart", action="store_true", help="Restart shellb-web service after restoring")

    # verify
    p_verify = sub.add_parser("verify", help="Inspect and verify an archive")
    p_verify.add_argument("backup_id", help="Backup ID, filename, or full path")

    # delete
    p_del = sub.add_parser("delete", help="Delete a backup")
    p_del.add_argument("backup_id", help="Backup ID or filename")

    args = parser.parse_args()

    if args.cmd == "create":
        print(f"Creating {args.scope} backup...")
        m = create_backup(scope=args.scope, note=args.note, source="manual")
        print(f"Backup created successfully:")
        print(f"  ID:       {m['id']}")
        print(f"  File:     {m['filename']}")
        print(f"  Size:     {m['sizeFormatted']}")
        print(f"  Scope:    {m['scope']}")
        print(f"  Tables:   {m['dbStats']}")

    elif args.cmd == "list":
        items = _load_index()
        if not items:
            print("No backups found.")
            return
        print(f"{'ID':<10} {'Created':<22} {'Size':<10} {'Scope':<6} {'Source':<12} {'Note'}")
        print("-" * 80)
        for m in items:
            dt = m.get("createdAtIso", "")[:19].replace("T", " ")
            print(f"{m.get('id', ''):<10} {dt:<22} {m.get('sizeFormatted', ''):<10} {m.get('scope', ''):<6} {m.get('source', ''):<12} {m.get('note', '')}")

    elif args.cmd == "verify":
        p = find_archive(args.backup_id)
        if not p:
            print(f"Failed to find archive: {args.backup_id}")
            sys.exit(1)
        m = inspect_archive(p)
        if not m:
            print(f"Failed to verify or read {p.name}")
            sys.exit(1)
        print("Archive Manifest:")
        print(json.dumps(m, indent=2))

    elif args.cmd == "restore":
        print(f"Restoring from {args.backup_id}...")
        res = restore_backup(args.backup_id, create_safety=not args.no_safety)
        print(f"Restore complete: {res['message']}")
        if res.get("safetyBackup"):
            print(f"Safety snapshot created: {res['safetyBackup']['filename']}")
        if args.restart:
            print("Restarting shellb-web service...")
            os.system("systemctl --user restart shellb-web")

    elif args.cmd == "delete":
        p = find_archive(args.backup_id)
        if p:
            p.unlink()
            _rebuild_index()
            print(f"Deleted {p.name}")
            return
        print(f"Backup not found: {args.backup_id}")
        sys.exit(1)


if __name__ == "__main__":
    cli()
