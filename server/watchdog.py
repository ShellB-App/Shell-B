"""Health watchdog: tells the owner, through the Activity feed (and so her phone), when something on the box is wrong.

Every minute it checks four things and opens one incident per problem, posting one Activity item when an incident
opens (deduped by `ref`) and a "back up" item when a service or unit recovers:

- services: the /api/status probes (app.py hands `service_status` over as `probe`). A service must fail FAIL_AFTER
  checks in a row, and nothing is judged during the first GRACE seconds after startup (HERMES preloads Whisper for
  ~100 s). A service whose systemd unit is cleanly `inactive` was stopped on purpose and isn't reported.
- crash loops: `systemctl show -p NRestarts,...` for the Shell:B units and Ollama. NRestarts counts only systemd's
  automatic restarts after a failure ("Scheduled restart job, restart counter is at N"); a manual `systemctl restart`
  doesn't raise it (shellb-web shows 0 after many) and actually resets it, so a drop just restarts the history.
  A rise of LOOP_RESTARTS within LOOP_WINDOW, or ActiveState=failed, opens an incident; it closes once the unit is
  active with no automatic restart for a whole window.
- disk: `/` below DISK_PCT free or DISK_BYTES free warns at most once a day.
- memory: MemAvailable (unified CPU/GPU memory) below MEM_PCT for MEM_AFTER checks warns once per incident; it closes
  quietly above MEM_CLEAR.

Open incidents, the restart-counter history and the last disk warning live in kv `watchdog`, so a restart of
shellb-web neither re-alerts an incident that's still open nor forgets a crash loop in progress.
"""
import asyncio
import shutil
import time
from pathlib import Path

from fastapi import APIRouter

import activity
import db

router = APIRouter(prefix="/api/watchdog")
INTERVAL = 60
GRACE = 240
FAIL_AFTER = 3
LOOP_WINDOW = 15 * 60
LOOP_RESTARTS = 3
DISK_PCT, DISK_BYTES = 0.10, 100e9
MEM_PCT, MEM_CLEAR, MEM_AFTER = 0.05, 0.10, 3
KV = "watchdog"

SERVICES = {  # /api/status id -> plain name, systemd unit (None: not a unit we can see)
    "ollama": ("Local models (Ollama)", "ollama"),
    "searxng": ("Web search (SearXNG)", None),
    "nyx": ("Image generation (ComfyUI)", "shellb-nyx"),
    "orpheus": ("Music generation (ORPHEUS)", "shellb-orpheus"),
    "hermes": ("Speech (HERMES)", "shellb-hermes"),
    "embeddings": ("Memory embeddings model", None),
    "sandbox": ("Code sandbox", None),
    "studio": ("Studio browser", None),
}
UNITS = {
    "shellb-web": "Shell:B Web",
    "shellb-gaia": "GAIA router",
    "shellb-hermes": "Speech (HERMES)",
    "shellb-hermes-qwen": "Expressive voice (HERMES Qwen)",
    "shellb-orpheus": "Music generation (ORPHEUS)",
    "shellb-stableaudio": "Sound effects (Stable Audio)",
    "shellb-nyx": "Image generation (ComfyUI)",
    "ollama": "Local models (Ollama)",
}

probe = None          # async () -> {id: {"ok": bool, "error"?: str}}, set by app.py
_task = None
_started = time.time()
_last_run = 0.0
_fails: dict[str, int] = {}
_mem_low = 0
_checks: dict = {}


def _gb(n: float) -> str:
    return f"{n / 1e9:.0f} GB"


def _dur(s: float) -> str:
    m = int(s // 60)
    return f"{m // 60} h {m % 60} min" if m >= 60 else f"{max(m, 1)} min"


def _state() -> dict:
    s = db.kv_get(KV) or {}
    s.setdefault("open", {})
    s.setdefault("restarts", {})
    return s


# ── probes (tests replace these) ────────────────────────────────────────────

async def _systemctl(*args: str) -> str:
    try:
        p = await asyncio.create_subprocess_exec("systemctl", *args, stdout=asyncio.subprocess.PIPE,
                                                 stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(p.communicate(), 10)
        return out.decode(errors="replace")
    except (OSError, asyncio.TimeoutError):
        return ""


def _blocks(text: str) -> dict[str, dict]:
    out = {}
    for block in text.strip().split("\n\n"):
        props = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        if props.get("Id"):
            out[props["Id"].removesuffix(".service")] = props
    return out


async def units() -> dict[str, dict]:
    """{unit: {"active", "sub", "restarts"}} for the units that exist (user units, Ollama as user or system unit)."""
    props = "-p Id,LoadState,ActiveState,SubState,NRestarts".split()
    user, system = await asyncio.gather(_systemctl("--user", "show", *props, *UNITS),
                                        _systemctl("show", *props, "ollama"))
    found = _blocks(user)
    if found.get("ollama", {}).get("LoadState") != "loaded":
        found.pop("ollama", None)
        found.update(_blocks(system))
    return {u: {"active": p.get("ActiveState", ""), "sub": p.get("SubState", ""),
                "restarts": int(p.get("NRestarts") or 0)}
            for u, p in found.items() if u in UNITS and p.get("LoadState") == "loaded"}


def disk() -> tuple[int, int]:
    d = shutil.disk_usage("/")
    return d.free, d.total


def memory() -> tuple[int, int]:
    m = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        k, v = line.split(":", 1)
        m[k] = int(v.split()[0]) * 1024
    return m.get("MemAvailable", 0), m.get("MemTotal", 1)


# ── incidents ───────────────────────────────────────────────────────────────

def _open(st: dict, key: str, now: float, status: str, title: str, body: str):
    if key in st["open"]:
        return
    since = int(now)
    st["open"][key] = {"title": title, "status": status, "since": since}
    activity.post("health", status, title, body, ref=f"health:{key}:{since}")


def _close(st: dict, key: str, now: float, title: str | None, body: str = ""):
    inc = st["open"].pop(key, None)
    if inc and title:
        activity.post("health", "recovered", title, f"{body} It was out for {_dur(now - inc['since'])}.".strip(),
                      ref=f"health:{key}:{inc['since']}:up")


async def run_once(now: float | None = None) -> dict:
    """One pass over every check; returns the check snapshot that /api/watchdog shows."""
    global _last_run, _mem_low, _checks
    now = now or time.time()
    st = _state()
    checks: dict = {"services": {}, "units": {}}
    try:
        unit_info = await units()
    except Exception as e:  # noqa: BLE001
        print(f"watchdog: units failed: {type(e).__name__}: {e}")
        unit_info = {}

    # services
    if probe and now - _started >= GRACE:
        try:
            svc = await probe()
        except Exception as e:  # noqa: BLE001
            print(f"watchdog: probe failed: {type(e).__name__}: {e}")
            svc = {}
        ollama_down = not (svc.get("ollama") or {}).get("ok", True)
        for sid, (label, unit) in SERVICES.items():
            if sid not in svc:
                continue
            ok = bool(svc[sid].get("ok"))
            stopped = unit is not None and unit_info.get(unit, {}).get("active") == "inactive"
            if sid == "embeddings" and ollama_down:  # the model lives in Ollama; one alert is enough
                ok = True
            key = f"svc:{sid}"
            if ok or stopped:
                _fails[sid] = 0
                if key in st["open"]:
                    _close(st, key, now, None if stopped else f"{label} is back up")
            else:
                _fails[sid] = _fails.get(sid, 0) + 1
                if _fails[sid] >= FAIL_AFTER:
                    err = svc[sid].get("error")
                    hint = (f" Check `journalctl --user -u {unit} -n 100` or restart it with "
                            f"`systemctl --user restart {unit}`." if unit and unit != "ollama" else "")
                    _open(st, key, now, "failed", f"{label} is down",
                          f"Shell:B couldn't reach {label.lower()} for {_fails[sid]} checks in a row"
                          f"{f' ({err})' if err else ''}. Anything that uses it will fail until it's back.{hint}")
            checks["services"][sid] = {"label": label, "ok": ok, "stopped": stopped, "fails": _fails.get(sid, 0)}
    elif probe:
        checks["services"] = {"warmingUp": True}

    # crash loops
    hist = st["restarts"]
    for unit, info in unit_info.items():
        label, n = UNITS[unit], info["restarts"]
        h = [s for s in hist.get(unit, []) if s[0] >= now - LOOP_WINDOW]
        if h and n < h[-1][1]:  # a manual (re)start flushed the counter
            h = []
        h.append([now, n])
        hist[unit] = h
        rose = n - min(s[1] for s in h)
        key = f"unit:{unit}"
        if info["active"] == "failed":
            _open(st, key, now, "failed", f"{label} stopped after a failure",
                  f"systemd gave up on {unit} ({info['sub'] or 'failed'}). Check `journalctl --user -u {unit} -n 100`.")
        elif rose >= LOOP_RESTARTS:
            _open(st, key, now, "failed", f"{label} keeps crashing",
                  f"systemd restarted {unit} {rose} times in the last {LOOP_WINDOW // 60} minutes after it crashed. "
                  f"Check `journalctl --user -u {unit} -n 200` for the error.")
        elif key in st["open"] and info["active"] == "active" and rose == 0:
            _close(st, key, now, f"{label} is stable again", "No crashes for the last 15 minutes.")
        checks["units"][unit] = {"label": label, **info, "recentRestarts": rose}
    for unit in list(hist):
        if unit not in unit_info:
            hist.pop(unit)

    # disk
    try:
        free, total = disk()
        low = free < total * DISK_PCT or free < DISK_BYTES
        checks["disk"] = {"free": free, "total": total, "ok": not low}
        day = time.strftime("%Y-%m-%d", time.localtime(now))
        if low and st.get("diskDay") != day:
            st["diskDay"] = day
            activity.post("health", "warning", "System disk is nearly full",
                          f"Only {_gb(free)} of {_gb(total)} is free on / ({free / total:.0%}). Downloads, generations "
                          "and the database start failing when it runs out — see Settings → System for what's using it.",
                          ref=f"health:disk:{day}")
    except OSError as e:
        checks["disk"] = {"ok": False, "error": str(e)}

    # memory
    try:
        avail, total = memory()
        frac = avail / total
        _mem_low = _mem_low + 1 if frac < MEM_PCT else 0
        checks["memory"] = {"available": avail, "total": total, "ok": frac >= MEM_PCT}
        if _mem_low >= MEM_AFTER:
            _open(st, "mem", now, "warning", "Memory is almost full",
                  f"Only {_gb(avail)} of {_gb(total)} unified memory is free (CPU and GPU share it). Unload a model in "
                  "Models or stop an image/music generation, or the next load may crash a service.")
        elif frac >= MEM_CLEAR:
            _close(st, "mem", now, None)
    except (OSError, ValueError, ZeroDivisionError) as e:
        checks["memory"] = {"ok": False, "error": str(e)}

    db.kv_set(KV, st)
    _last_run, _checks = now, checks
    return checks


async def _loop():
    await asyncio.sleep(20)
    while True:
        try:
            await run_once()
        except Exception as e:  # noqa: BLE001
            print(f"watchdog: {type(e).__name__}: {e}")
        await asyncio.sleep(INTERVAL)


def start():
    global _task, _started
    if _task is None:
        _started = time.time()
        _task = asyncio.create_task(_loop())


def stop():
    global _task
    if _task and not _task.done():
        _task.cancel()
    _task = None


@router.get("")
def api_status():
    st = _state()
    return {"lastRun": _last_run * 1000 or None, "graceUntil": (_started + GRACE) * 1000, "checks": _checks,
            "incidents": [{"key": k, "title": v["title"], "status": v["status"], "since": v["since"] * 1000}
                          for k, v in sorted(st["open"].items(), key=lambda kv: kv[1]["since"])]}
