"""Global weather fields for the Worlds app's wind layer (the earth.nullschool.net look): NOAA GFS 0.25° forecasts
read straight from the GFS archive on AWS Open Data (no key), one GRIB message at a time by byte range, decoded with
ecCodes, thinned to 0.5° and served as little-endian Int16 planes.

  GET /api/earth/wind/meta                      the run in use, its forecast hours, the products offered
  GET /api/earth/wind/{product}/{hour}.bin      'SBWF' + header JSON + Int16 planes (see pack()); hour = 0..240 step 3

Products: wind10, wind850, wind500, wind250 (u and v, cm/s), temp2m / temp850 / temp500 / temp250 (°C × 100), pressure
(mean sea level, tenths of a hPa above 1000), clouds (total cloud, %), humidity (2 m relative humidity, %), gust (m/s × 100).
The header tells the client how to read each plane (value = stored / scale + offset). Files are cached under data/earth/wind/<run>/ and old runs are pruned.
Source: https://registry.opendata.aws/noaa-gfs-bdp-pds/  (NOMADS' OpenDAP, which nullschool-style sites used to read,
was retired in 2025; the GRIB files themselves are public domain.)
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import struct
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from tools import GUARD_HOOKS

router = APIRouter(prefix="/api/earth/wind")
DATA = Path(__file__).resolve().parent.parent / "data" / "earth" / "wind"
UA = {"User-Agent": "Shell:B Worlds (self-hosted personal assistant)"}
BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
HOURS = list(range(0, 241, 3))
THIN = 2  # 0.25° → 0.5°
MAGIC = b"SBWF"

# product → planes: (idx key "NAME:level", plane name, display unit, subtract, multiply, header scale, header offset)
# stored Int16 = round((x − subtract) × multiply); the client reads value = stored / scale + offset, in the display unit
WIND = lambda lvl: [(f"UGRD:{lvl}", "u", "m/s", 0, 100, 100, 0), (f"VGRD:{lvl}", "v", "m/s", 0, 100, 100, 0)]  # noqa: E731
TEMP = lambda lvl: [(f"TMP:{lvl}", "t", "°C", 273.15, 100, 100, 0)]  # noqa: E731
PRODUCTS: dict[str, dict] = {
    "wind10": {"planes": WIND("10 m above ground"), "label": "Wind at 10 m"},
    "wind850": {"planes": WIND("850 mb"), "label": "Wind at 850 hPa (~1.5 km)"},
    "wind500": {"planes": WIND("500 mb"), "label": "Wind at 500 hPa (~5.5 km)"},
    "wind250": {"planes": WIND("250 mb"), "label": "Wind at 250 hPa (jet stream, ~10 km)"},
    "temp2m": {"planes": TEMP("2 m above ground"), "label": "Temperature at 2 m"},
    "temp850": {"planes": TEMP("850 mb"), "label": "Temperature at 850 hPa"},
    "temp500": {"planes": TEMP("500 mb"), "label": "Temperature at 500 hPa"},
    "temp250": {"planes": TEMP("250 mb"), "label": "Temperature at 250 hPa"},
    # Pa → tenths of a hPa above 1000 hPa: 101325 Pa → 132; client: 132 / 10 + 1000 = 1013.2 hPa
    "pressure": {"planes": [("PRMSL:mean sea level", "p", "hPa", 100000, 0.1, 10, 1000)], "label": "Mean sea-level pressure"},
    "clouds": {"planes": [("TCDC:entire atmosphere", "c", "%", 0, 100, 100, 0)], "label": "Total cloud cover"},
    "humidity": {"planes": [("RH:2 m above ground", "h", "%", 0, 100, 100, 0)], "label": "Relative humidity at 2 m"},
    "gust": {"planes": [("GUST:surface", "g", "m/s", 0, 100, 100, 0)], "label": "Wind gusts"},
}
_RUN = re.compile(r"^\d{8}/\d{2}$")
_run_cache: dict = {"at": 0.0, "run": None}
_locks: dict[str, asyncio.Lock] = {}


def _client(timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, headers=UA, event_hooks=GUARD_HOOKS, follow_redirects=True)


def file_url(run: str, hour: int, idx: bool = False) -> str:
    day, hh = run.split("/")
    return f"{BUCKET}/gfs.{day}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{hour:03d}" + (".idx" if idx else "")


def run_time(run: str) -> datetime:
    day, hh = run.split("/")
    return datetime.strptime(day + hh, "%Y%m%d%H").replace(tzinfo=timezone.utc)


async def latest_run() -> str:
    """The newest GFS run with its forecast files up (f120 present means the run is mostly in), cached 15 minutes.
    Runs appear 3.5 to 5 hours after their nominal time, so the search starts 4 hours back."""
    if _run_cache["run"] and time.time() - _run_cache["at"] < 900:
        return _run_cache["run"]
    now = datetime.now(timezone.utc) - timedelta(hours=4)
    now = now.replace(minute=0, second=0, microsecond=0, hour=(now.hour // 6) * 6)
    async with _client(15) as c:
        for k in range(8):  # two days back at most
            t = now - timedelta(hours=6 * k)
            run = t.strftime("%Y%m%d/%H")
            try:
                r = await c.head(file_url(run, 120, idx=True))
                if r.status_code == 200:
                    _run_cache.update(at=time.time(), run=run)
                    return run
            except httpx.HTTPError:
                continue
    if _run_cache["run"]:
        return _run_cache["run"]
    raise HTTPException(503, "No GFS run reachable on AWS Open Data")


def parse_idx(text: str) -> list[tuple[str, int, int | None]]:
    """GFS .idx lines 'n:start:d=…:NAME:level:step:' → [(\"NAME:level\", start, end)], end None for the last message."""
    rows = []
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) < 6:
            continue
        rows.append((f"{parts[3]}:{parts[4]}", int(parts[1])))
    out: list[tuple[str, int, int | None]] = []
    for i, (key, start) in enumerate(rows):
        end = rows[i + 1][1] - 1 if i + 1 < len(rows) else None
        out.append((key, start, end))
    return out


def decode(grib: bytes) -> tuple[list[float], int, int]:
    """One GRIB2 message → (values row-major from the north pole eastward from 0°E, ni, nj)."""
    import eccodes  # noqa: PLC0415 - optional dependency, only needed here
    h = eccodes.codes_new_from_message(grib)
    try:
        ni, nj = int(eccodes.codes_get(h, "Ni")), int(eccodes.codes_get(h, "Nj"))
        if eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees") != 90 or int(eccodes.codes_get(h, "jScansPositively")) != 0:
            raise ValueError("unexpected GFS grid orientation")
        vals = eccodes.codes_get_values(h)
    finally:
        eccodes.codes_release(h)
    return vals, ni, nj


def pack(header: dict, planes: list[bytes]) -> bytes:
    hj = json.dumps(header, separators=(",", ":")).encode()
    return MAGIC + struct.pack("<I", len(hj)) + hj + b"".join(planes)


def thin_and_scale(vals, ni: int, nj: int, scale: float, offset: float) -> tuple[bytes, int, int]:
    """Keep every THIN-th row and column, scale to Int16 (clamped)."""
    import numpy as np  # noqa: PLC0415
    a = np.asarray(vals, dtype=np.float64).reshape(nj, ni)[::THIN, ::THIN]
    q = np.clip(np.rint((a - offset) * scale), -32767, 32767).astype("<i2")
    return q.tobytes(), a.shape[1], a.shape[0]


async def build(run: str, product: str, hour: int) -> Path:
    spec = PRODUCTS[product]
    out = DATA / run.replace("/", "-") / f"{product}-{hour:03d}.bin"
    if out.is_file():
        return out
    lock = _locks.setdefault(str(out), asyncio.Lock())
    async with lock:
        if out.is_file():
            return out
        idx_path = out.parent / f"f{hour:03d}.idx"
        async with _client(90) as c:
            if idx_path.is_file():
                idx_text = idx_path.read_text()
            else:
                r = await c.get(file_url(run, hour, idx=True))
                if r.status_code != 200:
                    raise HTTPException(404 if r.status_code == 404 else 502, f"GFS index for f{hour:03d} not available ({r.status_code})")
                idx_text = r.text
                idx_path.parent.mkdir(parents=True, exist_ok=True)
                idx_path.write_text(idx_text)
            index = {k: (s, e) for k, s, e in parse_idx(idx_text)}
            planes: list[bytes] = []
            names: list[dict] = []
            nx = ny = 0
            for key, name, unit, sub, mul, scale, offset in spec["planes"]:
                if key not in index:
                    raise HTTPException(502, f"{key} missing from the GFS index")
                s, e = index[key]
                r = await c.get(file_url(run, hour), headers={"Range": f"bytes={s}-{e if e is not None else ''}"})
                if r.status_code not in (200, 206):
                    raise HTTPException(502, f"GFS message fetch failed ({r.status_code})")
                vals, ni, nj = await asyncio.get_running_loop().run_in_executor(None, decode, r.content)
                data, nx, ny = await asyncio.get_running_loop().run_in_executor(None, thin_and_scale, vals, ni, nj, mul, sub)
                planes.append(data)
                names.append({"name": name, "unit": unit, "scale": scale, "offset": offset})
        valid = run_time(run) + timedelta(hours=hour)
        header = {"product": product, "label": spec["label"], "run": run_time(run).strftime("%Y-%m-%dT%H:%MZ"), "hour": hour,
                  "valid": valid.strftime("%Y-%m-%dT%H:%MZ"), "nx": nx, "ny": ny, "lat0": 90.0, "dlat": -0.25 * THIN, "lon0": 0.0,
                  "dlon": 0.25 * THIN, "dtype": "int16le", "planes": names, "source": "NOAA GFS 0.25° via AWS Open Data"}
        tmp = out.with_suffix(".part")
        tmp.write_bytes(pack(header, planes))
        tmp.replace(out)
        prune(keep=run.replace("/", "-"))
        return out


def prune(keep: str, keep_runs: int = 2):
    """Keep the current run and the one before; forecasts of older runs are of no use."""
    if not DATA.is_dir():
        return
    runs = sorted((d for d in DATA.iterdir() if d.is_dir()), key=lambda d: d.name)
    for d in runs[:-keep_runs]:
        if d.name != keep:
            shutil.rmtree(d, ignore_errors=True)


def clamp_hour(hour: int) -> int:
    return min(240, max(0, int(round(hour / 3)) * 3))


@router.get("/meta")
async def meta():
    run = await latest_run()
    return {"run": run_time(run).strftime("%Y-%m-%dT%H:%MZ"), "hours": HOURS, "products": {k: v["label"] for k, v in PRODUCTS.items()},
            "source": "NOAA GFS 0.25° forecasts, read from AWS Open Data", "note": "Forecast hours follow the map clock; before the run's time the analysis (hour 0) is shown."}


@router.get("/{product}/{hour}.bin")
async def field(product: str, hour: int):
    if product not in PRODUCTS or hour not in HOURS:
        raise HTTPException(404, "no such field")
    run = await latest_run()
    try:
        path = await build(run, product, hour)
    except httpx.HTTPError as e:
        raise HTTPException(503, f"GFS unreachable: {e.__class__.__name__}")
    return FileResponse(path, media_type="application/octet-stream", headers={"Cache-Control": "public, max-age=1800", "X-Content-Type-Options": "nosniff"})
