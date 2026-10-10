"""Weather and sky data for chat cards. Both are free, keyless services; only the place name or coordinates leave the Spark.
  GET /api/weather?place=Orlando  or  ?lat=&lon=   current conditions, next 24 h, 7 days (Open-Meteo)
  GET /api/sky/tle?sat=iss                          orbital elements (Celestrak TLE), cached on disk so the
                                                    satellite card keeps working offline: the browser propagates
                                                    the orbit itself with satellite.js
The `weather` tool wraps /api/weather for agents.
"""
import asyncio
import json
import re
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException

from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api")

DATA = Path(__file__).resolve().parent.parent / "data" / "sky"
UA = {"User-Agent": "Shell:B personal assistant (self-hosted)"}
_cache: dict[str, tuple[float, object]] = {}


async def _get_json(url: str, params: dict | None = None):
    async with httpx.AsyncClient(timeout=12, headers=UA, follow_redirects=True) as c:
        r = await c.get(url, params=params)
        r.raise_for_status()
        return r.json()


async def _cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    v = await fn()
    _cache[key] = (time.time(), v)
    if len(_cache) > 300:
        for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:150]:
            _cache.pop(k, None)
    return v


# ── weather ─────────────────────────────────────────────────────────────────

async def geocode(name: str) -> dict:
    name = name.strip()
    # "Orlando, FL" / "Paris, France": search the first part, then prefer results whose region or country matches the rest
    head, _, rest = name.partition(",")

    async def get():
        d = await _get_json("https://geocoding-api.open-meteo.com/v1/search", {"name": head.strip(), "count": 10, "language": "en"})
        res = d.get("results") or []
        if not res:
            raise HTTPException(404, f"Couldn't find a place called “{name}”.")
        hint = rest.split(",")[0].strip().lower()  # "Orlando, Florida, United States" → florida
        if hint:
            pick = [x for x in res if hint in " ".join(str(x.get(k, "")) for k in ("admin1", "country", "country_code")).lower()
                    or hint == str(x.get("admin1", ""))[:2].lower()]
            res = pick or res
        x = res[0]
        return {"name": x["name"], "region": x.get("admin1"), "country": x.get("country"), "countryCode": x.get("country_code"),
                "lat": x["latitude"], "lon": x["longitude"], "tz": x.get("timezone")}
    return await _cached(f"geo:{name.lower()}", 86400, get)


async def forecast(lat: float, lon: float) -> dict:
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "lat/lon out of range")

    async def get():
        return await _get_json("https://api.open-meteo.com/v1/forecast", {
            "latitude": round(lat, 3), "longitude": round(lon, 3), "timezone": "auto", "forecast_days": 7, "forecast_hours": 25,
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,"
                       "wind_direction_10m,is_day,precipitation,pressure_msl,cloud_cover",
            "hourly": "temperature_2m,precipitation_probability,weather_code,is_day",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,"
                     "sunrise,sunset,uv_index_max,wind_speed_10m_max",
        })
    return await _cached(f"wx:{round(lat, 2)}:{round(lon, 2)}", 600, get)


async def weather_for(place: str | None, lat: float | None, lon: float | None) -> dict:
    try:
        if place and (lat is None or lon is None):
            loc = await geocode(place)
        elif lat is not None and lon is not None:
            loc = {"name": place or f"{lat:.2f}, {lon:.2f}", "lat": lat, "lon": lon}
        else:
            raise HTTPException(400, "Give a place name or lat and lon")
        return {"place": loc, "forecast": await forecast(loc["lat"], loc["lon"])}
    except httpx.HTTPError as e:
        raise HTTPException(502, f"The weather service didn't answer ({type(e).__name__}); weather needs the internet.")


@router.get("/weather")
async def weather_route(place: str | None = None, lat: float | None = None, lon: float | None = None):
    return await weather_for(place, lat, lon)


WMO = {0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
       51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
       61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
       71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
       82: "violent showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorms",
       96: "thunderstorms with hail", 99: "thunderstorms with heavy hail"}


async def weather_tool(args, ctx):
    place = str(args.get("place", "")).strip()
    try:
        d = await weather_for(place, None, None)
    except HTTPException as e:
        return ToolResult(str(e.detail), error=True)
    p, f = d["place"], d["forecast"]
    c, dl = f.get("current", {}), f.get("daily", {})
    where = ", ".join(x for x in (p["name"], p.get("region"), p.get("country")) if x)
    lines = [f"{where} ({p['lat']:.2f}, {p['lon']:.2f}), local time {c.get('time', '?')}:",
             f"Now {c.get('temperature_2m')}°C (feels {c.get('apparent_temperature')}°C), {WMO.get(c.get('weather_code'), 'unknown')}, "
             f"humidity {c.get('relative_humidity_2m')}%, wind {c.get('wind_speed_10m')} km/h gusting {c.get('wind_gusts_10m')} km/h."]
    for i, day in enumerate(dl.get("time", [])[:7]):
        lines.append(f"{day}: {WMO.get(dl['weather_code'][i], '?')}, {dl['temperature_2m_min'][i]}–{dl['temperature_2m_max'][i]}°C, "
                     f"rain chance {dl['precipitation_probability_max'][i]}%, UV {dl['uv_index_max'][i]}")
    lines.append(f"Show it with:\n```weather\n{json.dumps({'place': where})}\n```\n"
                 "Give temperatures in the user's usual units (the card converts them itself).")
    return ToolResult("\n".join(lines), {"weather": where})


# ── places (geocoding) ─────────────────────────────────────────────────────
# Nominatim (OpenStreetMap) knows landmarks and addresses; its policy is ≤ 1 request/s with a real User-Agent, so calls
# are serialised and cached for a day. Open-Meteo's geocoder (towns only) is the fallback.

_nominatim_lock = asyncio.Lock()
_nominatim_last = 0.0


async def places(q: str, limit: int = 5) -> list[dict]:
    q = q.strip()
    if not q:
        raise HTTPException(400, "Give a place to look up")

    async def get():
        global _nominatim_last
        out: list[dict] = []
        try:
            async with _nominatim_lock:
                wait = _nominatim_last + 1.1 - time.time()
                if wait > 0:
                    await asyncio.sleep(wait)
                _nominatim_last = time.time()
                rows = await _get_json("https://nominatim.openstreetmap.org/search",
                                       {"q": q, "format": "jsonv2", "limit": limit, "addressdetails": 1})
            for r in rows:
                a = r.get("address") or {}
                out.append({"name": r.get("name") or r["display_name"].split(",")[0], "full": r["display_name"],
                            "lat": float(r["lat"]), "lon": float(r["lon"]), "type": r.get("addresstype") or r.get("type"),
                            "region": a.get("state"), "country": a.get("country"),
                            "bbox": [float(x) for x in r["boundingbox"]] if r.get("boundingbox") else None})
        except (httpx.HTTPError, ValueError, KeyError):
            out = []
        if not out:
            try:
                d = await _get_json("https://geocoding-api.open-meteo.com/v1/search", {"name": q.split(",")[0], "count": limit, "language": "en"})
                out = [{"name": x["name"], "full": ", ".join(v for v in (x["name"], x.get("admin1"), x.get("country")) if v),
                        "lat": x["latitude"], "lon": x["longitude"], "type": "place", "region": x.get("admin1"),
                        "country": x.get("country"), "bbox": None} for x in d.get("results") or []]
            except httpx.HTTPError as e:
                raise HTTPException(502, f"No geocoder answered ({type(e).__name__}); place lookup needs the internet.")
        return out
    return await _cached(f"places:{q.lower()}:{limit}", 86400, get)


@router.get("/geocode")
async def geocode_route(q: str, limit: int = 5):
    import places as offline  # local regions first, then Nominatim
    return {"query": q, "results": await offline.search(q, max(1, min(10, limit)))}


async def geocode_tool(args, ctx):
    q = str(args.get("query", "")).strip()
    import places as offline  # local regions first, then Nominatim
    try:
        res = await offline.search(q)
    except HTTPException as e:
        return ToolResult(str(e.detail), error=True)
    if not res:
        return ToolResult(f"No place found for “{q}”. Try a more specific name, or add the city or country.", error=True)
    lines = [f"{i + 1}. {r['full']} — lat {r['lat']:.5f}, lon {r['lon']:.5f} ({r['type']})" for i, r in enumerate(res)]
    return ToolResult(f"Matches for “{q}” (OpenStreetMap{', offline index' if res[0].get('offline') else ''}):\n" + "\n".join(lines) +
                      "\nUse these exact coordinates in ```map``` markers. If several match, pick the one the user means "
                      "or ask.", {"geocode": q})


# ── satellites ──────────────────────────────────────────────────────────────

SATS = {"iss": (25544, "International Space Station"), "tiangong": (48274, "Tiangong"), "hubble": (20580, "Hubble Space Telescope"),
        "css": (48274, "Tiangong")}


@router.get("/sky/tle")
async def tle(sat: str = "iss"):
    key = sat.strip().lower()
    if key in SATS:
        norad, label = SATS[key]
    elif re.fullmatch(r"\d{1,6}", key):
        norad, label = int(key), None
    else:
        raise HTTPException(400, f"Unknown satellite “{sat}”. Use iss, tiangong, hubble or a NORAD catalogue number.")
    DATA.mkdir(parents=True, exist_ok=True)
    f = DATA / f"{norad}.json"
    saved = json.loads(f.read_text()) if f.exists() else None
    if saved and time.time() - saved["fetched"] < 6 * 3600:
        return saved
    try:
        async with httpx.AsyncClient(timeout=12, headers=UA) as c:
            r = await c.get("https://celestrak.org/NORAD/elements/gp.php", params={"CATNR": norad, "FORMAT": "TLE"})
            r.raise_for_status()
        lines = [x.rstrip() for x in r.text.strip().splitlines()]
        if len(lines) < 3 or not lines[1].startswith("1 ") or not lines[2].startswith("2 "):
            raise ValueError("no TLE in the reply")
        out = {"norad": norad, "name": label or lines[0].strip(), "line1": lines[1], "line2": lines[2], "fetched": time.time()}
        f.write_text(json.dumps(out))
        return out
    except (httpx.HTTPError, ValueError) as e:
        if saved:  # offline: elements a few days old still place the ISS within tens of km
            return {**saved, "stale": True}
        raise HTTPException(502, f"Couldn't fetch orbital elements ({type(e).__name__}).")


def register():
    TOOLS["geocode"] = {
        "fn": geocode_tool, "service": None, "scope": "global", "auto": "when the agent has Web Search",
        "ui": {"displayName": "Place Lookup", "icon": "MapPin", "category": "web",
               "description": "Finds coordinates for places, landmarks and addresses (OpenStreetMap Nominatim)."},
        "schema": _fn("geocode", "Look up the exact coordinates of a place, landmark or address. Use it before putting "
                      "markers on a ```map``` instead of guessing coordinates.",
                      {"query": {"type": "string", "description": "e.g. \"Kennedy Space Center\", \"Kyoto\", \"10 Downing St, London\""}},
                      ["query"]),
    }
    TOOLS["weather"] = {
        "fn": weather_tool, "service": None, "scope": "global", "auto": "when the agent has Web Search",
        "ui": {"displayName": "Weather", "icon": "CloudSun", "category": "web",
               "description": "Current conditions and a 7-day forecast for any place (Open-Meteo)."},
        "schema": _fn("weather", "Current weather and 7-day forecast for a place. Then show it with a ```weather``` block "
                      "(the result gives the exact block).",
                      {"place": {"type": "string", "description": "City or place, e.g. \"Orlando, FL\" or \"Kyoto\""}}, ["place"]),
    }
