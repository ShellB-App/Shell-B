"""Transcription of audio and video files: `transcribe` tool, Secretary video uploads, notebook media sources.

The host has no ffmpeg; the sandbox image does. `to_wav` runs ffmpeg in a throwaway container (`--network none`, the
file's folder mounted) to turn any audio/video into 16 kHz mono WAV, then `stt` sends it to HERMES Whisper
(`/stt`, the same endpoint dictation uses) and returns the text with timed segments. Inputs are files in the chat's
/work, a project, or an http(s) URL to a media file (public addresses only, 500 MB cap). YouTube and other streaming
sites are not fetched: that would need yt-dlp with network access inside the sandbox, which the owner hasn't enabled.
Transcripts are saved next to the source as <name>.transcript.txt so the agent can read or search them later.

YouTube, Vimeo and the like: yt-dlp (in the server's venv, so the sandbox never gets a network) fetches the best audio-
only format (≤ 300 MB, ≤ 4 h, single video, no playlists) into the chat's media folder; the sandbox then transcodes it.
"""
import asyncio
import json
import os
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx

import db

HERMES = "http://localhost:8001"
SANDBOX_IMAGE = "shellb-sandbox"
MAX_DOWNLOAD = 500 * 2**20
MAX_MINUTES = 240
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wma", ".webm", ".weba", ".amr", ".aiff", ".aif"}
VIDEO_EXT = {".mp4", ".mkv", ".mov", ".avi", ".m4v", ".mpg", ".mpeg", ".wmv", ".3gp", ".ts", ".mts"}
MEDIA_EXT = AUDIO_EXT | VIDEO_EXT
STREAMING = re.compile(r"https?://(www\.|m\.|music\.)?(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|tiktok\.com|dailymotion\.com|soundcloud\.com)/", re.I)
YT_MAX_BYTES = 300 * 2**20
YT_MAX_SECONDS = 4 * 3600


def is_media(name: str) -> bool:
    return Path(name).suffix.lower() in MEDIA_EXT


def is_video(name: str) -> bool:
    return Path(name).suffix.lower() in VIDEO_EXT


async def to_wav(src: Path, dst: Path | None = None) -> Path:
    """ffmpeg in the sandbox image: any audio/video → 16 kHz mono PCM WAV. Raises RuntimeError with ffmpeg's tail."""
    if not shutil.which("docker"):
        raise RuntimeError("Transcoding needs the code sandbox (docker), which isn't installed")
    src = Path(src).resolve()
    work = Path(tempfile.mkdtemp(prefix="shellb-media-", dir=db.DATA / "cells"))
    try:
        os.chmod(work, 0o777)
        link = work / ("in" + src.suffix.lower())
        shutil.copy2(src, link)
        cmd = ["docker", "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--memory", "2g", "--cpus", "2", "--pids-limit", "64",
               "--read-only", "--tmpfs", "/tmp:rw,size=256m", "--user", f"{os.getuid()}:{os.getgid()}", "-v", f"{work}:/work",
               "-w", "/work", SANDBOX_IMAGE, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", link.name,
               "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-t", str(MAX_MINUTES * 60), "out.wav"]
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=900)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("ffmpeg took longer than 15 minutes")
        if proc.returncode != 0 or not (work / "out.wav").exists():
            raise RuntimeError("ffmpeg: " + (err.decode(errors="replace").strip()[-400:] or f"exit {proc.returncode}"))
        dst = Path(dst) if dst else src.with_suffix(".16k.wav")
        shutil.move(str(work / "out.wav"), dst)
        return dst
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def stt(wav: Path) -> dict:
    """HERMES Whisper: {text, segments: [{start, end, text}], language?}."""
    async with httpx.AsyncClient(timeout=1800) as c:
        with wav.open("rb") as f:
            r = await c.post(f"{HERMES}/stt", files={"file": (wav.name, f, "audio/wav")})
    if r.status_code != 200:
        raise RuntimeError(f"HERMES: {r.text[:300]}")
    out = r.json()
    return {"text": str(out.get("text") or "").strip(), "segments": out.get("segments") or [], "language": out.get("language")}


def _stamp(sec: float) -> str:
    sec = max(0, int(sec or 0))
    return f"{sec // 3600:d}:{sec % 3600 // 60:02d}:{sec % 60:02d}" if sec >= 3600 else f"{sec // 60:d}:{sec % 60:02d}"


def with_timestamps(segments: list, every: float = 30.0) -> str:
    """Segments joined into paragraphs with a [m:ss] mark every `every` seconds."""
    if not segments:
        return ""
    out, last = [], -every
    for s in segments:
        start = float(s.get("start") or 0)
        text = str(s.get("text") or "").strip()
        if not text:
            continue
        if start - last >= every:
            out.append(f"\n[{_stamp(start)}] ")
            last = start
        out.append(text + " ")
    return "".join(out).strip()


async def transcribe_path(src: Path) -> dict:
    """Transcode if needed, transcribe, save <name>.transcript.txt next to the source. Returns the stt dict + paths."""
    src = Path(src)
    wav = src if src.suffix.lower() == ".wav" else await to_wav(src)
    try:
        out = await stt(wav)
    finally:
        if wav != src:
            wav.unlink(missing_ok=True)
    body = with_timestamps(out["segments"]) or out["text"]
    tpath = src.with_name(src.stem + ".transcript.txt")
    tpath.write_text(body + "\n")
    out["transcript"] = str(tpath)
    out["body"] = body
    return out


async def download(url: str, into: Path) -> Path:
    from tools import UA, _blocked_host
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname or _blocked_host(u.hostname):
        raise ValueError("Only public http(s) addresses can be fetched")
    if STREAMING.match(url):
        return await asyncio.to_thread(youtube, url, into)
    name = re.sub(r"[^\w.-]+", "_", Path(u.path).name or "media")[:80]
    if not is_media(name):
        name += ".mp4"
    dest = into / name
    async with httpx.AsyncClient(timeout=120, follow_redirects=True, headers={"User-Agent": UA}) as c:
        async with c.stream("GET", url) as r:
            r.raise_for_status()
            if _blocked_host(r.url.host or ""):
                raise ValueError("The download redirected to a local address")
            size = 0
            with dest.open("wb") as f:
                async for chunk in r.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_DOWNLOAD:
                        f.close()
                        dest.unlink(missing_ok=True)
                        raise ValueError("Files over 500 MB aren't fetched")
                    f.write(chunk)
    return dest


def youtube(url: str, into: Path) -> Path:
    """yt-dlp, audio only, one video: returns the downloaded file. Runs on the host (blocking; call from a thread)."""
    try:
        import yt_dlp
    except ImportError:
        raise ValueError("yt-dlp isn't installed in the venv (venv/bin/pip install yt-dlp)")
    into.mkdir(parents=True, exist_ok=True)
    opts = {"format": "bestaudio[filesize<300M]/bestaudio/best[filesize<300M]", "noplaylist": True, "quiet": True, "no_warnings": True,
            "outtmpl": str(into / "%(id)s.%(ext)s"), "max_filesize": YT_MAX_BYTES, "match_filter": yt_dlp.utils.match_filter_func(f"duration <= {YT_MAX_SECONDS}"),
            "socket_timeout": 30, "retries": 2, "nocheckcertificate": False, "cachedir": False, "writesubtitles": False}
    with yt_dlp.YoutubeDL(opts) as y:
        try:
            info = y.extract_info(url, download=True)
        except yt_dlp.utils.DownloadError as e:
            raise ValueError(f"yt-dlp couldn't fetch that: {str(e).splitlines()[-1][:200]}")
    if info.get("_type") == "playlist":
        info = (info.get("entries") or [None])[0] or {}
    path = Path(y.prepare_filename(info)) if info else None
    if not path or not path.exists():
        found = sorted(into.glob(f"{info.get('id', '*')}.*"), key=lambda p: p.stat().st_mtime) if info else []
        if not found:
            raise ValueError("yt-dlp finished but left no file (the video may be too long or unavailable)")
        path = found[-1]
    title = re.sub(r"[^\w.-]+", "_", str(info.get("title") or path.stem))[:80]
    dest = path.with_name(f"{title}{path.suffix}")
    if dest != path:
        path.replace(dest)
    return dest


async def transcribe_tool(args, ctx):
    from tools import ToolResult, WORKSPACES
    what = str(args.get("file") or args.get("url") or "").strip()
    if not what:
        return ToolResult("Give `file` (a /work or /project path) or `url` (an audio/video file on the web).", error=True)
    ws = (db.DATA / "projects" / ctx.project_id).resolve() if ctx.project_id else (WORKSPACES / ctx.conv_id).resolve()
    ws.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    try:
        if re.match(r"^https?://", what, re.I):
            media_dir = ws / "media"
            media_dir.mkdir(exist_ok=True)
            src = await download(what, media_dir)
            shown = f"/work/media/{src.name}" if not ctx.project_id else f"/project/media/{src.name}"
        else:
            rel = what.removeprefix("/work/").removeprefix("/project/").lstrip("/")
            src = (ws / rel).resolve()
            if not str(src).startswith(str(ws) + "/") or not src.is_file():
                return ToolResult(f"No such file: {what}", error=True)
            shown = what
        if not is_media(src.name):
            return ToolResult(f"{src.name} doesn't look like audio or video ({', '.join(sorted(MEDIA_EXT))}).", error=True)
        out = await transcribe_path(src)
    except (ValueError, RuntimeError) as e:
        return ToolResult(str(e), error=True)
    except httpx.HTTPError as e:
        return ToolResult(f"Download failed: {e}", error=True)
    body = out["body"]
    clipped = body if len(body) <= 16000 else body[:16000] + f"\n…[{len(body) - 16000:,} more chars in the transcript file]"
    rel_t = Path(out["transcript"]).relative_to(ws)
    where = f"/work/{rel_t}" if not ctx.project_id else f"/project/{rel_t}"
    head = f"Transcribed {shown} in {time.time() - t0:.0f}s" + (f" ({out['language']})" if out.get("language") else "") + f"; saved to {where}.\n\n"
    return ToolResult(head + (clipped or "(no speech found)"))


def register():
    from tools import TOOLS, _fn
    TOOLS["transcribe"] = {
        "fn": transcribe_tool, "service": "hermes",
        "ui": {"displayName": "Transcribe", "icon": "Captions", "category": "media",
               "description": "Speech to text for audio and video files (ffmpeg in the sandbox, Whisper on HERMES); transcripts are saved beside the file"},
        "schema": _fn("transcribe", "Transcribe an audio or video file with timestamps. `file` is a path in /work (chat uploads) or "
                      "/project; `url` is a direct media link or a YouTube/Vimeo/SoundCloud page (audio is fetched, ≤ 4 h). The transcript is "
                      "saved as <name>.transcript.txt next to the file and returned (long ones clipped; read the file for the rest).",
                      {"file": {"type": "string"}, "url": {"type": "string"}}, []),
    }
