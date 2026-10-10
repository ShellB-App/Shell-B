"""Token counter: every agent turn's prompt + completion tokens, kept in a ledger of their own.

Message rows carry their turn's usage too, but chats get deleted (incognito ones on a timer, guests' when the guest
goes), so totals summed from messages would shrink. app.begin_turn records each finished turn here instead.
`tenant` is "" for the owner (chats, schedules, delegations), the guest's id for a guest turn, and "api" for a sealed
persona API turn. Background model calls (titles, compaction, memory distilling) are not counted; turns are.

`token_usage_detail` keeps the same counts per (day, tenant, agent, model) for Settings → Usage: which agents and
models use the tokens, day by day. `report(days)` is what that page shows (GET /api/usage); with the optional setting
`modelCosts` ({model: {"in": $ per 1M prompt tokens, "out": $ per 1M completion tokens}}) it also prices the turns,
which only matters for cloud models.
"""
import time

from fastapi import APIRouter, HTTPException, Request

import db

router = APIRouter(prefix="/api/usage")


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS token_usage(
  day TEXT, tenant TEXT, prompt INTEGER DEFAULT 0, completion INTEGER DEFAULT 0, turns INTEGER DEFAULT 0,
  PRIMARY KEY(day, tenant));
CREATE TABLE IF NOT EXISTS token_usage_detail(
  day TEXT, tenant TEXT, agent TEXT, model TEXT, prompt INTEGER DEFAULT 0, completion INTEGER DEFAULT 0,
  turns INTEGER DEFAULT 0, PRIMARY KEY(day, tenant, agent, model));
""")
    if not db.kv_get("token_usage_backfilled"):
        _backfill()
        db.kv_set("token_usage_backfilled", True)
    if not db.kv_get("token_usage_detail_backfilled"):
        _backfill_detail()
        db.kv_set("token_usage_detail_backfilled", True)


def _backfill():
    """Seed the ledger once from the replies still on disk (counted by the day each was written)."""
    with db.conn() as c:
        c.execute("""
INSERT INTO token_usage(day, tenant, prompt, completion, turns)
SELECT date(m.created, 'unixepoch', 'localtime'), coalesce(cv.tenant, ''),
       sum(coalesce(json_extract(m.data, '$.usage.prompt'), 0)),
       sum(coalesce(json_extract(m.data, '$.usage.completion'), 0)), count(*)
FROM messages m LEFT JOIN conversations cv ON cv.id = m.conv_id
WHERE m.role = 'assistant' AND json_extract(m.data, '$.usage') IS NOT NULL
GROUP BY 1, 2
ON CONFLICT(day, tenant) DO UPDATE SET prompt = prompt + excluded.prompt,
  completion = completion + excluded.completion, turns = turns + excluded.turns""")


def _backfill_detail():
    """Seed the per-agent/model ledger once from the replies still on disk."""
    with db.conn() as c:
        c.execute("""
INSERT INTO token_usage_detail(day, tenant, agent, model, prompt, completion, turns)
SELECT date(m.created, 'unixepoch', 'localtime'), coalesce(cv.tenant, ''),
       coalesce(json_extract(m.data, '$.agentId'), cv.agent_id, ''), coalesce(json_extract(m.data, '$.model'), ''),
       sum(coalesce(json_extract(m.data, '$.usage.prompt'), 0)),
       sum(coalesce(json_extract(m.data, '$.usage.completion'), 0)), count(*)
FROM messages m LEFT JOIN conversations cv ON cv.id = m.conv_id
WHERE m.role = 'assistant' AND json_extract(m.data, '$.usage') IS NOT NULL
GROUP BY 1, 2, 3, 4
ON CONFLICT(day, tenant, agent, model) DO UPDATE SET prompt = prompt + excluded.prompt,
  completion = completion + excluded.completion, turns = turns + excluded.turns""")


def record(tenant: str, usage: dict | None, agent: str = "", model: str = ""):
    u = usage or {}
    prompt, completion = int(u.get("prompt") or 0), int(u.get("completion") or 0)
    if not prompt and not completion:
        return
    day = time.strftime("%Y-%m-%d")
    with db.conn() as c:
        c.execute("INSERT INTO token_usage(day, tenant, prompt, completion, turns) VALUES(?,?,?,?,1) "
                  "ON CONFLICT(day, tenant) DO UPDATE SET prompt = prompt + excluded.prompt, "
                  "completion = completion + excluded.completion, turns = turns + 1",
                  (day, tenant or "", prompt, completion))
        c.execute("INSERT INTO token_usage_detail(day, tenant, agent, model, prompt, completion, turns) VALUES(?,?,?,?,?,?,1) "
                  "ON CONFLICT(day, tenant, agent, model) DO UPDATE SET prompt = prompt + excluded.prompt, "
                  "completion = completion + excluded.completion, turns = turns + 1",
                  (day, tenant or "", agent or "", model or "", prompt, completion))


def _sum(where: str = "", args: tuple = ()) -> dict:
    with db.conn() as c:
        r = c.execute("SELECT coalesce(sum(prompt), 0) p, coalesce(sum(completion), 0) c, coalesce(sum(turns), 0) t "
                      f"FROM token_usage {where}", args).fetchone()
    return {"prompt": r["p"], "completion": r["c"], "total": r["p"] + r["c"], "turns": r["t"]}


def total(tenant: str | None = None) -> dict:
    """One tenant's lifetime tokens ("" = the owner), or everyone's when tenant is None."""
    return _sum() if tenant is None else _sum("WHERE tenant=?", (tenant,))


def today(tenant: str | None = None) -> dict:
    day = time.strftime("%Y-%m-%d")
    return _sum("WHERE day=?", (day,)) if tenant is None else _sum("WHERE day=? AND tenant=?", (day, tenant))


def stats(tenant: str = "") -> dict:
    """The counter as the stats panels show it: this user's tokens and the whole machine's."""
    return {"user": total(tenant), "global": total(), "userToday": today(tenant)["total"], "globalToday": today()["total"]}


# ── Settings → Usage ────────────────────────────────────────────────────────

def _tenant_kind(t: str) -> str:
    return "owner" if not t else "api" if t == "api" else "guests"


def _cost(model: str, prompt: int, completion: int, costs: dict) -> float | None:
    c = costs.get(model) if isinstance(costs, dict) else None
    if not isinstance(c, dict):
        return None
    try:
        return prompt / 1e6 * float(c.get("in") or 0) + completion / 1e6 * float(c.get("out") or 0)
    except (TypeError, ValueError):
        return None


def report(days: int = 30) -> dict:
    """Tokens per day (split owner / guests / API), per agent, per model and per tenant kind over the last `days`,
    plus lifetime totals; priced where `modelCosts` names the model."""
    days = max(1, min(366, int(days)))
    since = time.strftime("%Y-%m-%d", time.localtime(time.time() - (days - 1) * 86400))
    costs = (db.kv_get("settings") or {}).get("modelCosts") or {}
    with db.conn() as c:
        rows = [dict(r) for r in c.execute("SELECT day, tenant, agent, model, prompt, completion, turns FROM token_usage_detail "
                                           "WHERE day>=? ORDER BY day", (since,))]
    by_day: dict[str, dict] = {}
    agents: dict[str, dict] = {}
    models: dict[str, dict] = {}
    kinds: dict[str, dict] = {}
    total_cost, priced = 0.0, False
    for r in rows:
        kind = _tenant_kind(r["tenant"])
        d = by_day.setdefault(r["day"], {"day": r["day"], "prompt": 0, "completion": 0, "turns": 0, "owner": 0, "guests": 0, "api": 0})
        d["prompt"] += r["prompt"]; d["completion"] += r["completion"]; d["turns"] += r["turns"]
        d[kind] += r["prompt"] + r["completion"]
        for table, key in ((agents, r["agent"] or "(unknown)"), (models, r["model"] or "(unknown)"), (kinds, kind)):
            t = table.setdefault(key, {"name": key, "prompt": 0, "completion": 0, "turns": 0})
            t["prompt"] += r["prompt"]; t["completion"] += r["completion"]; t["turns"] += r["turns"]
        cost = _cost(r["model"], r["prompt"], r["completion"], costs)
        if cost is not None:
            priced = True
            total_cost += cost
            models.setdefault(r["model"], {"name": r["model"], "prompt": 0, "completion": 0, "turns": 0})
            models[r["model"]]["cost"] = round(models[r["model"]].get("cost", 0.0) + cost, 4)
    # every day in the window, so the chart has no gaps
    series = []
    for i in range(days):
        day = time.strftime("%Y-%m-%d", time.localtime(time.time() - (days - 1 - i) * 86400))
        series.append(by_day.get(day) or {"day": day, "prompt": 0, "completion": 0, "turns": 0, "owner": 0, "guests": 0, "api": 0})
    rank = lambda t: sorted(t.values(), key=lambda x: -(x["prompt"] + x["completion"]))  # noqa: E731
    window = {"prompt": sum(r["prompt"] for r in rows), "completion": sum(r["completion"] for r in rows), "turns": sum(r["turns"] for r in rows)}
    return {"days": days, "since": since, "series": series, "agents": rank(agents), "models": rank(models), "tenants": rank(kinds),
            "window": window, "lifetime": total(), "cost": round(total_cost, 4) if priced else None, "costs": costs}


@router.get("")
def api_usage(req: Request, days: int = 30):
    import auth
    if not (auth.is_owner(req) or auth.is_admin(req) or req.scope.get("shellb_auth") == "local"):
        raise HTTPException(401, "login-required")
    return report(days)
