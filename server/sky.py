"""Spacecraft over Shell:B's worlds.
  GET /api/sky/orbiters?body=moon|mars|mercury   ground tracks of the spacecraft orbiting that body, from JPL Horizons:
      the sub-spacecraft point (lat, lon) and altitude, every minute from 2 h ago to 4 h ahead. The browser interpolates.
  GET /api/sky/group?name=stations,visual          Earth satellites as TLEs (Celestrak) for satellite.js in the browser.
Both are cached on disk (data/sky/) so a page opened offline still shows the last known orbits.
"""
import asyncio
import json
import re
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/sky")

from weather import DATA, UA  # data/sky, shared with the TLE cache  # noqa: E402

AU_KM = 149_597_870.7
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"

# Horizons body codes and the spacecraft orbiting them. Craft without a current ephemeris (mission over, data not yet
# published) or not yet in orbit (range > 25 radii) are left out automatically, so this list can be generous.
BODIES = {
    "moon": ("301", [("-85", "LRO", "Lunar Reconnaissance Orbiter · NASA"), ("-152", "Chandrayaan-2", "Chandrayaan-2 orbiter · ISRO"),
                     ("-155", "Danuri", "Korea Pathfinder Lunar Orbiter · KARI")]),
    "mars": ("499", [("-74", "MRO", "Mars Reconnaissance Orbiter · NASA"), ("-53", "Mars Odyssey", "2001 Mars Odyssey · NASA"),
                     ("-41", "Mars Express", "Mars Express · ESA"), ("-143", "TGO", "ExoMars Trace Gas Orbiter · ESA/Roscosmos"),
                     ("-62", "Hope", "Emirates Mars Mission · MBRSC"), ("-202", "MAVEN", "MAVEN · NASA")]),
    "mercury": ("199", [("-121", "BepiColombo", "BepiColombo (MPO/Mio) · ESA/JAXA")]),
}
BACK, AHEAD, STEP = timedelta(hours=2), timedelta(hours=4), 1  # minutes
_lock = asyncio.Semaphore(2)  # Horizons asks clients not to hammer it


async def _track(client: httpx.AsyncClient, body: str, craft: str, start: datetime, stop: datetime):
    params = {"format": "json", "COMMAND": f"'{body}'", "CENTER": f"'500@{craft}'", "EPHEM_TYPE": "'OBSERVER'",
              "QUANTITIES": "'14,20'", "CSV_FORMAT": "'YES'", "OBJ_DATA": "'NO'", "ANG_FORMAT": "'DEG'",
              "START_TIME": f"'{start:%Y-%m-%d %H:%M}'", "STOP_TIME": f"'{stop:%Y-%m-%d %H:%M}'", "STEP_SIZE": f"'{STEP} m'"}
    async with _lock:
        r = await client.get(HORIZONS, params=params)
    r.raise_for_status()
    res = r.json().get("result", "")
    if "$$SOE" not in res:
        return None, None
    west = "West-longitude positive" in res.split("$$SOE")[0]
    m = re.search(r"Target radii\s*:\s*([\d.]+)", res)
    radius = float(m.group(1)) if m else None
    rows = []
    for line in res.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        p = [x.strip() for x in line.split(",")]
        try:
            t = datetime.strptime(p[0], "%Y-%b-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()
            lon, lat, rng = float(p[3]), float(p[4]), float(p[5]) * AU_KM
        except (ValueError, IndexError):
            continue
        lon = -lon if west else lon
        lon = ((lon + 180) % 360) - 180
        rows.append([int(t), round(lat, 4), round(lon, 4), round(rng - (radius or 0), 1)])
    return rows, radius


async def orbiters(body_id: str) -> dict:
    if body_id not in BODIES:
        return {"body": body_id, "craft": [], "fetched": time.time()}
    DATA.mkdir(parents=True, exist_ok=True)
    f = DATA / f"orbiters-{body_id}.json"
    saved = json.loads(f.read_text()) if f.exists() else None
    now = time.time()
    # refresh hourly; the window keeps 3 h of look-ahead even then
    if saved and now - saved["fetched"] < 3600 and "radius_km" in saved:
        return saved
    code, craft = BODIES[body_id]
    start = datetime.now(timezone.utc).replace(second=0, microsecond=0) - BACK
    try:
        async with httpx.AsyncClient(timeout=30, headers=UA) as c:
            got = await asyncio.gather(*(_track(c, code, cid, start, start + BACK + AHEAD) for cid, _, _ in craft), return_exceptions=True)
    except httpx.HTTPError as e:
        got = [e] * len(craft)
    out, body_radius = [], None
    for (cid, name, mission), g in zip(craft, got):
        if isinstance(g, BaseException) or not g[0]:
            continue
        rows, radius = g
        if radius and min(r[3] for r in rows) > 25 * radius:  # cruising nearby, not orbiting yet
            continue
        body_radius = body_radius or radius
        out.append({"id": cid, "name": name, "mission": mission, "track": rows})
    if not out and saved and any(isinstance(g, BaseException) for g in got):
        return {**saved, "stale": True}  # offline: last known tracks (the client says when they run out)
    data = {"body": body_id, "radius_km": body_radius, "craft": out, "fetched": now}
    f.write_text(json.dumps(data))
    return data


@router.get("/orbiters")
async def orbiters_route(body: str):
    return await orbiters(body.lower())


GROUPS = {"stations": "Space stations", "visual": "Brightest satellites", "gps-ops": "GPS", "geo": "Geostationary", "active": "All active satellites", "weather": "Weather satellites",
          "science": "Science satellites"}


async def _group(name: str) -> list[dict]:
    DATA.mkdir(parents=True, exist_ok=True)
    f = DATA / f"group-{name}.json"
    saved = json.loads(f.read_text()) if f.exists() else None
    if saved and time.time() - saved["fetched"] < 6 * 3600:
        return saved["sats"]
    try:
        async with httpx.AsyncClient(timeout=20, headers=UA) as c:
            r = await c.get("https://celestrak.org/NORAD/elements/gp.php", params={"GROUP": name, "FORMAT": "TLE"})
            r.raise_for_status()
        lines = [x.rstrip() for x in r.text.strip().splitlines()]
        sats = [{"name": lines[i].strip(), "norad": int(lines[i + 1][2:7]), "line1": lines[i + 1], "line2": lines[i + 2], "group": name}
                for i in range(0, len(lines) - 2, 3) if lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 ")]
        if not sats:
            raise ValueError("empty group")
        f.write_text(json.dumps({"fetched": time.time(), "sats": sats}))
        return sats
    except (httpx.HTTPError, ValueError):
        if saved:
            return saved["sats"]
        raise


@router.get("/group")
async def group_route(name: str = "stations,visual"):
    names = [n for n in name.split(",") if n in GROUPS]
    if not names:
        raise HTTPException(400, f"Groups: {', '.join(GROUPS)}")
    seen, out = set(), []
    for n in names:
        try:
            for s in await _group(n):
                if s["norad"] not in seen:
                    seen.add(s["norad"])
                    out.append(s)
        except (httpx.HTTPError, ValueError):
            continue
    if not out:
        raise HTTPException(502, "Couldn't fetch satellite elements from Celestrak.")
    return {"sats": out}
