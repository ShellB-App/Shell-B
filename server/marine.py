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
import re
import time

import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/marine")

WORMS = "https://www.marinespecies.org/rest"
OBIS = "https://api.obis.org/v3"
OPEN_METEO = "https://marine-api.open-meteo.com/v1/marine"
UA = {"User-Agent": "Shell:B marine (local assistant; https://github.com/ShellB-App/Shell-B)"}


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
    cls, vern, syn, attrs = await asyncio.gather(
        _get_json(f"{WORMS}/AphiaClassificationByAphiaID/{aphia}", ttl=86400),
        _get_json(f"{WORMS}/AphiaVernacularsByAphiaID/{aphia}", ttl=86400),
        _get_json(f"{WORMS}/AphiaSynonymsByAphiaID/{aphia}", ttl=86400),
        _get_json(f"{WORMS}/AphiaAttributesByAphiaID/{aphia}", {"include_inherited": "false"}, ttl=86400),
        return_exceptions=True)
    importance = list(dict.fromkeys(a.get("measurementValue") for a in (attrs if isinstance(attrs, list) else [])
                                    if a.get("measurementType") == "Species importance to society" and a.get("measurementValue")))
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
        "synonyms": [s.get("scientificname") for s in (syn if isinstance(syn, list) else [])][:8], "importance": importance,
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


# ── species lists, survey tables, literature ───────────────────────────────

MATCH_BATCH = 50
NAME_COLS = ("scientificname", "scientific_name", "scientific name", "species", "taxon", "taxa", "name", "espece", "espèce", "nom")
COUNT_COLS = ("count", "abundance", "individuals", "n", "number", "total", "effectif", "abondance", "nombre")
SITE_COLS = ("site", "station", "sample", "transect", "quadrat", "plot", "locality", "lieu")


def read_table(path) -> list[dict]:
    """Rows of a CSV/TSV/TXT or the first sheet of an XLSX, as dicts keyed by header (a headerless one-column list gets
    the header "name")."""
    import csv
    from pathlib import Path
    p = Path(path)
    if p.suffix.lower() in (".xlsx", ".xlsm"):
        import openpyxl
        ws = openpyxl.load_workbook(p, read_only=True, data_only=True).worksheets[0]
        rows = [["" if v is None else str(v).strip() for v in r] for r in ws.iter_rows(values_only=True)]
    else:
        text = p.read_text(encoding="utf-8-sig", errors="replace")
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        rows = [[c.strip() for c in r] for r in csv.reader(text.splitlines(), dialect)]
    rows = [r for r in rows if any(r)]
    if not rows:
        return []
    head = [h.strip() for h in rows[0]]
    if len(head) == 1 and _fold_col(head[0]) not in NAME_COLS:
        return [{"name": r[0]} for r in rows if r and r[0]]
    return [dict(zip(head, r + [""] * (len(head) - len(r)))) for r in rows[1:]]


def _fold_col(s: str) -> str:
    return s.strip().lower().replace("-", "_")


def pick_column(rows: list[dict], wanted: str, candidates: tuple) -> str | None:
    if not rows:
        return None
    cols = list(rows[0])
    if wanted:
        for c in cols:
            if _fold_col(c) == _fold_col(wanted):
                return c
        return None
    for cand in candidates:
        for c in cols:
            if _fold_col(c) == cand:
                return c
    return None


async def match_names(names: list[str]) -> list[dict]:
    """WoRMS taxon match for each name, in order: exact, phonetic or near matches, with the accepted name."""
    out: list[dict] = []
    uniq = list(dict.fromkeys(n.strip() for n in names if n and n.strip()))
    found: dict[str, dict] = {}
    for i in range(0, len(uniq), MATCH_BATCH):
        batch = uniq[i:i + MATCH_BATCH]
        params = [("scientificnames[]", n) for n in batch] + [("marine_only", "false")]
        async with httpx.AsyncClient(timeout=60, headers=UA) as c:
            r = await c.get(f"{WORMS}/AphiaRecordsByMatchNames", params=params)
        groups = r.json() if r.status_code == 200 else [[] for _ in batch]
        for name, grp in zip(batch, groups):
            grp = grp or []
            best = next((g for g in grp if g.get("status") == "accepted"), grp[0] if grp else None)
            found[name] = {
                "input": name, "match_type": best.get("match_type") if best else "none",
                "matched_name": best.get("scientificname", "") if best else "", "status": best.get("status", "") if best else "",
                "accepted_name": (best.get("valid_name") or "") if best else "", "aphia_id": (best.get("valid_AphiaID") or "") if best else "",
                "rank": best.get("rank", "") if best else "", "authority": (best.get("valid_authority") or "") if best else "",
                "ambiguous": len({g.get("valid_AphiaID") for g in grp}) > 1,
            }
    for n in names:
        if n and n.strip():
            out.append(found[n.strip()])
    return out


def diversity(counts: dict[str, float]) -> dict:
    """Richness, abundance, Shannon H' (natural log), Pielou J', Gini-Simpson 1-D, inverse Simpson and Chao1."""
    xs = [v for v in counts.values() if v > 0]
    S, N = len(xs), sum(xs)
    if not S:
        return {"S": 0, "N": 0}
    ps = [x / N for x in xs]
    H = -sum(p * math.log(p) for p in ps)
    D = sum(p * p for p in ps)
    ints = all(float(x).is_integer() for x in xs)
    f1 = sum(1 for x in xs if x == 1)
    f2 = sum(1 for x in xs if x == 2)
    out = {"S": S, "N": round(N, 3), "shannon": round(H, 4), "pielou": round(H / math.log(S), 4) if S > 1 else None,
           "simpson": round(1 - D, 4), "inv_simpson": round(1 / D, 3), "singletons": f1, "doubletons": f2}
    out["chao1"] = round(S + f1 * (f1 - 1) / (2 * (f2 + 1)), 2) if ints else None  # bias-corrected; needs counts of individuals
    return out


async def literature(q: str, since: int = 0, oa_only: bool = False, limit: int = 8) -> dict:
    flt = []
    if since:
        flt.append(f"from_publication_date:{since}-01-01")
    if oa_only:
        flt.append("is_oa:true")
    params = {"search": q, "per-page": max(1, min(limit, 20)), "sort": "relevance_score:desc",
              "select": "title,publication_year,doi,cited_by_count,primary_location,open_access,authorships,type"}
    if flt:
        params["filter"] = ",".join(flt)
    return await _get_json("https://api.openalex.org/works", params, ttl=86400) or {}


def _write_csv(ctx, name: str, rows: list[dict]) -> str:
    """Save rows as a CSV in the chat's /work folder; returns its /work path."""
    import csv
    from doc_tools import _work_root, display_path
    root = _work_root(ctx)
    dest = root / name
    with dest.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    return display_path(ctx, dest)


def _stem(path: str) -> str:
    from pathlib import Path
    return re.sub(r"[^A-Za-z0-9_-]+", "_", Path(path).stem)[:40] or "species"


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
            if card["importance"]:
                lines.append("Listed in (WoRMS): " + ", ".join(card["importance"]))
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
        if action == "match":
            from doc_tools import resolve as work_path
            names = [str(n) for n in (args.get("names") or []) if str(n).strip()]
            src = ""
            if args.get("file"):
                src = str(args["file"])
                rows = read_table(work_path(ctx, src))
                col = pick_column(rows, str(args.get("column") or ""), NAME_COLS) or (list(rows[0])[0] if rows else None)
                if not col:
                    return ToolResult(f"No species column found in {src}; say which with column.", error=True)
                names = [r.get(col, "") for r in rows]
            if not names:
                return ToolResult("Give names (a list) or file (a CSV/TSV/TXT/XLSX in /work) to match.", error=True)
            if len(names) > 2000:
                return ToolResult("That's more than 2,000 names; split the list.", error=True)
            res = await match_names(names)
            out = _write_csv(ctx, f"{_stem(src or 'species')}_worms.csv", res)
            exact = sum(1 for r in res if r["match_type"] == "exact" and r["status"] == "accepted")
            issues = [r for r in res if not (r["match_type"] == "exact" and r["status"] == "accepted")]
            lines = [f"WoRMS taxon match for {len(res)} names: {exact} exact and accepted, {len(issues)} to look at. Full table: {out}"]
            for r in issues[:40]:
                if r["match_type"] == "none":
                    lines.append(f"- “{r['input']}”: no match in WoRMS")
                else:
                    why = [r["match_type"].replace("_", " ") + " match" if r["match_type"] != "exact" else "",
                           f"{r['status']}" if r["status"] != "accepted" else "", "several taxa share this name" if r["ambiguous"] else ""]
                    lines.append(f"- “{r['input']}” → *{r['accepted_name']}* {r['authority']} ({', '.join(w for w in why if w)}; matched “{r['matched_name']}”)")
            if len(issues) > 40:
                lines.append(f"… and {len(issues) - 40} more in the CSV.")
            return ToolResult("\n".join(lines))

        if action == "diversity":
            from doc_tools import resolve as work_path
            groups: dict[str, dict[str, float]] = {}
            if args.get("counts"):
                groups["all"] = {str(k): float(v) for k, v in dict(args["counts"]).items()}
                src = "counts"
            else:
                src = str(args.get("file") or "")
                if not src:
                    return ToolResult("Give file (a survey table in /work) or counts ({species: count}).", error=True)
                rows = read_table(work_path(ctx, src))
                sp = pick_column(rows, str(args.get("column") or ""), NAME_COLS)
                cnt = pick_column(rows, str(args.get("count_column") or ""), COUNT_COLS)
                site = pick_column(rows, str(args.get("site_column") or ""), SITE_COLS)
                if not sp:
                    return ToolResult(f"No species column found in {src}; name it with column. Columns: {', '.join(rows[0]) if rows else 'none'}.", error=True)
                for r in rows:
                    name = (r.get(sp) or "").strip()
                    if not name:
                        continue
                    try:
                        n = float(str(r.get(cnt, "1") if cnt else "1").replace(",", ".") or 0)
                    except ValueError:
                        continue
                    g = groups.setdefault((r.get(site) or "").strip() or "all" if site else "all", {})
                    g[name] = g.get(name, 0) + n
            table = [{"site": k, **diversity(v)} for k, v in groups.items()]
            if len(groups) > 1:
                pooled: dict[str, float] = {}
                for v in groups.values():
                    for k, n in v.items():
                        pooled[k] = pooled.get(k, 0) + n
                table.append({"site": "ALL (pooled)", **diversity(pooled)})
            out = _write_csv(ctx, f"{_stem(src)}_diversity.csv", table)
            head = "| site | S | N | Shannon H′ | Pielou J′ | Simpson 1−D | 1/D | Chao1 |\n|---|---|---|---|---|---|---|---|"
            body = "\n".join(f"| {t['site']} | {t['S']} | {t.get('N')} | {t.get('shannon', '—')} | {t.get('pielou') or '—'} | "
                             f"{t.get('simpson', '—')} | {t.get('inv_simpson', '—')} | {t.get('chao1') or '—'} |" for t in table)
            return ToolResult(f"Diversity from {src} ({len(groups)} site(s)); natural-log Shannon, bias-corrected Chao1 "
                              f"(only for whole-number counts). Saved: {out}\n\n{head}\n{body}\n\n"
                              "Names were taken as written: run action match first to merge synonyms and misspellings.")

        if action == "literature":
            q = str(args.get("query") or args.get("name") or "").strip()
            if not q:
                return ToolResult("Give a query.", error=True)
            d = await literature(q, int(args.get("since") or 0), bool(args.get("open_access")), int(args.get("limit") or 8))
            works = d.get("results") or []
            if not works:
                return ToolResult(f"OpenAlex found nothing for “{q}”.")
            lines = [f"OpenAlex: {d.get('meta', {}).get('count', len(works)):,} works match “{q}”; most relevant:"]
            for w in works:
                au = [a.get("author", {}).get("display_name", "") for a in (w.get("authorships") or [])]
                who = (au[0] + (" et al." if len(au) > 2 else f" & {au[1]}" if len(au) == 2 else "")) if au else "?"
                venue = ((w.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
                oa = (w.get("open_access") or {}).get("oa_url") or ""
                lines.append(f"- {who} ({w.get('publication_year')}). {w.get('title')}.{' *' + venue + '*.' if venue else ''} Cited {w.get('cited_by_count', 0)}×."
                             f"{' ' + w['doi'] if w.get('doi') else ''}{' · open access: ' + oa if oa else ''}")
            lines.append("Read promising ones with web_fetch or read_document (open-access PDFs) before citing them.")
            return ToolResult("\n".join(lines))

        if action == "verify":
            cands = [str(c) for c in (args.get("candidates") or []) if str(c).strip()][:8]
            if not cands:
                return ToolResult("Give candidates: the species you think it might be.", error=True)
            lat, lon = float(args["lat"]), float(args["lon"])
            radius = float(args.get("radius_km") or 200)
            geom = area_wkt(lat, lon, radius)
            lines = [f"Plausibility near {lat:.3f}, {lon:.3f} (OBIS records within {radius:g} km):"]
            for cand in cands:
                sp = await resolve(cand)
                if not sp:
                    lines.append(f"- {cand}: not in WoRMS (check the spelling)")
                    continue
                near, world = await asyncio.gather(occurrence_stats(sp["aphia"], geom), occurrence_stats(sp["aphia"]))
                n, w = near.get("records") or 0, world.get("records") or 0
                verdict = "recorded nearby" if n else "recorded elsewhere, not here" if w else "no OBIS records at all"
                lines.append(f"- *{sp['name']}*{' (for “' + cand + '”)' if sp['name'].lower() != cand.lower() else ''}: {verdict}"
                             f" ({n:,} nearby, {w:,} worldwide)")
            lines.append("Records reflect survey effort; a missing record lowers the odds but doesn't rule a species out.")
            return ToolResult("\n".join(lines))

        return ToolResult(f"Unknown action {action}: use species, occurrences, checklist, ocean, match, diversity, literature or verify.", error=True)
    except KeyError as e:
        return ToolResult(f"marine {action} needs {e}.", error=True)
    except (FileNotFoundError, OSError) as e:
        return ToolResult(f"Couldn't read that file: {e}", error=True)
    except (TypeError, ValueError) as e:
        return ToolResult(f"Bad arguments for marine {action}: {e}", error=True)
    except httpx.HTTPError as e:
        return ToolResult(f"The marine data service didn't answer ({type(e).__name__}: {e}). Try again shortly.", error=True)


def register():
    from tools import TOOLS, _fn
    TOOLS["marine"] = {
        "fn": marine_tool, "service": None,
        "ui": {"displayName": "Marine biology", "icon": "Fish", "category": "knowledge",
               "description": "WoRMS taxonomy and name matching, OBIS records and checklists, survey diversity, literature, sea conditions (marine.py)"},
        "schema": _fn(
            "marine",
            "Marine biology data from public scientific services. action=species: WoRMS accepted name, authority, AphiaID, "
            "classification, habitats, common names (English/French) and synonyms for a scientific or common name. "
            "action=occurrences: OBIS occurrence records of a taxon (name or aphia), worldwide or within radius_km of lat/lon, "
            "with year range and a map of the busiest cells. action=checklist: taxa recorded within radius_km (default 25) of "
            "lat/lon, optionally only inside a higher taxon (taxon, e.g. Cetacea, Elasmobranchii, Scleractinia). action=ocean: "
            "current sea surface temperature, waves, swell and surface current at lat/lon with a few days' wave forecast. "
            "action=match: check a species list against WoRMS (names, or file = a CSV/TSV/TXT/XLSX in /work, column optional): "
            "misspellings, unaccepted names and accepted replacements, saved as a CSV in /work. action=diversity: richness, "
            "Shannon, Pielou, Simpson and Chao1 per site from a survey table (file, with column/count_column/site_column if not "
            "detected) or counts {species: n}, saved as a CSV. action=literature: scientific papers from OpenAlex (query, since "
            "year, open_access). action=verify: for a photo or sighting ID, whether each of candidates has been recorded near "
            "lat/lon (radius_km, default 200). Results may include a ```map``` block to paste into the reply.",
            {"action": {"type": "string", "enum": ["species", "occurrences", "checklist", "ocean", "match", "diversity", "literature", "verify"]},
             "names": {"type": "array", "items": {"type": "string"}}, "candidates": {"type": "array", "items": {"type": "string"}},
             "file": {"type": "string", "description": "a table in /work"}, "column": {"type": "string"},
             "count_column": {"type": "string"}, "site_column": {"type": "string"},
             "counts": {"type": "object", "description": "species → count"}, "query": {"type": "string"},
             "since": {"type": "integer"}, "open_access": {"type": "boolean"},
             "name": {"type": "string", "description": "scientific or common name"}, "aphia": {"type": "integer"},
             "taxon": {"type": "string", "description": "higher taxon to filter a checklist"},
             "lat": {"type": "number"}, "lon": {"type": "number"}, "radius_km": {"type": "number"},
             "days": {"type": "integer"}, "limit": {"type": "integer"},
             "language": {"type": "string", "description": "fr to prefer French common names"}},
            ["action"]),
    }
