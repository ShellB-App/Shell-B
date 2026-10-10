"""ask_user: an agent asks the owner 1-4 multiple-choice questions in the chat and waits for the answers.

The turn blocks the way an approval does (remote.wait_approval), so the Activity inbox lists the question too. Every
question also takes a typed answer ("Other"). Only live chats get the tool: scheduled runs, Mega Plans and other
unattended turns have nobody to ask. If nobody answers within 30 minutes, or the turn is stopped, the agent is told to
end its turn; the card stays answerable in the chat and the answer then arrives as the user's next message.
"""
import json
import re
import uuid

from fastapi import APIRouter, HTTPException, Request

import remote
from tools import TOOLS, ToolResult, _fn

TIMEOUT = 30 * 60
MAX_QUESTIONS, MAX_OPTIONS = 4, 6

router = APIRouter(prefix="/api/questions")
_asked: dict[str, list[dict]] = {}  # questions waiting for an answer, by id
# models often say "pick any" in the question but forget multi_select
MULTI_HINT = re.compile(r"\b(pick|select|choose|check|tick)\s+(any|all|several|multiple|one or more)\b|all that apply|one or more", re.I)

GUIDE = ("- ask_user puts 1-4 multiple-choice questions in front of the user and waits for the answers (they can always "
         "type their own instead). Use it when you're blocked on a decision that's genuinely theirs: a preference, scope "
         "or direction, or a request so ambiguous that guessing wrong would waste real work. Don't ask what you can find "
         "out yourself or what has an obvious default, and never ask 'should I continue?'. Give 2-4 short, distinct "
         "options; if you recommend one, put it first and end its label with ' (Recommended)'. Ask everything you need "
         "in one call rather than one question at a time.")


def normalize(args) -> list[dict] | str:
    """The questions in a clean shape, or a message telling the model what to fix. Small models flatten one question
    into the top level, send options as plain strings, or JSON-encode the list; all of that is accepted."""
    if not isinstance(args, dict):
        return "Send questions: a list of 1-4 {question, options}."
    qs = args.get("questions")
    if isinstance(qs, str):
        try:
            qs = json.loads(qs)
        except ValueError:
            qs = None
    if qs is None and args.get("question"):
        qs = [args]
    if isinstance(qs, dict):
        qs = [qs]
    if not isinstance(qs, list) or not qs:
        return "Send questions: a list of 1-4 {question, options}."
    out = []
    for q in qs[:MAX_QUESTIONS]:
        text = str((q or {}).get("question") or "").strip() if isinstance(q, dict) else ""
        if not text:
            return "Every question needs its question text."
        opts, seen = [], set()
        for o in q.get("options") or []:
            if isinstance(o, str):
                o = {"label": o}
            label = str(o.get("label") or "").strip()[:120] if isinstance(o, dict) else ""
            if label and label.lower() not in seen:
                seen.add(label.lower())
                opts.append({"label": label, "description": str(o.get("description") or "").strip()[:400]})
        if len(opts) < 2:
            return f"The question {text!r} needs at least 2 distinct options (the user can always type their own)."
        out.append({"question": text[:600], "header": str(q.get("header") or "").strip()[:24], "options": opts[:MAX_OPTIONS],
                    "multiSelect": bool(q.get("multi_select") or q.get("multiSelect") or MULTI_HINT.search(text))})
    return out


def clean_answers(questions: list[dict], answers) -> list[dict]:
    if not isinstance(answers, list) or len(answers) != len(questions):
        raise HTTPException(400, f"Send one answer per question ({len(questions)}).")
    out = []
    for q, a in zip(questions, answers):
        a = a if isinstance(a, dict) else {}
        labels = [o["label"] for o in q["options"]]
        picked = [s for s in labels if s in (a.get("selected") or [])]  # keeps the options' order
        other = str(a.get("other") or "").strip()[:2000]
        if not q["multiSelect"] and len(picked) + bool(other) > 1:
            raise HTTPException(400, f"Pick one answer for {q['question']!r}.")
        out.append({"selected": picked, "other": other})
    return out


def summarize(questions: list[dict], answers: list[dict]) -> str:
    lines = ["The user answered:"]
    for i, (q, a) in enumerate(zip(questions, answers), 1):
        parts = [", ".join(a["selected"])] if a["selected"] else []
        if a["other"]:
            parts.append(f"in their own words: {a['other']}")
        lines.append(f"{i}. {q['question']}\n   → {'; '.join(parts) or '(skipped)'}")
    return "\n".join(lines)


async def run(args, conv_id: str, abort, sink, idx) -> ToolResult:
    """Show the questions on the tool block, wait for the answers, and hand them back to the model."""
    qs = normalize(args)
    if isinstance(qs, str):
        return ToolResult(qs, error=True)
    aid = uuid.uuid4().hex
    b = sink.blocks[idx]
    b.update(status="approval", approval={"id": aid, "kind": "question"}, questions=qs)
    await sink.update(idx)
    title = qs[0]["question"] + (f" (+{len(qs) - 1} more)" if len(qs) > 1 else "")
    detail = "\n\n".join(f"{q['question']}\n" + "\n".join(f"  • {o['label']}" for o in q["options"]) for q in qs)
    _asked[aid] = qs
    try:
        got = await remote.wait_approval(aid, abort, {"kind": "question", "conv": conv_id, "title": title, "detail": detail},
                                         timeout=TIMEOUT)
    finally:
        _asked.pop(aid, None)
    b.pop("approval", None)
    if isinstance(got, dict):
        b.update(status="running", answers=got["answers"])
        await sink.update(idx)
        return ToolResult(summarize(qs, got["answers"]))
    b.update(status="running", decision=got)
    await sink.update(idx)
    if got == "deny":
        return ToolResult("The user dismissed the questions without answering. Go ahead with your best judgment and "
                          "say briefly what you assumed.")
    if got == "stopped":
        return ToolResult("The turn was stopped before the user answered.", error=True)
    return ToolResult("No answer after 30 minutes. End your turn now with one short line saying what you're waiting on; "
                      "the questions stay on screen and the answers will arrive as the user's next message.")


@router.post("/{aid}")
async def answer(aid: str, req: Request):
    remote.require_admin(req)
    qs = _asked.get(aid)
    fut = remote._pending.get(aid)
    if qs is None or fut is None or fut.done():
        raise HTTPException(404, "That question is no longer waiting.")
    body = await req.json()
    fut.set_result({"answers": clean_answers(qs, body.get("answers"))})
    return {"ok": True}


async def _live_only(args, ctx):
    return ToolResult("ask_user only works in a live chat with the user.", error=True)


def register():
    TOOLS["ask_user"] = {
        "fn": _live_only, "service": None, "scope": "global", "auto": "in live chats",
        "ui": {"displayName": "Ask the User", "icon": "MessageCircleQuestion", "category": "subagent",
               "description": "Agents can pause a chat to ask you multiple-choice questions (you can always type your own answer)."},
        "schema": _fn("ask_user",
                      "Ask the user 1-4 multiple-choice questions in the chat and wait for their answers. They can pick "
                      "an option or type their own answer. Use it only when blocked on a decision that is theirs to make.",
                      {"questions": {"type": "array", "description": "1-4 questions, asked together",
                                     "items": {"type": "object", "properties": {
                                         "question": {"type": "string", "description": "The complete question, ending with '?'"},
                                         "header": {"type": "string", "description": "Very short tag, max 12 chars, e.g. 'Approach'"},
                                         "options": {"type": "array", "description": "2-4 distinct choices; no 'Other' (always offered)",
                                                     "items": {"type": "object", "properties": {
                                                         "label": {"type": "string", "description": "1-5 words"},
                                                         "description": {"type": "string", "description": "What choosing it means, trade-offs"}},
                                                         "required": ["label"]}},
                                         "multi_select": {"type": "boolean", "description": "Set true when several answers can apply (e.g. 'which do you like?'); default false = pick one"}},
                                         "required": ["question", "options"]}}},
                      ["questions"]),
    }
