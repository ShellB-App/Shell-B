"""Plan mode: the agent looks before it leaps. It researches with read-only tools, then answers with a plan, and nothing
changes until the owner approves it (the chat's Approve button sends the next turn in normal mode).

Read-only is enforced, not just asked for: enabled_tools() drops every tool that can't be used read-only, and
_run_tools() refuses calls whose action changes something (allowed()). Sub-agents asked through ask_agent inherit plan
mode. MCP tools are left out entirely because Shell:B can't tell what they do.
"""

# tools that never change anything
READ_ONLY = {
    "web_search", "web_fetch", "read_document", "view_document", "ocr", "memory_search", "recall_conversations", "use_skill", "read_skill_file",
    "ask_user", "ask_agent", "wiki", "legal", "project_search", "project_read_file", "project_read_chat",
    # Studio/Code project and remote workspace readers
    "list_files", "read_file", "view_image", "screenshot", "search_files", "find_files", "project_diff",
}
# tools with a mix of actions: only these actions (or methods) are allowed while planning
READ_ACTIONS = {
    "library": {"list", "search", "browse", "read", "view"},
    "codex": {"search", "read", "list", "collections"},
    "follow_ups": {"list"},
    "asset_library": {"libraries", "search", "list", "info", "view", "jobs"},
    "research_board": {"view", "list", "open", "search"},
    "project_todos": {"list"},
    "schedule_task": {"list"},
    "find_capability": {"search", "details"},
    "mega_plan": {"view"},
    "dev_server": {"status", "logs"},
    "shellb_self": {"about", "status", "logs", "source", "workspace", "history", "read_file", "search_files", "find_files", "diff"},
}
READ_METHODS = {"http_request": {"GET"}}

NOTE = """## Plan mode is on
The user wants a plan before anything is changed. In this turn:
- Research as much as you need with read-only tools: read files, search, browse, look things up, ask_user about \
genuine choices. Tools that would change something are switched off, and calls that would write are refused.
- Don't create artifacts, files, images, music or memories, and don't run code, even "just to check".
- Don't write the finished thing into your reply either: no complete code, pages or documents. Short snippets that show an approach are fine.
- Finish with the plan, in Markdown, under the heading `## Plan`: the goal in a sentence, numbered steps that each \
name what changes (files, artifacts, tools you'll use), the open questions or risks, and how you'll check the result.
- Keep it concrete and skimmable. The user will approve it, edit it, or ask for changes; you'll carry it out in the \
next turn, once plan mode is off.
- The app shows Approve and Keep planning buttons under your reply, so don't add your own begin/approve buttons, \
links or "ready to start?" question."""


# appended to the user's message for this turn only (models weigh it more than the end of a long system prompt)
REMINDER = ("\n\n[Plan mode: don't do or build this yet. Research with read-only tools if useful, then reply with a plan "
            "under `## Plan` (numbered steps, open questions, how you'll check it). The user approves it before anything "
            "is made.]")


def offered(name: str) -> bool:
    """Whether the tool is offered at all while planning."""
    return name in READ_ONLY or name in READ_ACTIONS or name in READ_METHODS


def allowed(name: str, args) -> bool:
    if name in READ_ONLY:
        return True
    a = args if isinstance(args, dict) else {}
    if name in READ_ACTIONS:
        return str(a.get("action") or "") in READ_ACTIONS[name]
    if name in READ_METHODS:
        return str(a.get("method") or "GET").upper() in READ_METHODS[name]
    return False


def refusal(name: str, args) -> str:
    what = f"{name} action={args.get('action')!r}" if isinstance(args, dict) and args.get("action") else name
    return (f"Plan mode is on, so {what} was refused: it would change something. Only read-only research is allowed "
            "now. Put this step in your plan instead; it runs after the user approves.")
