"""Shell:B Guest (server/guests.py, server/guest_app.py): the guest port reaches only guest routes, a guest only their
own chats, files, memories and questions, and a guest turn is sealed off from the owner (no owner tools, mounts,
memories or approvals; no cloud or adult agents). Turns are faked like in public_api_test: app.begin_turn is swapped
for one that answers at once."""
import asyncio
import json
import secrets
import unittest

from fastapi.testclient import TestClient

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import agent as agent_mod
import db
import guest_app
import guests
import privacy
import tools
from roster import get_agents, get_settings

ADMIN = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}
lan = TestClient(shellb.app, client=("10.0.0.9", 50000), raise_server_exceptions=False)
CALLS: list[dict] = []
PASSWORD = "copper kettle on the hill"
(shellb.UI_DIST / "guest.html").write_text("<!doctype html><title>guest</title>")


def gclient() -> TestClient:
    """A browser on the guest port, coming in through the tunnel (loopback peer, forwarded client address)."""
    return TestClient(guest_app.root, base_url=f"http://testserver:{guest_app.GUEST_PORT}", client=("127.0.0.1", 40000),
                      raise_server_exceptions=False)


def fake_begin_turn(conv, body, stream=True, note="", adult_ok=False, interactive=None, api=None):
    CALLS.append({"conv": conv["id"], "body": body, "note": note, "api": api})
    queue: asyncio.Queue = asyncio.Queue()
    final = {"id": db.new_id("msg"), "role": "assistant", "content": "Hi", "status": "complete", "blocks": []}

    async def run():
        for ev in ({"type": "start"}, {"type": "done", "message": final}, None):
            await queue.put(ev)
        return final
    return queue, asyncio.get_running_loop().create_task(run())


def local_model() -> str:
    return next(a["model"] for a in get_agents() if a["id"] == get_settings()["defaultAgent"])


def make_guest(name="Sam", **config) -> tuple[dict, TestClient]:
    """A guest who took their invite: an account made and this client signed in (guest_accounts_test has the rest)."""
    g, code = guests.create_guest(name, config or None)
    c = gclient()
    r = c.post("/api/guest/signup", json={"code": code, "username": f"u{secrets.token_hex(5)}", "password": PASSWORD})
    assert r.status_code == 200, r.text
    return guests.get_guest(g["id"]), c


class Base(unittest.TestCase):
    def setUp(self):
        self._real = shellb.begin_turn
        shellb.begin_turn = fake_begin_turn
        CALLS.clear()
        guests._codes_tried.clear()
        guest_app._hits.clear()
        db.kv_set("guest_settings", {"models": [local_model()]})

    def tearDown(self):
        shellb.begin_turn = self._real


class Ports(Base):
    OWNER_ROUTES = ["/api/settings", "/api/memories", "/api/memory", "/api/codex/collections", "/api/codex/secrets/x", "/api/ssh/hosts", "/api/apikeys",
                    "/api/guests", "/api/selfmod/status", "/api/library", "/api/activity", "/api/providers",
                    "/api/cli-agents", "/api/status", "/api/tools", "/api/models", "/api/mcp/servers", "/docs",
                    "/openapi.json"]

    def test_owner_routes_dont_exist_on_the_guest_port(self):
        g, c = make_guest()
        for path in self.OWNER_ROUTES:
            with self.subTest(path=path):
                r = c.get(path, headers=ADMIN)  # a signed-in guest, the admin key and a loopback peer: still nothing
                if path.startswith("/api/"):
                    self.assertEqual(r.status_code, 404)
                else:  # the SPA fallback: the guest page, never Swagger or the schema
                    self.assertIn("<title>guest</title>", r.text)

    def test_owner_writes_dont_exist_either(self):
        g, c = make_guest()
        for method, path in (("PUT", "/api/settings"), ("POST", "/api/apikeys"), ("POST", "/api/guests"),
                             ("POST", "/api/memories"), ("PUT", "/api/agents/shellb")):
            with self.subTest(path=path):
                self.assertEqual(c.request(method, path, json={}, headers=ADMIN).status_code, 404)

    def test_the_owner_port_ignores_guest_cookies(self):
        g, c = make_guest()
        cookie = c.cookies.get(guests.COOKIE)
        self.assertTrue(cookie)
        r = lan.get("/api/conversations", cookies={guests.COOKIE: cookie})
        self.assertEqual(r.status_code, 401)

    def test_root_routes_by_port(self):
        owner_side = TestClient(guest_app.root, base_url="http://testserver:8200", client=("127.0.0.1", 40000))
        self.assertEqual(owner_side.get("/api/settings").status_code, 200)  # localhost on the owner port, as before
        self.assertEqual(gclient().get("/api/settings").status_code, 401)  # the outer wall, before the 404

    def test_guest_ui_not_owner_ui(self):
        c = gclient()
        for path in ("/", "/index.html", "/some/deep/link"):
            self.assertIn("<title>guest</title>", c.get(path).text)
        self.assertEqual(c.get("/assets/nope.js").status_code, 404)


class SignIn(Base):
    def test_invite_works_once(self):
        g, code = guests.create_guest("Ana")
        c = gclient()
        self.assertFalse(c.get("/api/auth/me").json()["authenticated"])
        self.assertEqual(c.get("/api/conversations").status_code, 401)
        self.assertEqual(c.post("/api/guest/redeem", json={"code": code}).status_code, 409)  # not a device code
        self.assertEqual(c.post("/api/guest/signup", json={"code": code, "username": "ana-k", "password": PASSWORD}).status_code, 200)
        me = c.get("/api/auth/me").json()
        self.assertTrue(me["authenticated"])
        self.assertEqual(me["guest"]["name"], "Ana")
        again = gclient().post("/api/guest/signup", json={"code": code, "username": "ana-k2", "password": PASSWORD})
        self.assertEqual(again.status_code, 401)

    def test_bad_codes_are_throttled_apart_from_the_owner_login(self):
        c = gclient()
        for _ in range(10):
            self.assertEqual(c.post("/api/guest/redeem", json={"code": "nope"}).status_code, 401)
        self.assertEqual(c.post("/api/guest/redeem", json={"code": "nope"}).status_code, 429)
        self.assertNotIn("127.0.0.1", __import__("auth")._IP_FAILS)  # the owner's lockout counters are untouched

    def test_device_code(self):
        g, c = make_guest()
        code = c.post("/api/guest/device-code").json()["code"]
        other = gclient()
        self.assertEqual(other.post("/api/guest/redeem", json={"code": code.lower()}).status_code, 200)
        self.assertEqual(len(c.get("/api/guest/me").json()["devices"]), 2)

    def test_disabled_guest_is_signed_out(self):
        g, c = make_guest()
        guests.update_guest(g["id"], {"disabled": True})
        self.assertEqual(c.get("/api/conversations").status_code, 401)

    def test_foreign_origin_refused(self):
        g, c = make_guest()
        r = c.post("/api/conversations", json={}, headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)


class Isolation(Base):
    def test_guests_see_only_their_own_chats(self):
        a, ca = make_guest("A")
        b, cb = make_guest("B")
        conv = ca.post("/api/conversations", json={}).json()
        self.assertEqual(cb.get(f"/api/conversations/{conv['id']}").status_code, 404)
        self.assertEqual(cb.delete(f"/api/conversations/{conv['id']}").status_code, 404)
        self.assertEqual(cb.post(f"/api/conversations/{conv['id']}/chat", json={"content": "hi"}).status_code, 404)
        self.assertEqual(cb.get(f"/api/workspace/{conv['id']}").status_code, 404)
        self.assertEqual([x["id"] for x in ca.get("/api/conversations").json()], [conv["id"]])
        self.assertEqual(cb.get("/api/conversations").json(), [])

    def test_owner_chats_are_unreachable(self):
        owner_conv = db.create_conversation(get_settings()["defaultAgent"])
        g, c = make_guest()
        self.assertEqual(c.get(f"/api/conversations/{owner_conv['id']}").status_code, 404)
        self.assertEqual(c.get(f"/api/workspace/{owner_conv['id']}/x.txt").status_code, 404)

    def test_guest_chats_stay_out_of_the_owners_lists_and_sweep(self):
        g, c = make_guest()
        conv = c.post("/api/conversations", json={}).json()
        self.assertTrue(db.get_conversation(conv["id"])["incognito"])
        self.assertNotIn(conv["id"], {x["id"] for x in db.list_conversations()})
        with db.conn() as k:
            k.execute("UPDATE conversations SET updated=0 WHERE id=?", (conv["id"],))
        self.assertNotIn(conv["id"], privacy.expired())

    def test_generated_files_belong_to_their_guest(self):
        a, ca = make_guest("A")
        b, cb = make_guest("B")
        conv = ca.post("/api/conversations", json={}).json()
        (tools.FILES / "pic-abc12345.png").write_bytes(b"\x89PNG")
        (tools.FILES / "owner-deadbeef.png").write_bytes(b"\x89PNG")
        guests.after_tool(a["id"], conv["id"], "generate_image",
                          tools.ToolResult("ok", {"prompt": "x", "images": ["/api/files/pic-abc12345.png"]}))
        self.assertEqual(ca.get("/api/files/pic-abc12345.png").status_code, 200)
        self.assertEqual(cb.get("/api/files/pic-abc12345.png").status_code, 404)
        self.assertEqual(ca.get("/api/files/owner-deadbeef.png").status_code, 404)
        self.assertEqual(guests.usage(a["id"])["images"], 1)

    def test_frame_keys_reach_only_their_guests_chat(self):
        a, ca = make_guest("A")
        b, _ = make_guest("B")
        conv = ca.post("/api/conversations", json={}).json()
        ws = tools.WORKSPACES / conv["id"]
        ws.mkdir(exist_ok=True)
        (ws / "data.json").write_text("{}")
        scope = f"w-{conv['id']}"
        good = f"/api/k/{scope}.{__import__('auth').frame_mac(guests.frame_secret(a['id']), scope)}"
        bad = f"/api/k/{scope}.{__import__('auth').frame_mac(guests.frame_secret(b['id']), scope)}"
        anon = gclient()  # sandboxed frames carry no cookie
        self.assertEqual(anon.get(f"{good}/workspace/{conv['id']}/data.json").status_code, 200)
        self.assertEqual(anon.get(f"{bad}/workspace/{conv['id']}/data.json").status_code, 404)
        self.assertEqual(anon.get(f"{good}/appstate/boot.js", params={"s": f"art:{conv['id']}:a1"}).status_code, 200)
        self.assertEqual(anon.get(f"{good}/appstate/boot.js", params={"s": "art:conv-other:a1"}).status_code, 404)
        self.assertEqual(anon.get(f"{good}/settings").status_code, 404)

    def test_memories_are_per_guest(self):
        a, ca = make_guest("A")
        b, cb = make_guest("B")
        with db.conn() as k:
            k.execute("INSERT INTO guest_memories(id, guest_id, text, category, created) VALUES('gmem-1', ?, 'likes tea', "
                      "'preference', 1)", (a["id"],))
        self.assertEqual([m["id"] for m in ca.get("/api/guest/memories").json()], ["gmem-1"])
        self.assertEqual(cb.get("/api/guest/memories").json(), [])
        self.assertEqual(cb.delete("/api/guest/memories/gmem-1").status_code, 404)
        res = asyncio.run(guests.memory_tool(b["id"], "c", "memory_forget", {"id": "gmem-1"}, get_settings()))
        self.assertTrue(res.error)


class Turns(Base):
    def test_chat_runs_a_sealed_guest_turn(self):
        g, c = make_guest("Sam")
        conv = c.post("/api/conversations", json={}).json()
        foreign = db.create_conversation(get_settings()["defaultAgent"])
        atts = [{"kind": "image", "url": f"/api/workspace/{conv['id']}/a.png", "name": "a.png"},
                {"kind": "image", "url": f"/api/workspace/{foreign['id']}/b.png", "name": "b.png"},
                {"kind": "ref", "url": "/api/codex/x", "name": "codex"}]
        r = c.post(f"/api/conversations/{conv['id']}/chat",
                   json={"content": "hello", "attachments": atts, "model": "claude-code/opus", "mode": "plan"})
        self.assertEqual(r.status_code, 200, r.text)
        events = [json.loads(line[6:]) for line in r.text.split("\n\n") if line.startswith("data: ")]
        self.assertEqual(events[-1]["type"], "done")
        call = CALLS[-1]
        self.assertEqual(call["api"]["mode"], "guest")
        self.assertEqual(call["api"]["tenant"], g["id"])
        self.assertIn("Sam", call["note"])
        self.assertEqual([a["name"] for a in call["body"]["attachments"]], ["a.png"])
        self.assertNotIn("model", call["body"])
        self.assertNotIn("mode", call["body"])
        self.assertEqual(guests.usage(g["id"])["turns"], 1)

    def test_daily_cap(self):
        g, c = make_guest(turnsPerDay=1)
        conv = c.post("/api/conversations", json={}).json()
        self.assertEqual(c.post(f"/api/conversations/{conv['id']}/chat", json={"content": "one"}).status_code, 200)
        self.assertEqual(c.post(f"/api/conversations/{conv['id']}/chat", json={"content": "two"}).status_code, 429)

    def test_only_shared_local_agents(self):
        g, c = make_guest()
        ids = {a["id"] for a in c.get("/api/agents").json()}
        self.assertTrue(ids)
        for a in get_agents():
            if a.get("adult") or "/" in a["model"]:
                self.assertNotIn(a["id"], ids)
        self.assertTrue(all("systemPrompt" not in a for a in c.get("/api/agents").json()))
        self.assertEqual(c.post("/api/conversations", json={"agentId": "claude"}).status_code, 404)

    def test_begin_turn_refuses_cloud_agents_for_guests(self):
        shellb.begin_turn = self._real
        g, _ = make_guest()
        conv = guests.create_conversation(g, get_settings()["defaultAgent"])
        cloud = next((a for a in get_agents() if "/" in a["model"]), None)
        if not cloud:
            self.skipTest("no cloud agent in the roster")
        with self.assertRaises(RuntimeError):
            shellb.begin_turn(conv, {"content": "hi", "agentId": cloud["id"]}, api=guests.turn_api(g))

    def test_guest_turn_offers_only_guest_tools(self):
        g, _ = make_guest()
        conv = guests.create_conversation(g, get_settings()["defaultAgent"])
        everything = [t for t in tools.TOOLS]
        a = {**next(x for x in get_agents() if x["id"] == get_settings()["defaultAgent"]), "tools": everything + ["mcp:github"]}
        turn = agent_mod.Turn(conv["id"], "m", a, get_agents(), get_settings(), None, asyncio.Event())
        turn.interactive = True
        turn.only_tools = set(guests.tools_allowed(g))
        turn.tenant = g["id"]
        names = turn.enabled_tools({"capabilities": ["tools", "vision"], "numCtx": 8192})
        self.assertTrue(set(names) <= set(guests.GUEST_TOOLS), set(names) - set(guests.GUEST_TOOLS))
        for t in ("memory_save", "memory_search", "run_code", "ask_user"):
            self.assertIn(t, names)
        for t in ("shellb_self", "codex", "ask_agent", "library", "schedule_task", "browser", "http_request", "shop"):
            self.assertNotIn(t, names)
        self.assertEqual(turn.mcp_specs, {})

    def test_owner_voices_are_refused(self):
        self.assertIsNone(guests.before_tool("g", "generate_voice", {"voice": "af_heart"}))
        self.assertTrue(guests.before_tool("g", "generate_voice", {"voice": "qwen:cortana"}))
        self.assertTrue(guests.before_tool("g", "generate_voice", {"lines": [{"text": "x", "voice": "qwen:mine"}]}))

    def test_sandbox_mounts_nothing_of_the_owners(self):
        seen = {}

        async def fake_exec(*cmd, **kw):
            seen["cmd"] = cmd
            raise RuntimeError("stop here")
        real = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            ctx = tools.ToolContext("conv-guesttest", "m", {"tools": ["run_code"]}, get_settings(), None, tenant="guest-x")
            with self.assertRaises(RuntimeError):
                asyncio.run(tools.run_code({"code": "print(1)"}, ctx))
        finally:
            asyncio.create_subprocess_exec = real
        joined = " ".join(seen["cmd"])
        self.assertNotIn(":/skills", joined)
        self.assertNotIn(":/library", joined)
        self.assertIn("--network none", joined)


class Apps(Base):
    def test_messages_and_tokens_are_unlimited_by_default(self):
        g, _ = guests.create_guest("Unlimited")
        self.assertEqual((g["config"]["turnsPerDay"], g["config"]["tokensPerDay"]), (0, 0))
        for _ in range(3):
            guests._bump(g["id"], "turns")
        guests.check_turn(g)  # no cap, no 429

    def test_shared_reads_need_a_session(self):
        anon = gclient()
        for path in ("/api/wiki/sources", "/api/maps/catalog", "/api/worlds/notes", "/api/codex/notes/titles"):
            with self.subTest(path=path):
                self.assertEqual(anon.get(path).status_code, 401)
        g, c = make_guest()
        for path in ("/api/wiki/sources", "/api/maps/catalog"):
            with self.subTest(path=path):
                self.assertEqual(c.get(path).status_code, 200, path)
        self.assertNotIn(c.get("/api/worlds/notes").status_code, (401, 404))  # reached (it wants a feature query)
        self.assertEqual(c.get("/api/codex").json()["counts"]["all"], 0)  # their own notes index, not the owner's Codex

    def test_worlds_notes_are_read_only(self):
        g, c = make_guest()
        self.assertEqual(c.post("/api/worlds/notes", json={"key": "x", "title": "y"}).status_code, 404)
        self.assertEqual(c.request("DELETE", "/api/worlds/notes", params={"key": "x"}).status_code, 404)

    def test_notes_are_the_guests_own(self):
        a, ca = make_guest("A")
        b, cb = make_guest("B")
        owner_titles = {r["title"] for r in client.get("/api/codex/notes/titles").json()}
        n = ca.post("/api/codex/entries", json={"kind": "note", "title": "Trip", "body": "See [[Packing]]", "tags": ["travel"]}).json()
        p = ca.post("/api/codex/entries", json={"kind": "note", "title": "Packing", "body": "socks"}).json()
        self.assertEqual({x["title"] for x in ca.get("/api/codex/notes/titles").json()}, {"Trip", "Packing"})
        self.assertEqual(cb.get("/api/codex/notes/titles").json(), [])
        self.assertEqual(cb.get(f"/api/codex/entries/{n['id']}").status_code, 404)
        self.assertEqual(cb.patch(f"/api/codex/entries/{n['id']}", json={"body": "x"}).status_code, 404)
        self.assertEqual([x["title"] for x in ca.get(f"/api/codex/entries/{p['id']}/backlinks").json()], ["Trip"])
        ca.patch(f"/api/codex/entries/{p['id']}", json={"title": "Luggage"})
        self.assertEqual(len(ca.post(f"/api/codex/entries/{p['id']}/relink", json={"from": "Packing", "to": "Luggage"}).json()["updated"]), 1)
        self.assertIn("[[Luggage]]", ca.get(f"/api/codex/entries/{n['id']}").json()["body"])
        self.assertEqual(ca.get("/api/codex").json()["tags"], [["travel", 1]])
        self.assertEqual(ca.post("/api/codex/entries", json={"kind": "contact", "title": "x"}).status_code, 400)
        # nothing landed in the owner's Codex
        self.assertEqual({r["title"] for r in client.get("/api/codex/notes/titles").json()}, owner_titles)
        guests.delete_guest(a["id"])
        with db.conn() as k:
            self.assertEqual(k.execute("SELECT count(*) FROM guest_notes WHERE guest_id=?", (a["id"],)).fetchone()[0], 0)


class Questions(Base):
    def test_only_the_asking_guest_can_answer(self):
        a, ca = make_guest("A")
        b, cb = make_guest("B")

        async def scenario():
            class S:
                blocks = [{}]

                async def update(self, idx):
                    pass
            sink = S()
            task = asyncio.create_task(guests.ask_user(a["id"], {"questions": [{"question": "Tea?", "options": [
                {"label": "Yes"}, {"label": "No"}]}]}, "conv", asyncio.Event(), sink, 0))
            await asyncio.sleep(0.05)
            aid = sink.blocks[0]["approval"]["id"]
            self.assertFalse(guests.answer_question(b, aid, answers=[{"selected": ["Yes"]}]))
            self.assertTrue(guests.answer_question(a, aid, decision="deny"))
            return await task
        res = asyncio.run(scenario())
        self.assertIn("dismissed", res.text)
        import remote
        self.assertEqual(remote._pending, {})  # nothing went to the owner's approvals


class Owner(Base):
    def test_management_is_admin_only(self):
        self.assertEqual(lan.get("/api/guests").status_code, 401)
        self.assertEqual(client.post("/api/guests", json={"name": "x"}).status_code, 403)  # localhost isn't admin
        r = client.post("/api/guests", json={"name": "Jo", "config": {"imagesPerDay": 3}}, headers=ADMIN)
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIn("#invite=", body["link"])
        self.assertEqual(body["guest"]["config"]["imagesPerDay"], 3)
        listed = client.get("/api/guests", headers=ADMIN).json()
        self.assertIn(body["guest"]["id"], {g["id"] for g in listed["guests"]})

    def test_delete_wipes_everything(self):
        g, c = make_guest()
        conv = c.post("/api/conversations", json={}).json()
        self.assertEqual(client.delete(f"/api/guests/{g['id']}", headers=ADMIN).status_code, 200)
        self.assertIsNone(db.get_conversation(conv["id"]))
        self.assertEqual(c.get("/api/conversations").status_code, 401)

    def test_report_reaches_the_owner(self):
        g, c = make_guest("Kim")
        conv = c.post("/api/conversations", json={}).json()
        db.add_message(conv["id"], "user", "draw a cat")
        r = c.post("/api/guest/report", json={"text": "The picture never showed up", "convId": conv["id"], "includeChat": True})
        self.assertEqual(r.status_code, 200)
        rep = next(x for x in client.get("/api/guests/reports", headers=ADMIN).json() if x["id"] == r.json()["id"])
        self.assertEqual(rep["guestName"], "Kim")
        self.assertIn("draw a cat", rep["transcript"])
        with db.conn() as k:
            self.assertTrue(k.execute("SELECT 1 FROM activity WHERE ref=?", (rep["id"],)).fetchone())


if __name__ == "__main__":
    unittest.main()
