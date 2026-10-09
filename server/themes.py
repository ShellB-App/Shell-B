"""Custom themes: Shell:B designs a UI theme in chat (design_theme) and it joins the picker in Settings → General.

A theme is data, never CSS: a palette, two fonts from a fixed list, a shape, a backdrop (sky gradient, glows, stars, a
horizon silhouette) and a particle layer. ui/src/themes/custom.ts turns it into the stylesheet. Everything is checked
here: colours must be plain hex, choices come from fixed lists, and text colours are nudged until they meet WCAG AA
on their background, so a model can't break the UI or slip anything into the page.
Stored in kv "custom_themes", newest first.
"""
import json
import re
import time
import uuid

from fastapi import APIRouter, HTTPException

import db
from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api/themes")
KEY, MAX_THEMES = "custom_themes", 24

FONTS = ("inter", "barlow", "barlow-condensed", "shippori-mincho", "josefin-sans", "jetbrains-mono", "georgia",
         "cormorant-garamond", "sora", "syncopate", "outfit", "zen-maru-gothic")
SHAPES = ("soft", "hard", "round")
HORIZONS = ("none", "forest", "mountains", "floating", "waves", "city", "seafloor", "dunes", "snowpines", "hills")
PARTICLES = ("none", "fireflies", "petals", "leaves", "woodsprites", "snow", "embers", "bubbles", "bokeh", "sand", "rain", "abyss", "aurora")
HEX = re.compile(r"^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")

# the palette keys, what each is for, and a fallback per mode
PALETTE = {
    "bg": ("page background", "#0f1117", "#f7f5f0"),
    "panel": ("sidebar and cards", "#161a22", "#efebe3"),
    "raised": ("inputs, chips, raised surfaces", "#1e2330", "#e6e1d8"),
    "hover": ("hover and selected rows", "#262c3b", "#ddd7cc"),
    "code": ("code blocks", "#0b0d12", "#f3f0ea"),
    "text": ("body text", "#eceae4", "#1b1a17"),
    "text2": ("secondary text", "#a8a69f", "#57544e"),
    "muted": ("muted labels and timestamps", "#8b8982", "#75716a"),
    "accent": ("primary buttons, links, focus", "#d9774a", "#b5532f"),
    "brand": ("logo and secondary highlights", "#8b9cff", "#4f5bd5"),
    "line": ("borders (drawn translucent)", "#ffffff", "#000000"),
}

GUIDE = ("- design_theme creates or revises a custom Shell:B UI theme from the user's description and shows it with a "
         "```theme``` card they can apply. Design it like a real art director: pick a direction, a restrained palette "
         "(60% surfaces, 30% structure, 10% accent), fonts and particles that fit it.")


def _hex(v, fallback: str) -> str:
    m = HEX.match(str(v or "").strip())
    if not m:
        return fallback
    h = m.group(1).lower()
    return "#" + ("".join(c * 2 for c in h) if len(h) == 3 else h)


def _lum(h: str) -> float:
    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(h[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _mix(a: str, b: str, t: float) -> str:
    pa, pb = ([int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in (a, b))
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(pa, pb))


def _readable(fg: str, bg: str, ratio: float) -> str:
    """fg, moved towards white or black (whichever the background needs) until it reaches `ratio` on bg."""
    if contrast(fg, bg) >= ratio:
        return fg
    to = "#ffffff" if _lum(bg) < 0.4 else "#000000"
    for i in range(1, 21):
        c = _mix(fg, to, i / 20)
        if contrast(c, bg) >= ratio:
            return c
    return to


def _num(v, lo: float, hi: float, d: float) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return d


def _pick(v, allowed, d):
    v = str(v or "").strip().lower().replace(" ", "-")
    return v if v in allowed else d


def clean(spec: dict) -> tuple[dict, list[str]]:
    """A safe theme from whatever the model sent, and notes on what was changed."""
    notes: list[str] = []
    mode = "light" if str(spec.get("mode", "")).lower() == "light" else "dark"
    col = 1 if mode == "dark" else 2
    raw = spec.get("palette") if isinstance(spec.get("palette"), dict) else {}
    pal = {k: _hex(raw.get(k), v[col]) for k, v in PALETTE.items()}
    # surfaces the model left out follow its own page and panel colours, not the generic defaults
    derived = {"raised": (pal["panel"], pal["text"], 0.06), "hover": (pal["panel"], pal["text"], 0.11),
               "code": (pal["bg"], "#000000" if mode == "dark" else "#ffffff", 0.3)}
    for k, (a, b, t) in derived.items():
        if not _hex(raw.get(k), ""):
            pal[k] = _mix(a, b, t)
    for k in PALETTE:
        if k != "line" and raw.get(k) is not None and not HEX.match(str(raw.get(k)).strip()):
            notes.append(f"palette.{k} wasn't a hex colour; used a default")
    # readability: body text AA+ on page and panel, secondary/muted AA, accent label AA
    for k, ratio in (("text", 7.0), ("text2", 4.5), ("muted", 4.5)):
        fixed = _readable(_readable(pal[k], pal["bg"], ratio), pal["panel"], ratio)
        if fixed != pal[k]:
            notes.append(f"{k} {pal[k]} → {fixed} for contrast")
            pal[k] = fixed
    pal["accentText"] = max(("#ffffff", "#111111", _hex(raw.get("accentText"), "#111111")), key=lambda c: contrast(c, pal["accent"]))
    if contrast(pal["accentText"], pal["accent"]) < 4.5:
        acc = _readable(pal["accent"], pal["accentText"], 4.5)
        notes.append(f"accent {pal['accent']} → {acc} so its label stays readable")
        pal["accent"] = acc
    link = _readable(pal["accent"], pal["bg"], 3.0)
    if link != pal["accent"]:
        pal["accentSoft"] = link
    inks = [_hex(c, "") for c in (spec.get("inks") or raw.get("inks") or [])][:4]
    pal["inks"] = [c for c in inks if c] or [pal["accent"], pal["brand"]]

    fonts = spec.get("fonts") if isinstance(spec.get("fonts"), dict) else {}
    bd = spec.get("backdrop") if isinstance(spec.get("backdrop"), dict) else {}
    sky = [c for c in (_hex(c, "") for c in (bd.get("sky") or [])[:3]) if c] or [pal["bg"]]
    glows = []
    for g in (bd.get("glows") or [])[:4]:
        if isinstance(g, dict) and _hex(g.get("color"), ""):
            glows.append({"x": _num(g.get("x"), 0, 100, 50), "y": _num(g.get("y"), 0, 100, 50),
                          "size": _num(g.get("size"), 10, 100, 50), "strength": _num(g.get("strength"), 0.02, 0.5, 0.14),
                          "color": _hex(g.get("color"), "#ffffff")})
    pt = spec.get("particles") if isinstance(spec.get("particles"), dict) else {}
    theme = {
        "name": str(spec.get("name") or "Custom").strip()[:32] or "Custom",
        "blurb": re.sub(r"\s+", " ", str(spec.get("blurb") or "")).strip()[:160],
        "mode": mode,
        "palette": pal,
        "fonts": {"display": _pick(fonts.get("display"), FONTS, "inter"), "body": _pick(fonts.get("body"), FONTS, "inter")},
        "caps": bool(spec.get("caps", False)),
        "tracking": _num(spec.get("tracking"), -0.02, 0.24, 0.0),
        "shape": _pick(spec.get("shape"), SHAPES, "soft"),
        "backdrop": {"sky": sky, "glows": glows, "stars": _num(bd.get("stars"), 0, 1, 0),
                     "horizon": _pick(bd.get("horizon"), HORIZONS, "none"),
                     "horizonColor": _hex(bd.get("horizonColor"), _mix(pal["bg"], "#000000", 0.4))},
        "particles": {"kind": _pick(pt.get("kind"), PARTICLES, "none"),
                      "colors": [c for c in (_hex(c, "") for c in (pt.get("colors") or [])[:3]) if c],
                      "density": _num(pt.get("density"), 0.2, 2, 1)},
    }
    if theme["fonts"]["body"] in ("jetbrains-mono", "barlow-condensed", "josefin-sans", "syncopate", "cormorant-garamond") and fonts.get("body"):
        notes.append(f"{theme['fonts']['body']} is hard to read at body size; body text uses Inter")
        theme["fonts"]["body"] = "inter"
    return theme, notes


def all_themes() -> list[dict]:
    v = db.kv_get(KEY, [])
    return v if isinstance(v, list) else []


def save(theme: dict, tid: str | None = None) -> dict:
    themes = all_themes()
    old = next((t for t in themes if t.get("id") == tid), None) if tid else None
    theme = {**theme, "id": old["id"] if old else "t" + uuid.uuid4().hex[:8],
             "created": old.get("created", time.time()) if old else time.time(), "updated": time.time()}
    themes = [theme] + [t for t in themes if t.get("id") != theme["id"]]
    db.kv_set(KEY, themes[:MAX_THEMES])
    return theme


@router.get("")
def list_themes():
    return all_themes()


@router.get("/{tid}")
def get_theme(tid: str):
    t = next((t for t in all_themes() if t.get("id") == tid), None)
    if not t:
        raise HTTPException(404, "No such theme")
    return t


@router.delete("/{tid}")
def delete_theme(tid: str):
    themes = all_themes()
    db.kv_set(KEY, [t for t in themes if t.get("id") != tid])
    return {"ok": True}


async def design_theme(args, ctx) -> ToolResult:
    if not isinstance(args, dict):
        return ToolResult("Send the theme as an object (name, mode, palette, …).", error=True)
    spec = args.get("theme") if isinstance(args.get("theme"), dict) else args
    if isinstance(spec, str):
        try:
            spec = json.loads(spec)
        except ValueError:
            return ToolResult("theme must be an object, not a string.", error=True)
    tid = str(args.get("revise_id") or "").strip() or None
    if tid and not any(t.get("id") == tid for t in all_themes()):
        return ToolResult(f"No theme {tid} to revise; leave revise_id out to make a new one.", error=True)
    theme, notes = clean(spec)
    saved = save(theme, tid)
    fence = "```theme\n" + json.dumps({"id": saved["id"]}) + "\n```"
    msg = (f"{'Revised' if tid else 'Saved'} theme \"{saved['name']}\" (id {saved['id']}, {saved['mode']} mode). "
           f"Show it to the user with this card, which previews it and has an Apply button:\n{fence}\n"
           "Then say in a sentence or two what the direction is. To change it later, call design_theme again with "
           f"revise_id \"{saved['id']}\" and the whole theme.")
    if notes:
        msg += "\nAdjusted: " + "; ".join(notes) + "."
    return ToolResult(msg, display={"theme": saved["id"]})


def register():
    hexd = {"type": "string", "description": "hex colour, e.g. #1b2433"}
    TOOLS["design_theme"] = {
        "fn": design_theme, "service": None, "scope": "global",
        "ui": {"displayName": "Design Theme", "icon": "Palette", "category": "creative",
               "description": "Agents can design custom UI themes for Shell:B; you apply them from a card in the chat."},
        "schema": _fn(
            "design_theme",
            "Create (or revise) a custom theme for Shell:B's own interface when the user asks for a new look. Pick a "
            "clear art direction and make every choice serve it. Dark themes: deep tinted neutrals, never pure black. "
            "Light themes: warm or cool off-whites, never pure white. One strong accent, used sparingly. Text contrast "
            "is checked and corrected for you. The result includes a ```theme``` card to show the user.",
            {
                "name": {"type": "string", "description": "1-2 words, e.g. 'Tidepool'"},
                "blurb": {"type": "string", "description": "One sentence on the look, shown in the theme picker"},
                "mode": {"type": "string", "enum": ["dark", "light"]},
                "palette": {"type": "object", "description": "Hex colours: " + "; ".join(f"{k} = {v[0]}" for k, v in PALETTE.items()),
                            "properties": {k: hexd for k in PALETTE}},
                "inks": {"type": "array", "items": hexd, "description": "2-4 signature colours for the picker stripe"},
                "fonts": {"type": "object", "properties": {
                    "display": {"type": "string", "enum": list(FONTS), "description": "headings: barlow-condensed (technical, sci-fi), "
                                "shippori-mincho (elegant serif, Japanese), josefin-sans (airy geometric), georgia (classic serif), "
                                "cormorant-garamond (cinematic italic serif), sora (clean, cool), syncopate (very wide caps, austere), "
                                "outfit (light, modern), zen-maru-gothic (rounded, warm, storybook), jetbrains-mono (terminal), inter/barlow (neutral)"},
                    "body": {"type": "string", "enum": ["inter", "barlow", "shippori-mincho", "georgia", "sora", "outfit", "zen-maru-gothic"]}}},
                "caps": {"type": "boolean", "description": "Uppercase headings"},
                "tracking": {"type": "number", "description": "Heading letter-spacing in em, -0.02 to 0.24 (caps want 0.08+)"},
                "shape": {"type": "string", "enum": list(SHAPES), "description": "soft = small radii, hard = square/chamfered, round = pill buttons and big radii"},
                "backdrop": {"type": "object", "properties": {
                    "sky": {"type": "array", "items": hexd, "description": "2-3 colours, top to bottom, for the page gradient"},
                    "glows": {"type": "array", "description": "Up to 4 soft light sources (nebula, moon, sunset)", "items": {"type": "object", "properties": {
                        "x": {"type": "number", "description": "0-100 % from left"}, "y": {"type": "number", "description": "0-100 % from top"},
                        "size": {"type": "number", "description": "10-100 % of the screen"}, "strength": {"type": "number", "description": "0.02-0.5"},
                        "color": hexd}}},
                    "stars": {"type": "number", "description": "0-1 star density (night skies)"},
                    "horizon": {"type": "string", "enum": list(HORIZONS), "description": "Silhouette along the bottom"},
                    "horizonColor": hexd}},
                "particles": {"type": "object", "description": "A living layer drifting behind the app", "properties": {
                    "kind": {"type": "string", "enum": list(PARTICLES), "description": "rain = wet window over city bokeh; abyss = "
                             "jellyfish, marine snow, plankton; aurora = northern-lights curtains + snow; sand = blowing sand; "
                             "bokeh = soft out-of-focus lights; leaves = falling maple leaves"},
                    "colors": {"type": "array", "items": hexd, "description": "1-3 colours"},
                    "density": {"type": "number", "description": "0.2-2, default 1"}}},
                "revise_id": {"type": "string", "description": "Id of a theme you made earlier, to change it instead of making a new one"},
            },
            ["name", "mode", "palette"]),
    }
