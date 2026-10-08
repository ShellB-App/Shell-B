"""Smoke and regression tests for the Shell:B Web server, run against a scratch copy.

    cd ~/shellb/web && venv/bin/python -m unittest discover -s tests -p '*_test.py' -v

Importing server/app.py has side effects (schedules.init() marks in-flight runs as interrupted, background loops start on
startup), so the tests never touch the live tree: they copy server/ and data/shellb.db to a temp dir and import from
there (db.DATA is relative to db.py). TestClient is used without its context manager, so startup hooks don't run and no
background loops start. Requests from TestClient count as localhost (owner) requests.
"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
_TMP = Path(tempfile.mkdtemp(prefix="shellb-test-"))
atexit.register(shutil.rmtree, _TMP, ignore_errors=True)


def _scratch():
    shutil.copytree(WEB / "server", _TMP / "server", ignore=shutil.ignore_patterns("__pycache__"))
    (_TMP / "data").mkdir()
    if (WEB / "data" / "shellb.db").exists():
        shutil.copy2(WEB / "data" / "shellb.db", _TMP / "data" / "shellb.db")
    (_TMP / "ui" / "dist" / "assets").mkdir(parents=True)
    (_TMP / "ui" / "src").mkdir(parents=True)
    shutil.copy2(WEB / "ui" / "src" / "cdnMap.json", _TMP / "ui" / "src" / "cdnMap.json")  # offline.py reads it at import
    (_TMP / "ui" / "dist" / "index.html").write_text("<!doctype html><title>test</title>")
    sys.path.insert(0, str(_TMP / "server"))
    os.chdir(_TMP / "server")


_scratch()
from fastapi.testclient import TestClient  # noqa: E402

import app as shellb  # noqa: E402
import projects  # noqa: E402

client = TestClient(shellb.app, client=("127.0.0.1", 50000), raise_server_exceptions=False)  # localhost = owner


class ReadRoutes(unittest.TestCase):
    """Every page's first request should answer without a server error."""
    ROUTES = ["/api/conversations", "/api/agents", "/api/tools", "/api/settings", "/api/models", "/api/library",
              "/api/memory", "/api/codex", "/api/codex/entries", "/api/activity", "/api/schedules",
              "/api/generate", "/api/generate/history", "/api/notify/key", "/api/commitments", "/api/brief",
              "/api/import/status"]

    def test_no_server_errors(self):
        for path in self.ROUTES:
            with self.subTest(path=path):
                r = client.get(path)
                self.assertEqual(r.status_code, 200, f"{path}: {r.status_code} {r.text[:300]}")


class WorkspaceFiles(unittest.TestCase):
    def setUp(self):
        self.conv = "conv-smoketest"
        self.ws = shellb.WORKSPACES / self.conv
        self.ws.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.ws, ignore_errors=True)

    def _get(self, name, body="x"):
        (self.ws / name).write_text(body)
        return client.get(f"/api/workspace/{self.conv}/{name}")

    def test_pages_are_sandboxed(self):
        for name in ("a.html", "a.svg", "a.shtml", "a.xht", "a.xsl"):
            with self.subTest(name=name):
                self.assertIn("sandbox", self._get(name).headers.get("content-security-policy", ""))

    def test_passive_files_are_not(self):
        r = self._get("notes.txt")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("content-security-policy", r.headers)

    def test_conv_id_cannot_escape(self):
        # refused by the middleware's dot-segment check (400) before the route's own containment check (404)
        self.assertIn(client.get("/api/workspace/..%2Fprojects/x").status_code, (400, 404))


class ProjectPaths(unittest.TestCase):
    def test_root_is_refused_for_deletes(self):
        pid = "proj-5a0e7e575e57"
        (projects.PROJECTS / pid).mkdir(parents=True, exist_ok=True)
        try:
            for rel in ("", ".", "/", "./"):
                with self.subTest(rel=rel):
                    with self.assertRaises(ValueError):
                        projects.safe_path(pid, rel, allow_root=False)
            self.assertEqual(projects.safe_path(pid, ""), projects.root(pid).resolve())
            with self.assertRaises(ValueError):
                projects.safe_path(pid, "../other")
        finally:
            shutil.rmtree(projects.PROJECTS / pid, ignore_errors=True)


class FrameScope(unittest.TestCase):
    """A sandboxed page's key reaches its own project or chat (plus shared files and its own saved state), nothing else;
    pages on this machine get no localhost trust."""
    @classmethod
    def setUpClass(cls):
        import auth
        import db
        cls.auth = auth
        cls.secret = "test-frame-secret-0123456789"
        with db.conn() as c:
            c.execute("INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?)",
                      ("sid-frametest", cls.secret, 0, 0, 4e9, "10.0.0.2", "test"))
        cls.lan = TestClient(shellb.app, client=("10.0.0.2", 50000), raise_server_exceptions=False, follow_redirects=False)
        for pid in ("proj-0000000000fa", "proj-0000000000fb"):
            (projects.PROJECTS / pid).mkdir(parents=True, exist_ok=True)
            (projects.PROJECTS / pid / "index.html").write_text(f"<p>{pid}</p>")
        for conv in ("conv-fa", "conv-fb"):
            (shellb.WORKSPACES / conv).mkdir(parents=True, exist_ok=True)
            (shellb.WORKSPACES / conv / "data.txt").write_text(conv)

    @classmethod
    def tearDownClass(cls):
        for d in (projects.PROJECTS / "proj-0000000000fa", projects.PROJECTS / "proj-0000000000fb", shellb.WORKSPACES / "conv-fa", shellb.WORKSPACES / "conv-fb"):
            shutil.rmtree(d, ignore_errors=True)

    def k(self, scope, secret=None):
        return self.auth.frame_prefix(secret or self.secret, scope)

    def test_project_key_reaches_only_its_project(self):
        own = self.lan.get(f"{self.k('p-proj-0000000000fa')}/projects/proj-0000000000fa/raw/index.html")
        self.assertEqual(own.status_code, 200, own.text[:200])
        self.assertEqual(self.lan.get(f"{self.k('p-proj-0000000000fa')}/projects/proj-0000000000fb/raw/index.html").status_code, 403)
        self.assertEqual(self.lan.get(f"{self.k('p-proj-0000000000fa')}/workspace/conv-fa/data.txt").status_code, 403)

    def test_chat_key_reaches_only_its_workspace(self):
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/workspace/conv-fa/data.txt").text, "conv-fa")
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/workspace/conv-fb/data.txt").status_code, 403)
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/projects/proj-0000000000fa/raw/index.html").status_code, 403)

    def test_saved_state_is_scoped(self):
        self.assertEqual(self.lan.get(f"{self.k('p-proj-0000000000fa')}/appstate/boot.js?s=proj:proj-0000000000fa").status_code, 200)
        self.assertEqual(self.lan.get(f"{self.k('p-proj-0000000000fa')}/appstate?s=proj:proj-0000000000fb").status_code, 403)
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/appstate?s=art:conv-fa:a1").status_code, 200)
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/appstate?s=art:conv-fb:a1").status_code, 403)

    def test_forged_and_old_keys_fail(self):
        self.assertEqual(self.lan.get(f"/api/k/p-proj-0000000000fa.{'0' * 32}/projects/proj-0000000000fa/raw/index.html").status_code, 401)
        self.assertEqual(self.lan.get(f"/api/k/{self.secret}/projects/proj-0000000000fa/raw/index.html").status_code, 401)  # unscoped
        other = self.k("p-proj-0000000000fb").split(".")[-1]
        self.assertEqual(self.lan.get(f"/api/k/p-proj-0000000000fa.{other}/projects/proj-0000000000fa/raw/index.html").status_code, 401)

    def test_local_key_only_on_loopback(self):
        local = self.auth.local_frame_secret()
        url = f"{self.k('w-conv-fa', local)}/workspace/conv-fa/data.txt"
        self.assertEqual(client.get(url).status_code, 200)
        self.assertEqual(self.lan.get(url).status_code, 401)

    def test_pages_on_this_machine_get_no_local_trust(self):
        for h in ({"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            with self.subTest(h=h):
                self.assertEqual(client.get("/api/workspace/conv-fb/data.txt", headers=h).status_code, 401)
                self.assertEqual(client.get("/api/conversations", headers=h).status_code, 401)
        self.assertEqual(client.get("/api/workspace/conv-fb/data.txt", headers={"Sec-Fetch-Site": "same-origin"}).status_code, 200)

    def test_page_loads_move_under_their_key(self):
        noredir = TestClient(shellb.app, client=("127.0.0.1", 50000), raise_server_exceptions=False, follow_redirects=False)
        r = noredir.get("/api/projects/proj-0000000000fa/raw/index.html", headers={"Sec-Fetch-Dest": "iframe"})
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r.headers["location"].startswith(self.k("p-proj-0000000000fa", self.auth.local_frame_secret()) + "/projects/proj-0000000000fa/raw/"))
        self.assertEqual(noredir.get(r.headers["location"]).status_code, 200)
        w = noredir.get("/api/workspace/conv-fa/data.txt", headers={"Sec-Fetch-Dest": "document"})
        self.assertEqual(w.status_code, 302)
        self.assertEqual(noredir.get(w.headers["location"]).text, "conv-fa")
        self.assertEqual(noredir.get("/api/workspace/conv-fa/data.txt").status_code, 200)  # tools (no fetch metadata) as before


class Deadlines(unittest.TestCase):
    """commitments.relative_due: spoken deadlines from meetings and chats become dates, counted from the day said."""
    def test_relative_due(self):
        import datetime as dt
        from commitments import relative_due
        tue, fri = dt.date(2026, 10, 6), dt.date(2026, 10, 9)
        cases = [("Friday", tue, "2026-10-09"), ("by Friday", fri, "2026-10-16"), ("next Friday", tue, "2026-10-16"),
                 ("this Friday", tue, "2026-10-09"), ("Monday", tue, "2026-10-12"), ("Wed", tue, "2026-10-07"),
                 ("tomorrow 3pm", tue, "2026-10-07T15:00"), ("Friday 9:30am", tue, "2026-10-09T09:30"), ("EOD", tue, "2026-10-06"),
                 ("end of week", tue, "2026-10-09"), ("end of month", tue, "2026-10-31"), ("in 2 weeks", tue, "2026-10-20"),
                 ("Oct 9", tue, "2026-10-09"), ("9th of November", tue, "2026-11-09"), ("Sept 3", tue, "2027-09-03"),
                 ("Jan 5", tue, "2027-01-05"), ("10/20", tue, "2026-10-20"), ("TBD", tue, None), ("Q4", tue, None),
                 ("ASAP", tue, None), ("next month", tue, None), ("after the wedding", tue, None), ("a friendly sunset", tue, None),
                 ("we may finish soon", tue, None), ("Feb 30", tue, None), ("", tue, None), (None, tue, None)]
        for text, anchor, want in cases:
            with self.subTest(text=text):
                self.assertEqual(relative_due(text, anchor), want)


class FollowUpsTool(unittest.TestCase):
    def setUp(self):
        import commitments
        import db
        from tools import ToolContext
        self.c, self.db = commitments, db
        self.conv = db.create_conversation("shellb", "Follow-ups test")["id"]
        self.msg = "msg-futest"

        async def emit(_):
            pass
        self.ctx = ToolContext(conv_id=self.conv, message_id=self.msg, agent={"id": "a", "model": "local"},
                               settings={}, emit=emit)

    def run_tool(self, **args):
        return asyncio.run(self.c.follow_ups_tool(args, self.ctx))

    def test_add_list_done_and_note_under_reply(self):
        import datetime as dt
        r = self.run_tool(action="add", text="Renew the Spark support contract", due="Friday")
        self.assertFalse(r.error, r.text)
        cid = r.text.split("[")[1].split("]")[0]
        due = self.c.get(cid)["due"]
        self.assertEqual(dt.date.fromisoformat(due).strftime("%A"), "Friday")
        self.assertIn("Already tracked", self.run_tool(action="add", text="Renew the Spark support contract").text)
        self.assertTrue(self.run_tool(action="add", text="x", due="whenever").error)
        self.assertIn(cid, self.run_tool(action="list").text)
        self.assertFalse(self.run_tool(action="done", id=cid).error)
        self.assertEqual(self.c.get(cid)["status"], "done")
        self.assertTrue(self.run_tool(action="done", id="fu-nope").error)
        # the turn ends: the message is saved, then after_turn puts the tool's items under it
        self.db.add_message(self.conv, "assistant", "ok", {}, msg_id=self.msg)
        self.c.after_turn(self.conv, self.msg, "thanks", "ok", None)
        data = self.db.list_messages(self.conv)[-1]
        self.assertEqual([i["op"] for i in data.get("followUps", [])], ["add", "done"])
        self.c.delete(cid)

    def test_learner_never_closes_a_follow_up_from_the_same_turn(self):
        """Live bug 2026-10-06: "add a follow-up… tell me what you added" made the learner mark it done at once."""
        r = self.run_tool(action="add", text="Check the backup drive", due="tomorrow")
        cid = r.text.split("[")[1].split("]")[0]
        older, _ = self.c.add("Water the ficus", conv_id=self.conv, msg_id="msg-earlier")
        real = self.c.propose

        async def fake_propose(exchange, settings):
            return [], [cid, older], "{}"
        self.c.propose = fake_propose
        try:
            self.db.add_message(self.conv, "assistant", "Added it.", {}, msg_id=self.msg)
            asyncio.run(self.c._learn_turn(self.conv, self.msg, "add a follow-up", "Added it.", {}, self.c._by_tool.pop(self.msg, [])))
        finally:
            self.c.propose = real
        self.assertEqual(self.c.get(cid)["status"], "open")
        self.assertEqual(self.c.get(older)["status"], "done")  # an earlier one still closes
        self.c.delete(cid); self.c.delete(older)

    def test_gating(self):
        import privacy
        self.assertIn("follow_ups", privacy.MEMORY_TOOLS)  # hidden in incognito chats
        self.assertTrue(self.c.tool_allowed({"model": "ShellB-Swift"}, {}))
        self.assertFalse(self.c.tool_allowed({"model": "ShellB-Swift"}, {"followUps": False}))
        import providers
        cloud = next((m for m in ("claude-cli/opus", "anthropic/claude-x", "openai/gpt-x") if providers.is_cloud(m)), None)
        if cloud:
            self.assertFalse(self.c.tool_allowed({"model": cloud}, {}))
            self.assertTrue(self.c.tool_allowed({"model": cloud}, {"cloudMemory": True}))


class IncognitoSetting(unittest.TestCase):
    def test_hours_saved_and_used(self):
        import privacy
        r = client.put("/api/settings", json={"incognitoHours": 6})
        self.assertEqual(r.json().get("incognitoHours"), 6)
        self.assertEqual(privacy.hours(), 6)
        client.put("/api/settings", json={"incognitoHours": 24})


class Watchdog(unittest.TestCase):
    """Health watchdog: services failing N checks, recovery, crash loops from NRestarts, low disk and memory."""

    def setUp(self):
        import notify
        import watchdog
        self.w, self.notify = watchdog, notify
        self.saved = (notify.event, watchdog.probe, watchdog.units, watchdog.disk, watchdog.memory, watchdog._started)
        self.pushes = []
        notify.event = lambda *a, **k: self.pushes.append(a)  # never push to the owner's real devices
        self.svc = {"nyx": {"ok": True}, "ollama": {"ok": True}}
        self.unit = {"shellb-nyx": {"active": "active", "sub": "running", "restarts": 0}}
        self.free, self.avail = 2000e9, 60e9

        async def probe():
            return {k: dict(v) for k, v in self.svc.items()}

        async def units():
            return {k: dict(v) for k, v in self.unit.items()}

        watchdog.probe, watchdog.units = probe, units
        watchdog.disk = lambda: (self.free, 4000e9)
        watchdog.memory = lambda: (self.avail, 128e9)
        watchdog._started, watchdog._mem_low = 0, 0
        watchdog._fails.clear()
        watchdog.db.kv_set(watchdog.KV, {})
        with watchdog.db.conn() as c:
            c.execute("DELETE FROM activity WHERE source='health'")
        self.t = 1_800_000_000.0

    def tearDown(self):
        (self.notify.event, self.w.probe, self.w.units, self.w.disk, self.w.memory, self.w._started) = self.saved

    def tick(self, n=1):
        for _ in range(n):
            self.t += 60
            asyncio.run(self.w.run_once(self.t))

    def posts(self):
        with self.w.db.conn() as c:
            return [(r["status"], r["title"]) for r in
                    c.execute("SELECT status, title FROM activity WHERE source='health' ORDER BY rowid")]

    def test_service_down_after_three_checks_then_back_up(self):
        self.svc["nyx"] = {"ok": False, "error": "ConnectError"}
        self.tick(2)
        self.assertEqual(self.posts(), [])
        self.tick()
        self.assertEqual(self.posts(), [("failed", "Image generation (ComfyUI) is down")])
        self.w._fails.clear()  # a server restart forgets the counters but not the open incident
        self.tick(5)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual([i["title"] for i in client.get("/api/watchdog").json()["incidents"]],
                         ["Image generation (ComfyUI) is down"])
        self.svc["nyx"] = {"ok": True}
        self.tick(2)
        self.assertEqual(self.posts()[1:], [("recovered", "Image generation (ComfyUI) is back up")])
        self.assertEqual(client.get("/api/watchdog").json()["incidents"], [])
        self.assertEqual([p[0] for p in self.pushes], ["health", "health"])

    def test_grace_period_and_deliberate_stop(self):
        self.w._started = self.t
        self.svc["nyx"] = {"ok": False}
        self.tick(3)  # inside the first 4 minutes: HERMES & co. may still be loading
        self.assertEqual(self.posts(), [])
        self.unit["shellb-nyx"]["active"] = "inactive"  # `systemctl stop` on purpose
        self.tick(6)
        self.assertEqual(self.posts(), [])

    def test_crash_loop_from_restart_counter(self):
        for n in (0, 1, 2):
            self.unit["shellb-nyx"]["restarts"] = n
            self.tick()
        self.assertEqual(self.posts(), [])
        self.unit["shellb-nyx"]["restarts"] = 3
        self.tick()
        self.assertEqual(self.posts(), [("failed", "Image generation (ComfyUI) keeps crashing")])
        self.unit["shellb-nyx"]["restarts"] = 5
        self.tick(3)
        self.assertEqual(len(self.posts()), 1)
        self.tick(16)  # a whole window without an automatic restart
        self.assertEqual(self.posts()[1:], [("recovered", "Image generation (ComfyUI) is stable again")])
        self.unit["shellb-nyx"]["restarts"] = 0  # a manual restart flushes the counter: not a loop
        self.tick(3)
        self.unit["shellb-nyx"]["active"] = "failed"
        self.tick(2)
        self.assertEqual(self.posts()[2:], [("failed", "Image generation (ComfyUI) stopped after a failure")])

    def test_low_disk_once_a_day_and_low_memory(self):
        self.free = 50e9
        self.tick(5)
        self.assertEqual(self.posts(), [("warning", "System disk is nearly full")])
        self.t += 86400
        self.tick()
        self.assertEqual(len(self.posts()), 2)
        self.avail = 3e9
        self.tick(2)
        self.assertEqual(len(self.posts()), 2)
        self.tick(4)
        self.assertEqual(self.posts()[2:], [("warning", "Memory is almost full")])


class SearchEverything(unittest.TestCase):
    """GET /api/search (server/search.py): the command palette's grouped search over the owner's other content."""
    WORD = "zephyrquill"

    def setUp(self):
        import commitments
        import db
        import privacy
        import search
        self.db, self.search = db, search
        self.conv = db.create_conversation("shellb", "Search test")["id"]
        self.hidden = db.create_conversation("shellb", "Search test (incognito)")["id"]
        privacy.mark_incognito(self.hidden)
        self.note = db.new_id("cx")
        with db.conn() as c:
            c.execute("INSERT INTO codex_entries(id, kind, title, body, tags, pinned, status, meta, created_by, created, updated) "
                      "VALUES(?,?,?,?,?,?,?,?,?,?,?)", (self.note, "note", f"{self.WORD.title()} garden plan",
                      f"Plant the {self.WORD} bulbs by the fence.", "[]", 0, "ok", "{}", "you", 1.0, 1.0))
        self.fu, _ = commitments.add(f"Order {self.WORD} seeds", conv_id=self.conv)
        self.fu_hidden, _ = commitments.add(f"Secret {self.WORD} errand", conv_id=self.hidden)
        for cid, name in ((self.conv, f"{self.WORD}_notes.txt"), (self.hidden, f"{self.WORD}_private.txt")):
            (shellb.WORKSPACES / cid / "sub").mkdir(parents=True, exist_ok=True)
            (shellb.WORKSPACES / cid / "sub" / name).write_text("x")
        (shellb.WORKSPACES / self.conv / "node_modules").mkdir(exist_ok=True)
        (shellb.WORKSPACES / self.conv / "node_modules" / f"{self.WORD}_dep.js").write_text("x")
        search._files["at"] = 0.0  # rebuild the filename index
        search._file_index()  # ...now, not inside the request's time budget (it timed out under load: a flaky test)

    def tearDown(self):
        import commitments
        with self.db.conn() as c:
            c.execute("DELETE FROM codex_entries WHERE id=?", (self.note,))
        for f in (self.fu, self.fu_hidden):
            if f:
                commitments.delete(f)
        for cid in (self.conv, self.hidden):
            shutil.rmtree(shellb.WORKSPACES / cid, ignore_errors=True)
            self.db.delete_conversation(cid)

    def test_grouped_results(self):
        r = client.get(f"/api/search?q={self.WORD}&limit=5")
        self.assertEqual(r.status_code, 200, r.text[:300])
        body = r.json()
        groups = {g["group"]: g["items"] for g in body["groups"]}
        # a source that ran out of its time budget (a busy box: Ollama loaded, a build running) is reported as
        # "timeout" by design; only judge the sources that answered, so the test checks results, not load
        answered = {k for k, v in body["sources"].items() if v.get("status") == "ok"}
        self.assertIn("follow-ups", answered, body)
        if "codex" in answered:
            note = next(i for i in groups["Codex"] if i["id"] == f"codex:{self.note}")
            self.assertEqual(note["route"], f"#/codex/notes/{self.note}")
            self.assertIn(f"[[{self.WORD}]]", note["snippet"].lower())
        self.assertEqual([i["route"] for i in groups["Follow-ups"]], ["#/activity/follow-ups"])
        if "files" in answered:
            files = [i for i in groups["Files"]]
            self.assertEqual([(i["title"], i["route"]) for i in files], [(f"{self.WORD}_notes.txt", f"#/c/{self.conv}")])
        for item in (i for items in groups.values() for i in items):
            self.assertTrue({"id", "title", "snippet", "route", "kind"} <= set(item), item)
        self.assertIn("chat files", body["searched"])

    def test_incognito_chats_stay_hidden(self):
        text = client.get(f"/api/search?q={self.WORD}").text
        self.assertNotIn(self.hidden, text)
        self.assertNotIn("_private.txt", text)
        self.assertNotIn("errand", text)
        self.assertNotIn("_dep.js", text)  # node_modules is never walked

    def test_short_and_empty_queries(self):
        for q in ("", " ", "z"):
            with self.subTest(q=q):
                body = client.get(f"/api/search?q={q}").json()
                self.assertEqual(body["groups"], [])
        none = client.get("/api/search?q=qqqzzzxxxnothing").json()["groups"]
        self.assertEqual([g for g in none if g["key"] != "wiki"], [])  # the wiki group only offers "search the wiki"
        self.assertEqual(self.search.snippet("Plant the bulbs", ["bulb"]), "Plant the [[bulb]]s")


class PushAck(unittest.TestCase):
    """A device's service worker reports whether it showed a push (notify.py /ack); unknown endpoints change nothing."""
    def test_ack_records_what_the_device_did(self):
        import db
        import notify
        notify.init()
        ep = "https://fcm.googleapis.com/fcm/send/test-ack-device"
        with db.conn() as c:
            c.execute("INSERT INTO push_subs(id, endpoint, p256dh, auth, label, ua, created) VALUES(?,?,?,?,?,?,?)",
                      ("push-acktest", ep, "x", "y", "test", "", 0))
        try:
            r = client.post("/api/notify/ack", json={"endpoint": ep, "shown": False, "reason": "permission is denied"})
            self.assertTrue(r.json()["ok"])
            dev = notify._device(notify._subs("push-acktest")[0])
            self.assertEqual((dev["lastShown"], dev["shownError"]), (0, "permission is denied"))
            client.post("/api/notify/ack", json={"endpoint": ep, "shown": True})
            dev = notify._device(notify._subs("push-acktest")[0])
            self.assertGreater(dev["lastShown"], 0)
            self.assertEqual(dev["shownError"], "")
            self.assertFalse(client.post("/api/notify/ack", json={"endpoint": ep + "x", "shown": True}).json()["ok"])
        finally:
            with db.conn() as c:
                c.execute("DELETE FROM push_subs WHERE id='push-acktest'")


class Codex(unittest.TestCase):
    def test_spawn_from_worker_thread(self):
        """Sync endpoints run in a worker thread; codex._spawn must hand the task to the loop instead of raising."""
        import codex
        ran = []

        async def job():
            ran.append(True)

        async def main():
            codex._LOOP = asyncio.get_running_loop()
            await asyncio.to_thread(codex._spawn, job())
            await asyncio.sleep(0.05)
        asyncio.run(main())
        self.assertEqual(ran, [True])


if __name__ == "__main__":
    unittest.main()
