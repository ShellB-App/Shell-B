"""Code maps and read logs, so an agent auditing Shell:B (or any code) knows where things are and what it actually read.

- outline(): the symbols of a file with line ranges (Python via ast: classes, functions, FastAPI routes; TS/TSX via
  top-level declarations; Markdown headings), or a folder's files with their size and one-line purpose.
- ReadLog: which lines of which files this turn has read. shellb_self action=read_log reports it, so a review can say
  "read 4 of 31 files fully" instead of claiming to have audited everything.
"""
import ast
import re
from collections import OrderedDict
from pathlib import Path

ROUTE_METHODS = {"get", "post", "put", "patch", "delete", "websocket", "api_route"}
TS_DECL = re.compile(r"^(export\s+)?(default\s+)?(async\s+)?(function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][\w$]*)")
CODE_EXT = {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".md", ".css", ".html", ".json", ".sh", ".toml", ".yml", ".yaml"}


def _purpose(path: Path, text: str) -> str:
    """First line of a module docstring or leading comment."""
    if path.suffix == ".py":
        try:
            doc = ast.get_docstring(ast.parse(text))
        except SyntaxError:
            doc = None
        if doc:
            return doc.strip().splitlines()[0][:140]
    for line in text.splitlines()[:8]:
        s = line.strip()
        if s.startswith(("//", "#", "/*", "*")) and not s.startswith("#!"):
            s = s.lstrip("/#* ").strip()
            if s:
                return s[:140]
        elif s.startswith("# ") and path.suffix == ".md":
            return s[2:][:140]
    return ""


def _route(dec) -> str:
    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.func.attr in ROUTE_METHODS \
            and dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str):
        return f"{dec.func.attr.upper()} {dec.args[0].value}"
    return ""


def _py_outline(text: str) -> list[str]:
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        return [f"(syntax error at line {e.lineno}: {e.msg})"]
    out = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            routes = [r for r in map(_route, node.decorator_list) if r]
            kind = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
            out.append(f"{node.lineno:>5}–{node.end_lineno:<5} {kind} {node.name}()" + (f"   [{', '.join(routes)}]" if routes else ""))
        elif isinstance(node, ast.ClassDef):
            out.append(f"{node.lineno:>5}–{node.end_lineno:<5} class {node.name}")
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    out.append(f"{sub.lineno:>5}–{sub.end_lineno:<5}   .{sub.name}()")
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [t.id for t in targets if isinstance(t, ast.Name) and t.id.isupper()]
            if names:
                out.append(f"{node.lineno:>5}       {', '.join(names)} =")
    return out


def _ts_outline(text: str) -> list[str]:
    lines = text.splitlines()
    starts, bounds = [], []  # bounds: every top-level statement, so a symbol's range stops where the next one begins
    for i, line in enumerate(lines, 1):
        if line[:1].isalpha() or line.startswith(("@", "(")):
            bounds.append(i)
        m = TS_DECL.match(line)
        if m:
            kind = m.group(4).replace("function*", "function")
            if kind in ("const", "let") and not m.group(1) and not re.search(r"=\s*(\(|async\b|function\b|React\.|memo\(|forwardRef\(|lazy\()", line):
                continue  # plain module-level values are noise; exported ones and functions stay
            starts.append((i, f"{'export ' if m.group(1) else ''}{kind} {m.group(5)}"))
    out = []
    for i, label in starts:
        end = next((b - 1 for b in bounds if b > i), len(lines))
        while end > i and not lines[end - 1].strip() or (end > i and lines[end - 1].lstrip().startswith(("//", "/*", "*"))):
            end -= 1
        out.append(f"{i:>5}–{end:<5} {label}")
    return out


def _md_outline(text: str) -> list[str]:
    out, fence = [], False
    for i, line in enumerate(text.splitlines(), 1):
        if line.startswith("```"):
            fence = not fence
        elif not fence and re.match(r"#{1,4} ", line):
            out.append(f"{i:>5}  {line.strip()}")
    return out


def outline_file(path: Path, rel: str) -> str:
    text = path.read_text(errors="replace")
    n = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
    head = f"{rel} ({n:,} lines)"
    purpose = _purpose(path, text)
    if purpose:
        head += f" — {purpose}"
    ext = path.suffix.lower()
    body = _py_outline(text) if ext == ".py" else _ts_outline(text) if ext in (".ts", ".tsx", ".js", ".jsx", ".mjs") \
        else _md_outline(text) if ext == ".md" else []
    if not body:
        return head + "\n(no outline for this file type; read it with offset/limit)"
    if len(body) > 400:
        body = body[:400] + [f"…{len(body) - 400} more symbols (outline a narrower file or search with query)"]
    return head + "\n" + "\n".join(body) + "\n\nRead a symbol with offset=<first line> limit=<span>."


def outline_dir(path: Path, rel: str, hidden: set[str]) -> str:
    rows, dirs = [], []
    for p in sorted(path.iterdir()):
        if p.name in hidden or p.name.startswith("."):
            continue
        if p.is_dir():
            count = sum(1 for f in p.rglob("*") if f.is_file() and not (hidden & set(f.relative_to(path).parts)))
            dirs.append(f"  {p.name}/  ({count} files)")
        elif p.suffix.lower() in CODE_EXT and p.stat().st_size < 3_000_000:
            text = p.read_text(errors="replace")
            purpose = _purpose(p, text)
            rows.append(f"  {p.name}  ({text.count(chr(10)):,} lines)" + (f" — {purpose}" if purpose else ""))
        else:
            rows.append(f"  {p.name}  ({p.stat().st_size:,} B)")
    out = [f"{rel or '.'}/ — {len(rows)} files, {len(dirs)} folders"] + dirs + rows
    return "\n".join(out) + "\n\nOutline one file (path=<folder>/<file>) to see its symbols and line ranges."


def line_range(args) -> tuple[int, int]:
    """(first, last) 1-based lines to read; last 0 = to the end. Takes start_line/end_line, and the names models
    reach for instead (offset/start/line/from, limit/lines/count, end), so a read never quietly restarts at line 1."""
    def num(*keys):
        for k in keys:
            try:
                v = int(str(args.get(k)).strip())
            except (TypeError, ValueError):
                continue
            return v
        return 0
    start = max(1, num("start_line", "offset", "start", "line", "from", "from_line"))
    end = num("end_line", "end", "to", "to_line")
    count = num("limit", "lines", "count", "num_lines")
    if not end and count > 0:
        end = start + count - 1
    return start, (end if end >= start else 0)


class ReadLog:
    """Lines read per file, per turn (keyed by the reply's message id). Kept in memory for the last 64 turns."""

    def __init__(self, keep=64):
        self.turns: OrderedDict[str, dict[str, dict]] = OrderedDict()
        self.keep = keep

    def add(self, turn: str, rel: str, start: int, end: int, total: int):
        files = self.turns.setdefault(turn, {})
        self.turns.move_to_end(turn)
        while len(self.turns) > self.keep:
            self.turns.popitem(last=False)
        f = files.setdefault(rel, {"total": total, "spans": [], "reads": 0})
        f["total"], f["reads"] = total, f["reads"] + 1
        if total and end >= start:
            f["spans"].append((start, min(end, total)))

    @staticmethod
    def _covered(spans) -> int:
        n, last = 0, 0
        for a, b in sorted(spans):
            a = max(a, last + 1)
            if b >= a:
                n += b - a + 1
                last = b
        return n

    def report(self, turn: str) -> str:
        files = self.turns.get(turn) or {}
        if not files:
            return "Nothing read yet in this turn (via shellb_self source/read_file)."
        full = part = 0
        rows = []
        for rel, f in sorted(files.items()):
            seen = self._covered(f["spans"])
            pct = 100 * seen // f["total"] if f["total"] else 100
            full += pct >= 99
            part += pct < 99
            reread = f" · read {f['reads']}×" if f["reads"] > 1 else ""
            rows.append(f"  {pct:>3}%  {rel}  ({seen:,} of {f['total']:,} lines{reread})")
        return (f"This turn read {len(files)} files: {full} fully, {part} partly.\n" + "\n".join(rows)
                + "\n\nClaims in a review should stay within what is listed here; say which files you did not read.")


READS = ReadLog()


AUDIT_SKILL = "audit-code"
AUDIT_DESCRIPTION = ("Review or audit Shell:B's own code (or a Code workspace) and write findings that hold up: map it, read "
                     "it, prove every claim with file:line. Use when asked to review, audit, scrutinize or find bugs or "
                     "security problems in the code, or to recommend fixes and features from it.")
AUDIT_BODY = """# Audit code

A review is only worth what it can prove. The owner will check your findings against the code, so every one needs a
place in the code that shows it. A short review that is right beats a long one that is padded or guessed.

Stay read-only unless the owner asked for changes: for Shell:B itself use `shellb_self` actions `outline`, `source` and
`read_log`; they read the live code and need no workspace.

## 1. Map before you read
- `outline` with no path, then on `server` and `ui/src`: every file with its size and purpose.
- Pick the files that matter for the request (security → auth.py, the fetchers, file serving, sandbox, self-mod;
  a feature → its module and its UI). Say which ones you chose and why.
- `outline` each chosen file to see its functions, routes and line ranges.

## 2. Read what you judge
- Read the code behind each finding with `source path=… offset=<first line> limit=<span>` (`paths` reads up to 8
  files in one call). Every partial read tells you the range you got and where to continue; follow it rather than
  reading from line 1 again.
- If the same lines come back twice, stop and change the arguments. Don't keep calling.

## 3. Prove it, or drop it
- **Something is wrong:** quote the line and give `file:line`. Explain the concrete failure: an input, a request or a
  sequence that goes wrong.
- **Something is missing** ("no X", "doesn't do Y"): search for it first with `source query=<regex>` (try two or three
  names). Most "missing" features already exist under another name. If the search finds nothing, say what you searched.
- **A recommendation:** check the code doesn't already do it (sandbox flags, iframe `sandbox=`, indexes, limits).
- Rate severity by what an attacker or a bug can actually do on this box (one owner, localhost trust, LAN + Tailscale),
  not by how it sounds.
- **Earlier reports** (in this chat, a past chat or an artifact) are not evidence. Re-check every finding you carry
  over against the code and drop it if the code says otherwise.
- Leave out generic advice that fits any project (import order, magic numbers, "add a CHANGELOG") unless you can tie
  it to a real problem here.

## 4. Report honestly
- Your last tool call before writing the report must be `read_log`. Copy its first line ("This turn read N files:
  …") into **Scope** word for word, and list the important files you did not read. Never claim more than it lists:
  reading the first 60 lines of a file is not auditing it.
- Shape: **Scope** (what you read) · **Findings** most severe first, each with `file:line`, evidence, impact and fix ·
  **Checked and fine** (things you verified are already right) · **Not covered**.
- Mark each finding *confirmed* (you read the code and traced it) or *suspected* (needs a closer look).
"""


def init():
    """Ship the audit-code skill; a copy the owner has edited is left alone."""
    import skills
    if not (skills.SKILLS / AUDIT_SKILL / "SKILL.md").exists():
        skills.save(skills.compose(AUDIT_SKILL, AUDIT_DESCRIPTION, AUDIT_BODY), AUDIT_SKILL, source="builtin")
