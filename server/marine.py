"""Marine biology: species names and classification from WoRMS (the World Register of Marine Species), where a species
has been recorded from OBIS (the Ocean Biodiversity Information System), sea conditions from the Open-Meteo Marine API,
while the Worlds "Sea surface" layer draws NASA GIBS maps of the sea (temperature, anomaly, chlorophyll) through
earthview.py's tile proxy (its LAYERS entries marked "sea").

All are free public services without keys. Nothing personal is sent: a name, a place or a tile address. In a guest's
own Shell:B (cell) the requests go out through the host's filtered proxy (HTTPS_PROXY), which httpx picks up itself.

Agent tool `marine` (species, occurrences, checklist, ocean); routes under /api/marine for the Worlds app."""
import asyncio
import json
import math
import time

import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/marine")

WORMS = "https://www.marinespecies.org/rest"
OBIS = "https://api.obis.org/v3"
OPEN_METEO = "https://marine-api.open-meteo.com/v1/marine"
UA = {"User-Agent": "Shell:B marine (local assistant; https://github.com/EveAeternam/Shell-B)"}


_cache: dict[str, tuple[float, object]] = {}


async def _get_json(url: str, params: dict | None = None, ttl: float = 3600, timeout: float = 30):
    key = url + "?" + json.dumps(params or {}, sort_keys=True)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    async with httpx.AsyncClient(timeout=timeout, headers=UA, follow_redirects=True) as c:
        r = await c.get(url, params=params)
    if r.status_code == 204 or (r.status_code == 404 and url.startswith(WORMS)):
        data = None  # WoRMS answers "no match" with 204 (or 404 for an unknown id)
    else:
        r.raise_for_status()
        data = r.json()
    _cache[key] = (time.time(), data)
    if len(_cache) > 500:
        for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
            _cache.pop(k, None)
    return data


# ── WoRMS ───────────────────────────────────────────────────────────────────

async def find_species(q: str, limit: int = 8) -> list[dict]:
    """Exact matches first (scientific name, then a common name in any language), then fuzzy ones."""
    q = q.strip()
    if not q:
        return []
    out: list[dict] = []
    for url, params in ((f"{WORMS}/AphiaRecordsByName/{q}", {"like": "false", "marine_only": "false"}),
                        (f"{WORMS}/AphiaRecordsByVernacular/{q}", {"like": "false"}),
                        (f"{WORMS}/AphiaRecordsByName/{q}", {"like": "true", "marine_only": "false"}),
                        (f"{WORMS}/AphiaRecordsByVernacular/{q}", {"like": "true"})):
        try:
            rows = await _get_json(url, params) or []
        except httpx.HTTPError:
            rows = []
        for r in rows:
            aid = r.get("valid_AphiaID") or r.get("AphiaID")
            if aid and all(o["aphia"] != aid for o in out):
                out.append({"aphia": aid, "name": r.get("valid_name") or r.get("scientificname"),
                            "authority": r.get("valid_authority") or r.get("authority") or "", "rank": r.get("rank") or "",
                            "status": r.get("status") or "", "matched": r.get("scientificname")})
        if len(out) >= limit or (out and params.get("like") == "false"):
            break
    return out[:limit]


async def species_card(aphia: int, lang: str = "en") -> dict | None:
    rec = await _get_json(f"{WORMS}/AphiaRecordByAphiaID/{aphia}", ttl=86400)
    if not rec:
        return None
    cls, vern, syn = await asyncio.gather(
        _get_json(f"{WORMS}/AphiaClassificationByAphiaID/{aphia}", ttl=86400),
        _get_json(f"{WORMS}/AphiaVernacularsByAphiaID/{aphia}", ttl=86400),
        _get_json(f"{WORMS}/AphiaSynonymsByAphiaID/{aphia}", ttl=86400),
        return_exceptions=True)
    chain = []
    node = cls if isinstance(cls, dict) else None
    while node:
        if node.get("rank") and node.get("scientificname"):
            chain.append((node["rank"], node["scientificname"]))
        node = node.get("child")
    names: dict[str, list[str]] = {}
    for v in vern if isinstance(vern, list) else []:
        names.setdefault(v.get("language_code", ""), []).append(v.get("vernacular", ""))
    habitats = [h for h, k in (("marine", "isMarine"), ("brackish", "isBrackish"), ("freshwater", "isFreshwater"),
                               ("terrestrial", "isTerrestrial")) if rec.get(k)]
    return {
        "aphia": aphia, "name": rec.get("valid_name") or rec.get("scientificname"), "authority": rec.get("authority") or "",
        "rank": rec.get("rank"), "status": rec.get("status"), "extinct": bool(rec.get("isExtinct")), "habitats": habitats,
        "classification": chain, "common": {"en": names.get("eng", [])[:4], "fr": names.get("fra", [])[:4]},
        "synonyms": [s.get("scientificname") for s in (syn if isinstance(syn, list) else [])][:8],
        "url": f"https://www.marinespecies.org/aphia.php?p=taxdetails&id={aphia}",
    }


async def resolve(name_or_id) -> dict | None:
    """An AphiaID, or the best WoRMS match for a name."""
    s = str(name_or_id or "").strip()
    if s.isdigit():
        return {"aphia": int(s), "name": s}
    hits = await find_species(s, 1)
    return hits[0] if hits else None


# ── OBIS ────────────────────────────────────────────────────────────────────

def area_wkt(lat: float, lon: float, radius_km: float) -> str:
    """A box around a point, as OBIS wants WKT; clamped so it never wraps the poles."""
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(0.05, math.cos(math.radians(lat))))
    s, n = max(-89.9, lat - dlat), min(89.9, lat + dlat)
    w, e = max(-180.0, lon - dlon), min(180.0, lon + dlon)
    return f"POLYGON(({w:.4f} {s:.4f},{e:.4f} {s:.4f},{e:.4f} {n:.4f},{w:.4f} {n:.4f},{w:.4f} {s:.4f}))"


async def occurrence_grid(aphia: int, precision: int = 3, geometry: str = "") -> dict:
    params = {"taxonid": aphia}
    if geometry:
        params["geometry"] = geometry
    return await _get_json(f"{OBIS}/occurrence/grid/{max(2, min(precision, 5))}", params, ttl=86400, timeout=60) or {"type": "FeatureCollection", "features": []}


async def occurrence_stats(aphia: int, geometry: str = "") -> dict:
    params = {"taxonid": aphia}
    if geometry:
        params["geometry"] = geometry
    return await _get_json(f"{OBIS}/statistics", params, ttl=86400) or {}


async def checklist(geometry: str, taxon: int | None = None, limit: int = 25) -> dict:
    params = {"geometry": geometry, "size": max(1, min(limit, 100))}
    if taxon:
        params["taxonid"] = taxon
    return await _get_json(f"{OBIS}/checklist", params, ttl=86400, timeout=60) or {"total": 0, "results": []}


# ── sea conditions ──────────────────────────────────────────────────────────

CURRENT = ["sea_surface_temperature", "wave_height", "wave_direction", "wave_period", "swell_wave_height",
           "ocean_current_velocity", "ocean_current_direction"]
DAILY = ["wave_height_max", "wave_period_max", "wave_direction_dominant"]


async def ocean(lat: float, lon: float, days: int = 3) -> dict:
    params = {"latitude": round(lat, 3), "longitude": round(lon, 3), "current": ",".join(CURRENT), "daily": ",".join(DAILY),
              "hourly": "sea_surface_temperature", "forecast_days": max(1, min(days, 7)), "timezone": "auto"}
    d = await _get_json(OPEN_METEO, params, ttl=1800)
    cur = d.get("current") or {}
    hourly = d.get("hourly") or {}
    temps = [t for t in hourly.get("sea_surface_temperature") or [] if t is not None]
    days_out = []
    daily = d.get("daily") or {}
    for i, day in enumerate(daily.get("time") or []):
        days_out.append({"date": day, **{k: (daily.get(k) or [None] * (i + 1))[i] for k in DAILY}})
    return {"lat": d.get("latitude"), "lon": d.get("longitude"), "time": cur.get("time"),
            "current": {k: cur.get(k) for k in CURRENT}, "units": d.get("current_units") or {},
            "sst_range": [min(temps), max(temps)] if temps else None, "daily": days_out,
            "land": all(cur.get(k) is None for k in ("sea_surface_temperature", "wave_height"))}


COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
compass = lambda deg: COMPASS[round((deg % 360) / 22.5) % 16] if isinstance(deg, (int, float)) else "?"  # noqa: E731


@router.get("/species")
async def api_species(q: str = ""):
    try:
        return {"results": await find_species(q, 8)}
    except httpx.HTTPError as e:
        raise HTTPException(502, f"WoRMS: {e}")


@router.get("/grid")
async def api_grid(aphia: int, precision: int = 3):
    try:
        fc = await occurrence_grid(aphia, precision)
        stats = await occurrence_stats(aphia)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"OBIS: {e}")
    return {"grid": fc, "stats": stats}


@router.get("/checklist")
async def api_checklist(lat: float, lon: float, radius_km: float = 25, limit: int = 12):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or not 1 <= radius_km <= 500:
        raise HTTPException(400, "bad area")
    try:
        d = await checklist(area_wkt(lat, lon, radius_km), None, 60)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"OBIS: {e}")
    rows = [r for r in d.get("results") or [] if r.get("taxonRank") == "Species"][:max(1, min(limit, 40))]
    return {"total": d.get("total", 0), "radius_km": radius_km,
            "species": [{"name": r["scientificName"], "aphia": r.get("taxonID"), "group": r.get("class") or r.get("phylum") or r.get("kingdom"),
                         "family": r.get("family"), "records": r.get("records", 0)} for r in rows]}


@router.get("/ocean")
async def api_ocean(lat: float, lon: float):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "bad coordinates")
    try:
        return await ocean(lat, lon)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Open-Meteo: {e}")


# ── the agent tool ──────────────────────────────────────────────────────────

def _map_block(title: str, markers: list[dict], center=None, zoom=None) -> str:
    spec = {"title": title, "markers": markers}
    if center:
        spec["center"], spec["zoom"] = {"lat": center[0], "lon": center[1]}, zoom or 6
    return "```map\n" + json.dumps(spec, ensure_ascii=False) + "\n```"


def _fmt(v, unit="", nd=1):
    return "—" if v is None else f"{v:.{nd}f}{unit}"


async def marine_tool(args, ctx):
    from tools import ToolResult
    action = str(args.get("action") or "species").lower()
    fr = str(args.get("language") or "").lower().startswith("fr")
    try:
        if action == "ocean":
            lat, lon = float(args["lat"]), float(args["lon"])
            o = await ocean(lat, lon, int(args.get("days") or 3))
            if o["land"]:
                return ToolResult(f"No sea data at {lat:.3f}, {lon:.3f}: that point is on land or too close to the coast for the model. "
                                  "Move it a little offshore.", error=True)
            c = o["current"]
            lines = [f"Sea conditions at {o['lat']:.3f}, {o['lon']:.3f} ({o['time']} local, Open-Meteo Marine models):",
                     f"- Sea surface temperature: {_fmt(c['sea_surface_temperature'], ' °C')}"
                     + (f" (forecast range {o['sst_range'][0]:.1f}–{o['sst_range'][1]:.1f} °C)" if o["sst_range"] else ""),
                     f"- Waves: {_fmt(c['wave_height'], ' m')} from {compass(c['wave_direction'])}, period {_fmt(c['wave_period'], ' s')}; "
                     f"swell {_fmt(c['swell_wave_height'], ' m')}",
                     f"- Surface current: {_fmt(c['ocean_current_velocity'], ' km/h')} towards {compass(c['ocean_current_direction'])}"]
            for d in o["daily"]:
                lines.append(f"- {d['date']}: waves up to {_fmt(d['wave_height_max'], ' m')}, from {compass(d['wave_direction_dominant'])}")
            lines.append("Model output, not a measurement; values near the coast are coarse. Not for navigation.")
            return ToolResult("\n".join(lines))

        if action == "species":
            q = str(args.get("name") or args.get("query") or "")
            hits = await find_species(q, 6)
            if not hits:
                return ToolResult(f"WoRMS has no taxon matching “{q}”. Try the scientific name or another common name.", error=True)
            card = await species_card(hits[0]["aphia"])
            if not card:
                return ToolResult(f"WoRMS lookup failed for {hits[0]['aphia']}.", error=True)
            common = card["common"]["fr" if fr else "en"] or card["common"]["en"] or card["common"]["fr"]
            lines = [f"**{card['name']}** {card['authority']} · {card['rank']} · {card['status']}{' · extinct' if card['extinct'] else ''} · AphiaID {card['aphia']}"]
            if hits[0].get("matched") and hits[0]["matched"] != card["name"]:
                lines.append(f"(“{hits[0]['matched']}” is a synonym or match; the accepted name is above)")
            if common:
                lines.append("Common names: " + ", ".join(common))
            if card["habitats"]:
                lines.append("Habitats: " + ", ".join(card["habitats"]))
            if card["classification"]:
                lines.append("Classification: " + " › ".join(f"{n}" for r, n in card["classification"] if r in
                             ("Kingdom", "Phylum", "Class", "Order", "Family", "Genus", "Species")))
            if card["synonyms"]:
                lines.append("Synonyms: " + "; ".join(card["synonyms"]))
            lines.append(f"WoRMS: {card['url']}")
            if len(hits) > 1:
                lines.append("Other matches: " + "; ".join(f"{h['name']} ({h['rank']}, {h['aphia']})" for h in hits[1:]))
            return ToolResult("\n".join(lines))

        if action in ("occurrences", "occurrence", "records"):
            sp = await resolve(args.get("aphia") or args.get("name") or args.get("query"))
            if not sp:
                return ToolResult("Name a taxon (scientific or common name) or give its AphiaID.", error=True)
            geom = ""
            if args.get("lat") is not None and args.get("lon") is not None:
                geom = area_wkt(float(args["lat"]), float(args["lon"]), float(args.get("radius_km") or 100))
            stats, grid = await asyncio.gather(occurrence_stats(sp["aphia"], geom), occurrence_grid(sp["aphia"], 3 if not geom else 5, geom))
            n = stats.get("records") or 0
            if not n:
                return ToolResult(f"OBIS holds no records of {sp['name']}{' in that area' if geom else ''}.")
            cells = sorted(grid.get("features") or [], key=lambda f: -f["properties"].get("n", 0))
            markers = []
            for f in cells[:40]:
                ring = f["geometry"]["coordinates"][0]
                lo = sum(p[0] for p in ring[:4]) / 4
                la = sum(p[1] for p in ring[:4]) / 4
                markers.append({"lat": round(la, 3), "lon": round(lo, 3), "label": f"{f['properties']['n']:,} record{'' if f['properties']['n'] == 1 else 's'}"})
            yr = stats.get("yearrange") or []
            text = (f"OBIS: {n:,} occurrence records of {sp['name']} (AphiaID {sp['aphia']}){' within ' + str(args.get('radius_km') or 100) + ' km' if geom else ''}, "
                    f"{len(cells)} grid cells, from {stats.get('datasets', '?')} datasets"
                    + (f", years {yr[0]}–{yr[1]}" if len(yr) == 2 else "") + ".\n"
                    "Records are where someone looked and published, not the full range: absence of records is not absence of the species. "
                    "In Worlds, Layers → Marine life maps every record cell.\n\nBusiest cells, to paste as a map:\n"
                    + _map_block(f"{sp['name']} · OBIS records", markers))
            return ToolResult(text)

        if action == "checklist":
            lat, lon = float(args["lat"]), float(args["lon"])
            taxon = None
            if args.get("taxon"):
                t = await resolve(args["taxon"])
                taxon = t["aphia"] if t else None
                if not t:
                    return ToolResult(f"WoRMS has no taxon matching “{args['taxon']}”.", error=True)
            radius = float(args.get("radius_km") or 25)
            d = await checklist(area_wkt(lat, lon, radius), taxon, int(args.get("limit") or 25))
            rows = [r for r in d.get("results") or [] if r.get("taxonRank") == "Species"] or d.get("results") or []
            if not rows:
                return ToolResult(f"OBIS has no records within {radius:g} km of {lat:.3f}, {lon:.3f}{' for that taxon' if taxon else ''}.")
            body = "\n".join(f"- *{r['scientificName']}* ({r.get('class') or r.get('phylum') or r.get('kingdom', '')}"
                             f"{', ' + r['family'] if r.get('family') else ''}) · {r.get('records', 0):,} records" for r in rows)
            return ToolResult(f"OBIS checklist within {radius:g} km of {lat:.3f}, {lon:.3f}{' for ' + args['taxon'] if taxon else ''}: "
                              f"{d.get('total', len(rows)):,} taxa recorded; the most recorded:\n{body}\n"
                              "Counts reflect survey effort as much as abundance.")
        return ToolResult(f"Unknown action {action}: use species, occurrences, checklist or ocean.", error=True)
    except KeyError as e:
        return ToolResult(f"marine {action} needs {e}.", error=True)
    except (TypeError, ValueError) as e:
        return ToolResult(f"Bad arguments for marine {action}: {e}", error=True)
    except httpx.HTTPError as e:
        return ToolResult(f"The marine data service didn't answer ({type(e).__name__}: {e}). Try again shortly.", error=True)


def register():
    from tools import TOOLS, _fn
    TOOLS["marine"] = {
        "fn": marine_tool, "service": None,
        "ui": {"displayName": "Marine biology", "icon": "Fish", "category": "knowledge",
               "description": "WoRMS taxonomy, OBIS occurrence records and checklists, and sea conditions (marine.py)"},
        "schema": _fn(
            "marine",
            "Marine biology data from public scientific services. action=species: WoRMS accepted name, authority, AphiaID, "
            "classification, habitats, common names (English/French) and synonyms for a scientific or common name. "
            "action=occurrences: OBIS occurrence records of a taxon (name or aphia), worldwide or within radius_km of lat/lon, "
            "with year range and a map of the busiest cells. action=checklist: taxa recorded within radius_km (default 25) of "
            "lat/lon, optionally only inside a higher taxon (taxon, e.g. Cetacea, Elasmobranchii, Scleractinia). action=ocean: "
            "current sea surface temperature, waves, swell, surface current and sea level at lat/lon with a few days' wave forecast. "
            "Results may include a ```map``` block to paste into the reply.",
            {"action": {"type": "string", "enum": ["species", "occurrences", "checklist", "ocean"]},
             "name": {"type": "string", "description": "scientific or common name"}, "aphia": {"type": "integer"},
             "taxon": {"type": "string", "description": "higher taxon to filter a checklist"},
             "lat": {"type": "number"}, "lon": {"type": "number"}, "radius_km": {"type": "number"},
             "days": {"type": "integer"}, "limit": {"type": "integer"},
             "language": {"type": "string", "description": "fr to prefer French common names"}},
            ["action"]),
    }
