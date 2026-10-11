"""Earth imagery for the Worlds app: NASA GIBS satellite tiles that follow the map clock's date, and RainViewer radar.

  GET /api/earth/imagery                              the layers offered and the latest date GIBS normally has
  GET /api/earth/imagery/{layer}/{date}/{z}/{x}/{y}.jpg   one Web Mercator tile (GoogleMapsCompatible), cached on disk
  GET /api/earth/radar                                 precipitation frames (NASA IMERG, half-hourly, a few hours behind)
  GET /api/earth/radar/{time}/{z}/{x}/{y}.png          one precipitation tile for a frame time (ISO, UTC)
  GET /api/earth/aurora                                NOAA OVATION aurora forecast: a 360 × 181 probability grid

Everything comes from NASA GIBS (free, keyless, public domain; https://nasa-gibs.github.io/gibs-api-docs/). The browser never
talks to it directly (this proxy adds the User-Agent and keeps the owner's IP out of it), and tiles are cached under
data/earth so a day once looked at stays viewable offline. RainViewer was tried for live radar first: its free tile API
answers 410 below zoom 8 and placeholder tiles above (2026-10), so precipitation comes from GPM IMERG instead.
"""
from __future__ import annotations

import asyncio
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from tools import GUARD_HOOKS

router = APIRouter(prefix="/api/earth")
DATA = Path(__file__).resolve().parent.parent / "data" / "earth"
UA = {"User-Agent": "Shell:B Worlds (self-hosted personal assistant)"}
GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{date}/GoogleMapsCompatible_Level{level}/{z}/{y}/{x}.{ext}"
MAX_TILES = 40_000  # ~1-2 GB of JPEGs; the oldest go when there are more

# id → GIBS layer, name, first date, max zoom level, image type, whether it changes daily
LAYERS = {
    "modis": {"layer": "MODIS_Terra_CorrectedReflectance_TrueColor", "name": "MODIS Terra, true colour", "since": "2000-02-24", "level": 9, "ext": "jpg", "daily": True,
              "note": "One image of the whole Earth a day since 2000, as the eye would see it. Clouds and all."},
    "viirs": {"layer": "VIIRS_SNPP_CorrectedReflectance_TrueColor", "name": "VIIRS, true colour", "since": "2015-11-24", "level": 9, "ext": "jpg", "daily": True,
              "note": "Sharper daily true colour from the Suomi NPP satellite."},
    "modis-721": {"layer": "MODIS_Terra_CorrectedReflectance_Bands721", "name": "MODIS Terra, bands 7-2-1", "since": "2000-02-24", "level": 9, "ext": "jpg", "daily": True,
                  "note": "False colour: burn scars and bare ground red-brown, vegetation green, snow and ice bright cyan, water dark."},
    "bluemarble": {"layer": "BlueMarble_ShadedRelief_Bathymetry", "name": "Blue Marble", "since": "2004-08-01", "level": 8, "ext": "jpg", "daily": False,
                   "note": "NASA's cloud-free composite of the whole planet (2004), with shaded relief and the ocean floor."},
    "nightlights": {"layer": "VIIRS_Black_Marble", "name": "Black Marble, night lights", "since": "2012-01-01", "level": 8, "ext": "png", "daily": False,
                    "note": "City lights at night, the 2016 Black Marble composite."},
    # the sea layers (server/marine.py, the Worlds "Sea surface" layer): PNGs, transparent over land, drawn over the map
    # rather than picked as imagery. `lag`: days behind today that GIBS normally has the image complete.
    "sst": {"layer": "GHRSST_L4_MUR_Sea_Surface_Temperature", "name": "Sea surface temperature (MUR)", "since": "2002-06-01", "level": 7,
            "ext": "png", "daily": True, "sea": True, "lag": 2, "note": "Daily foundation SST, 1 km blended from satellites and buoys, 0–32 °C."},
    "sstanom": {"layer": "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies", "name": "Sea temperature anomaly (MUR)", "since": "2002-06-01",
                "level": 7, "ext": "png", "daily": True, "sea": True, "lag": 2,
                "note": "Difference from the 2003–2014 mean for the day, −3 to +3 °C: marine heatwaves show red."},
    "chl": {"layer": "OCI_PACE_Chlorophyll_a", "name": "Chlorophyll a (PACE)", "since": "2024-04-10", "level": 7, "ext": "png",
            "daily": True, "sea": True, "lag": 1, "note": "Phytoplankton pigment from NASA's PACE ocean colour satellite; clouds leave gaps."},
}
_ID = re.compile(r"^[a-z0-9-]{1,20}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_writes = 0
_lock = asyncio.Lock()


def latest_date(lag: int = 1) -> str:
    """GIBS usually has yesterday's daily imagery complete; today's arrives in swaths through the day."""
    return (date.today() - timedelta(days=lag)).isoformat()


def clamp_date(layer: dict, d: str) -> str:
    """The date GIBS should be asked for: within the layer's range, and a fixed one for composites."""
    if not layer["daily"]:
        return layer["since"]
    lo, hi = layer["since"], latest_date(layer.get("lag", 1))
    return lo if d < lo else hi if d > hi else d


@router.get("/imagery")
def imagery():
    return {"layers": [{"id": k, **{x: v[x] for x in ("name", "since", "level", "daily", "note")}} for k, v in LAYERS.items() if not v.get("sea")],
            "latest": latest_date()}


def _tile_ok(z: int, x: int, y: int, level: int) -> bool:
    return 0 <= z <= level and 0 <= x < 2**z and 0 <= y < 2**z


async def _fetch_tile(url: str, dest: Path, timeout: float = 20) -> Response | FileResponse:
    global _writes
    if dest.is_file():
        return FileResponse(dest, media_type="image/jpeg" if dest.suffix == ".jpg" else "image/png",
                            headers={"Cache-Control": "public, max-age=86400"})
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=UA, event_hooks=GUARD_HOOKS) as c:
            r = await c.get(url)
    except httpx.HTTPError as e:
        raise HTTPException(503, f"tile source unreachable: {e.__class__.__name__}")
    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
        raise HTTPException(404 if r.status_code in (400, 404) else 502, "no tile")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(r.content)
    tmp.replace(dest)
    _writes += 1
    if _writes % 500 == 0:
        asyncio.get_running_loop().run_in_executor(None, prune)
    return Response(r.content, media_type=r.headers["content-type"].split(";")[0], headers={"Cache-Control": "public, max-age=86400"})


def prune():
    """Keep the tile cache bounded: drop the least recently used files past MAX_TILES."""
    files = [f for f in DATA.rglob("*") if f.is_file() and f.suffix in (".jpg", ".png")]
    if len(files) <= MAX_TILES:
        return
    files.sort(key=lambda f: f.stat().st_atime)
    for f in files[: len(files) - MAX_TILES]:
        f.unlink(missing_ok=True)


@router.get("/imagery/{layer}/{d}/{z}/{x}/{y}.{ext}")
async def imagery_tile(layer: str, d: str, z: int, x: int, y: int, ext: str):
    spec = LAYERS.get(layer) if _ID.match(layer) else None
    if not spec or not _DATE.match(d) or ext != spec["ext"] or not _tile_ok(z, x, y, spec["level"]):
        raise HTTPException(404, "no such tile")
    d = clamp_date(spec, d)
    dest = DATA / "imagery" / layer / d / str(z) / str(x) / f"{y}.{spec['ext']}"
    url = GIBS.format(layer=spec["layer"], date=d, level=spec["level"], z=z, y=y, x=x, ext=spec["ext"])
    return await _fetch_tile(url, dest)


_frames: dict = {"at": 0.0, "data": None}
PRECIP_LAYER = "IMERG_Precipitation_Rate_30min"  # NASA GPM IMERG early run: global, every 30 min, a few hours behind
PRECIP_LEVEL = 6
PRECIP = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{t}/GoogleMapsCompatible_Level{level}/{z}/{y}/{x}.png"
_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:[03]0:00Z$")


def _half_hours(n: int, back_from: datetime | None = None) -> list[str]:
    t = (back_from or datetime.now(timezone.utc)).replace(second=0, microsecond=0)
    t -= timedelta(minutes=t.minute % 30)
    return [(t - timedelta(minutes=30 * k)).strftime("%Y-%m-%dT%H:%M:%SZ") for k in range(n)]


async def _probe(c: httpx.AsyncClient, t: str) -> bool:
    try:
        r = await c.get(PRECIP.format(layer=PRECIP_LAYER, t=t, level=PRECIP_LEVEL, z=1, y=0, x=0))
        return r.status_code == 200 and r.headers.get("content-type", "").startswith("image/")
    except httpx.HTTPError:
        return False


@router.get("/radar")
async def radar():
    """Precipitation frames available right now: the newest IMERG half hour (found by probing back from now, typically
    4 to 7 hours behind) and the 12 half hours before it. Cached for 15 minutes."""
    async with _lock:
        if _frames["data"] and time.time() - _frames["at"] < 900:
            return _frames["data"]
        newest = None
        try:
            async with httpx.AsyncClient(timeout=10, headers=UA, event_hooks=GUARD_HOOKS) as c:
                for t in _half_hours(40, datetime.now(timezone.utc) - timedelta(hours=3)):  # never newer than 3 h ago
                    if await _probe(c, t):
                        newest = t
                        break
        except Exception:  # noqa: BLE001
            newest = None
        if not newest:
            if _frames["data"]:
                return {**_frames["data"], "stale": True}
            raise HTTPException(503, "NASA GIBS precipitation unreachable")
        frames = list(reversed(_half_hours(13, datetime.strptime(newest, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc))))
        data = {"past": frames, "nowcast": [], "layer": PRECIP_LAYER, "fetched": int(time.time()),
                "note": "NASA GPM IMERG, satellite precipitation every 30 minutes, a few hours behind real time"}
        _frames.update(at=time.time(), data=data)
        return data


@router.get("/radar/{t}/{z}/{x}/{y}.png")
async def radar_tile(t: str, z: int, x: int, y: int):
    if not _TIME.match(t) or not _tile_ok(z, x, y, PRECIP_LEVEL):
        raise HTTPException(404, "no such tile")
    dest = DATA / "precip" / t.replace(":", "") / str(z) / str(x) / f"{y}.png"
    return await _fetch_tile(PRECIP.format(layer=PRECIP_LAYER, t=t, level=PRECIP_LEVEL, z=z, y=y, x=x), dest, timeout=15)


def prune_radar(max_age_h: int = 48):
    """Precipitation frames are only useful for a couple of days."""
    root = DATA / "precip"
    if not root.is_dir():
        return
    cut = (datetime.now(timezone.utc) - timedelta(hours=max_age_h)).strftime("%Y-%m-%dT%H%M%SZ")
    for d in root.iterdir():
        if d.is_dir() and d.name < cut:
            for f in d.rglob("*"):
                if f.is_file():
                    f.unlink(missing_ok=True)
            for sub in sorted((p for p in d.rglob("*") if p.is_dir()), key=lambda p: -len(p.parts)):
                sub.rmdir()
            d.rmdir()



# ── Aurora (NOAA SWPC OVATION) ───────────────────────────────────────────────
OVATION = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json"
_aurora: dict = {"at": 0.0, "data": None}


def parse_ovation(j: dict) -> dict:
    """The OVATION JSON as a compact grid: `grid[lat + 90][lon]` = probability 0-100, lon 0..359 east."""
    grid = [[0] * 360 for _ in range(181)]
    for row in j.get("coordinates") or []:
        try:
            lon, lat, p = int(row[0]) % 360, int(row[1]), int(row[2])
        except (TypeError, ValueError, IndexError):
            continue
        if -90 <= lat <= 90:
            grid[lat + 90][lon] = max(0, min(100, p))
    peak = max((max(r) for r in grid), default=0)
    return {"observed": j.get("Observation Time"), "forecast": j.get("Forecast Time"), "grid": grid, "peak": peak}


@router.get("/aurora")
async def aurora():
    """Where the aurora is likely in the next half hour (NOAA's 30-minute OVATION forecast), cached 5 minutes."""
    async with _lock:
        if _aurora["data"] and time.time() - _aurora["at"] < 300:
            return _aurora["data"]
        try:
            async with httpx.AsyncClient(timeout=15, headers=UA, event_hooks=GUARD_HOOKS) as c:
                r = await c.get(OVATION)
                r.raise_for_status()
                data = parse_ovation(r.json())
        except (httpx.HTTPError, ValueError) as e:
            if _aurora["data"]:
                return {**_aurora["data"], "stale": True}
            raise HTTPException(503, f"NOAA SWPC unreachable: {e.__class__.__name__}")
        data["fetched"] = int(time.time())
        _aurora.update(at=time.time(), data=data)
        return data
