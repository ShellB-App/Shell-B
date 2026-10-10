"""Token counter: every agent turn's prompt + completion tokens, kept in a ledger of their own.

Message rows carry their turn's usage too, but chats get deleted (incognito ones on a timer, guests' when the guest
goes), so totals summed from messages would shrink. app.begin_turn records each finished turn here instead.
`tenant` is "" for the owner (chats, schedules, delegations), the guest's id for a guest turn, and "api" for a sealed
persona API turn. Background model calls (titles, compaction, memory distilling) are not counted; turns are.
"""
import time

import db


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS token_usage(
  day TEXT, tenant TEXT, prompt INTEGER DEFAULT 0, completion INTEGER DEFAULT 0, turns INTEGER DEFAULT 0,
  PRIMARY KEY(day, tenant));
""")
    if not db.kv_get("token_usage_backfilled"):
        _backfill()
        db.kv_set("token_usage_backfilled", True)


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


def record(tenant: str, usage: dict | None):
    u = usage or {}
    prompt, completion = int(u.get("prompt") or 0), int(u.get("completion") or 0)
    if not prompt and not completion:
        return
    with db.conn() as c:
        c.execute("INSERT INTO token_usage(day, tenant, prompt, completion, turns) VALUES(?,?,?,?,1) "
                  "ON CONFLICT(day, tenant) DO UPDATE SET prompt = prompt + excluded.prompt, "
                  "completion = completion + excluded.completion, turns = turns + 1",
                  (time.strftime("%Y-%m-%d"), tenant or "", prompt, completion))


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
