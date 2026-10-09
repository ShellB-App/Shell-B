"""Shell:B API (server/public_api.py): keys are required on every /api/v1 call (not even localhost or the owner's cookie
get in without one), a key only reaches its own chats and agents, adult agents never answer, and the OpenAI-compatible
endpoints have OpenAI's shapes. Turns are faked: public_api.begin_turn is swapped for one that answers at once."""
import asyncio
import json
import unittest

import httpx

from fastapi.testclient import TestClient

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import db
import public_api
from roster import get_agents

lan = TestClient(shellb.app, client=("10.0.0.9", 50000), raise_server_exceptions=False)
CALLS: list[dict] = []


def fake_begin_turn(conv, body, stream=True, note="", adult_ok=False, interactive=None, api=None):
    CALLS.append({"conv": conv["id"], "body": body, "note": note, "interactive": interactive, "stream": stream, "api": api})
    db.add_message(conv["id"], "user", body["content"])
    queue: asyncio.Queue = asyncio.Queue()
    final = {"id": db.new_id("msg"), "role": "assistant", "agentId": body["agentId"], "model": "fake", "status": "complete",
             "content": "Hello\n\nworld", "usage": {"prompt": 7, "completion": 3}, "durationMs": 5,
             "blocks": [{"type": "thinking", "text": "hm"}, {"type": "text", "text": "Hello"},
                        {"type": "tool", "name": "web_search", "status": "done"}, {"type": "text", "text": "world"}]}

    async def run():
        for ev in ({"type": "start"}, {"type": "memories", "memories": ["secret"]},
                   {"type": "block_start", "index": 0, "block": {"type": "thinking", "text": ""}},
                   {"type": "block_delta", "index": 0, "text": "hm"},
                   {"type": "block_start", "index": 1, "block": {"type": "text", "text": ""}},
                   {"type": "block_delta", "index": 1, "text": "Hello"},
                   {"type": "block_start", "index": 2, "block": {"type": "tool", "name": "web_search"}},
                   {"type": "block_start", "index": 3, "block": {"type": "text", "text": "world"}},
                   {"type": "done", "message": final}, None):
            await queue.put(ev)
        db.add_message(conv["id"], "assistant", final["content"], {"agentId": body["agentId"], "status": "complete"}, msg_id=final["id"])
        return final
    return queue, asyncio.get_running_loop().create_task(run())


def key(**kw) -> tuple[dict, str]:
    k, token = public_api.create_key(kw.pop("name", "Test"), **kw)
    return k, {"Authorization": f"Bearer {token}"}


def normal_agent() -> str:
    return next(a["id"] for a in get_agents() if not a.get("adult"))


class Base(unittest.TestCase):
    def setUp(self):
        self._real = public_api.begin_turn
        public_api.begin_turn = fake_begin_turn
        public_api._recent.clear()
        CALLS.clear()

    def tearDown(self):
        public_api.begin_turn = self._real


class Access(Base):
    def test_a_key_is_required_everywhere(self):
        for c in (lan, client):  # localhost trust doesn't open the API either
            self.assertEqual(c.get("/api/v1/agents").status_code, 401)
            self.assertEqual(c.post("/api/v1/chat", json={"message": "hi"}).status_code, 401)
        self.assertEqual(lan.get("/api/v1/agents", headers={"Authorization": "Bearer sbk_nope"}).status_code, 401)

    def test_key_management_is_admin_only(self):
        self.assertEqual(lan.get("/api/apikeys").status_code, 401)  # not even routed for strangers
        self.assertEqual(client.post("/api/apikeys", json={"name": "x"}).status_code, 403)  # localhost isn't admin
        admin = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}
        r = client.post("/api/apikeys", json={"name": "n8n"}, headers=admin)
        self.assertEqual(r.status_code, 200)
        token = r.json()["token"]
        self.assertTrue(token.startswith("sbk_"))
        self.assertNotIn("token", client.get("/api/apikeys", headers=admin).json()[0])
        with db.conn() as c:  # only the hash is stored
            self.assertFalse(c.execute("SELECT 1 FROM api_keys WHERE hash=?", (token,)).fetchone())
        self.assertEqual(lan.get("/api/v1/ping", headers={"Authorization": f"Bearer {token}"}).json()["key"]["name"], "n8n")
        self.assertEqual(client.delete(f"/api/apikeys/{r.json()['id']}", headers=admin).status_code, 200)
        self.assertEqual(lan.get("/api/v1/ping", headers={"Authorization": f"Bearer {token}"}).status_code, 401)

    def test_adult_agents_never_answer(self):
        adult = [a["id"] for a in get_agents() if a.get("adult")]
        _, h = key()
        ids = {a["id"] for a in lan.get("/api/v1/agents", headers=h).json()}
        self.assertFalse(ids & set(adult))
        for a in adult:
            self.assertEqual(lan.post("/api/v1/chat", json={"message": "hi", "agent": a}, headers=h).status_code, 404)

    def test_agent_allowlist(self):
        aid = normal_agent()
        other = next(a["id"] for a in get_agents() if not a.get("adult") and a["id"] != aid)
        _, h = key(agents=[aid])
        self.assertEqual([a["id"] for a in lan.get("/api/v1/agents", headers=h).json()], [aid])
        self.assertEqual(lan.post("/api/v1/chat", json={"message": "hi", "agent": other}, headers=h).status_code, 404)

    def test_a_key_sees_only_its_own_chats(self):
        _, a = key(name="A")
        _, b = key(name="B")
        conv = lan.post("/api/v1/chat", json={"message": "hi", "agent": normal_agent()}, headers=a).json()["conversation"]
        self.assertEqual(lan.get(f"/api/v1/conversations/{conv}", headers=a).status_code, 200)
        self.assertEqual(lan.get(f"/api/v1/conversations/{conv}", headers=b).status_code, 404)
        self.assertEqual(lan.post("/api/v1/chat", json={"message": "x", "conversation": conv}, headers=b).status_code, 404)
        owners = db.list_conversations()[0]["id"]  # an owner chat is out of reach too
        if owners != conv:
            self.assertEqual(lan.get(f"/api/v1/conversations/{owners}", headers=a).status_code, 404)
        self.assertEqual([c["id"] for c in lan.get("/api/v1/conversations", headers=b).json()], [])

    def test_rate_limit(self):
        _, h = key()
        codes = [lan.get("/api/v1/ping", headers=h).status_code for _ in range(public_api.PER_MINUTE + 1)]
        self.assertEqual(codes[-1], 429)


class Turns(Base):
    def test_chat_runs_an_unattended_turn_marked_as_api(self):
        _, h = key(name="Home Assistant")
        r = lan.post("/api/v1/chat", json={"message": "lights?", "instructions": "be brief"}, headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["message"]["content"], "Hello\n\nworld")
        self.assertEqual(out["message"]["tools"], [{"name": "web_search", "status": "done"}])
        call = CALLS[-1]
        self.assertIs(call["interactive"], False)
        self.assertEqual(set(call["body"]), {"content", "agentId"})  # nothing else from the caller reaches begin_turn
        self.assertIn("Home Assistant", call["note"])
        self.assertIn("be brief", call["note"])
        msgs = lan.get(f"/api/v1/conversations/{out['conversation']}", headers=h).json()["messages"]
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant"])

    def test_stream_hides_ui_only_events(self):
        _, h = key()
        with lan.stream("POST", "/api/v1/chat", json={"message": "hi", "stream": True}, headers=h) as r:
            evs = [json.loads(line[6:]) for line in r.iter_lines() if line.startswith("data: ")]
        self.assertNotIn("memories", {e["type"] for e in evs})
        self.assertEqual(evs[-1]["type"], "done")

    def test_incognito_key(self):
        _, h = key(incognito=True)
        conv = lan.post("/api/v1/chat", json={"message": "hi"}, headers=h).json()["conversation"]
        self.assertTrue(db.get_conversation(conv).get("incognito"))


class OpenAI(Base):
    def test_models_and_completion(self):
        _, h = key()
        models = lan.get("/api/v1/models", headers=h).json()
        self.assertEqual(models["object"], "list")
        aid = models["data"][0]["id"]
        r = lan.post("/api/v1/chat/completions", headers=h, json={"model": aid, "messages": [
            {"role": "system", "content": "Answer in French."},
            {"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"},
            {"role": "user", "content": [{"type": "text", "text": "how are you"}]}]})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["object"], "chat.completion")
        self.assertEqual(out["choices"][0]["message"], {"role": "assistant", "content": "Hello\n\nworld"})
        self.assertEqual(out["usage"], {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10})
        self.assertIn("Answer in French.", CALLS[-1]["note"])
        self.assertEqual(CALLS[-1]["body"]["content"], "how are you")
        conv = r.headers["x-shellb-conversation"]
        self.assertEqual([m["content"] for m in db.list_messages(conv)][:2], ["hi", "hello"])  # seeded history
        # continuing the chat sends only the new message
        r = lan.post("/api/v1/chat/completions", headers={**h, "X-Shellb-Conversation": conv},
                     json={"model": "shellb", "messages": [{"role": "user", "content": "again"}]})
        self.assertEqual(r.headers["x-shellb-conversation"], conv)
        self.assertEqual(CALLS[-1]["conv"], conv)

    def test_streamed_completion(self):
        _, h = key()
        with lan.stream("POST", "/api/v1/chat/completions", headers=h,
                        json={"model": "shellb", "stream": True, "messages": [{"role": "user", "content": "hi"}]}) as r:
            lines = [x[6:] for x in r.iter_lines() if x.startswith("data: ")]
        self.assertEqual(lines[-1], "[DONE]")
        chunks = [json.loads(x) for x in lines[:-1]]
        text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks)
        self.assertEqual(text, "Hello\n\nworld")  # same as the saved reply
        self.assertEqual("".join(c["choices"][0]["delta"].get("reasoning_content", "") for c in chunks), "hm")
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "stop")

    def test_must_end_with_user(self):
        _, h = key()
        r = lan.post("/api/v1/chat/completions", headers=h, json={"model": "shellb", "messages": [{"role": "system", "content": "x"}]})
        self.assertEqual(r.status_code, 400)


def admin() -> dict:
    return {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}


def rows(key_id=None) -> list[dict]:
    return public_api.usage_log(key_id, limit=50)


class Modes(Base):
    def test_persona_turns_are_sealed(self):
        k, h = key(name="Contec bot", mode="persona",
                   config={"instructions": "Help with Contec embedded PCs only.", "tools": ["web_search", "codex", "run_code"]})
        self.assertEqual(k["config"]["tools"], ["web_search"])  # only PERSONA_TOOLS survive
        r = lan.post("/api/v1/chat", json={"message": "which board?", "instructions": "be brief"}, headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        call = CALLS[-1]
        self.assertEqual(call["api"], {"mode": "persona", "tools": ["web_search"]})
        self.assertIn("not the owner", call["note"])
        self.assertIn("Help with Contec embedded PCs only.", call["note"])
        self.assertLess(call["note"].index("Your brief"), call["note"].index("be brief"))  # owner's brief comes first
        self.assertTrue(db.get_conversation(r.json()["conversation"]).get("incognito"))

    def test_agent_keys_are_not_sealed(self):
        _, h = key()
        lan.post("/api/v1/chat", json={"message": "hi"}, headers=h)
        self.assertIsNone(CALLS[-1]["api"])

    def test_admin_rejects_bad_persona_tools_and_cloud_raw_models(self):
        r = client.post("/api/apikeys", headers=admin(), json={"name": "x", "mode": "persona", "config": {"tools": ["codex"]}})
        self.assertEqual(r.status_code, 400)
        r = client.post("/api/apikeys", headers=admin(), json={"name": "x", "mode": "raw", "config": {"model": "claude-code/opus"}})
        self.assertEqual(r.status_code, 400)

    def test_owner_context_left_out(self):
        import codex
        import prompts
        real = codex.upcoming_schedule_prompt
        codex.upcoming_schedule_prompt = lambda now, days=14: "OWNER CALENDAR"
        try:
            agent = next(a for a in get_agents() if not a.get("adult"))
            args = (agent, [], "medium", [], [], get_agents(), {})
            self.assertIn("OWNER CALENDAR", prompts.build_system(*args))
            self.assertNotIn("OWNER CALENDAR", prompts.build_system(*args, owner_context=False))
        finally:
            codex.upcoming_schedule_prompt = real


class Limits(Base):
    def test_disabled_key(self):
        _, h = key(config={"disabled": True})
        self.assertEqual(lan.get("/api/v1/ping", headers=h).status_code, 403)

    def test_per_minute_and_daily(self):
        _, h = key(config={"perMinute": 3})
        self.assertEqual([lan.get("/api/v1/ping", headers=h).status_code for _ in range(4)][-1], 429)
        _, h = key(config={"dailyRequests": 2})
        self.assertEqual([lan.get("/api/v1/ping", headers=h).status_code for _ in range(3)], [200, 200, 429])

    def test_edit_keeps_the_token(self):
        k, h = key(name="Old")
        r = client.patch(f"/api/apikeys/{k['id']}", headers=admin(), json={"name": "New", "config": {"disabled": True}})
        self.assertEqual(r.json()["name"], "New")
        self.assertEqual(lan.get("/api/v1/ping", headers=h).status_code, 403)
        client.patch(f"/api/apikeys/{k['id']}", headers=admin(), json={"config": {"disabled": False}})
        self.assertEqual(lan.get("/api/v1/ping", headers=h).json()["key"]["name"], "New")


class Usage(Base):
    def test_every_call_is_logged(self):
        k, h = key(name="Audited")
        lan.post("/api/v1/chat", json={"message": "secret plans"}, headers=h)
        row = rows(k["id"])[0]
        self.assertEqual((row["endpoint"], row["status"], row["prompt_tokens"], row["completion_tokens"]), ("chat", 200, 7, 3))
        self.assertEqual(row["tools"], ["web_search"])
        self.assertEqual(row["ip"], "10.0.0.9")
        self.assertNotIn("request", row)  # content isn't kept unless the key says so
        lan.get("/api/v1/agents", headers={"Authorization": "Bearer sbk_wrong"})
        self.assertEqual(rows()[0]["status"], 401)
        self.assertNotIn("key_id", rows()[0])

    def test_content_logging_and_streams(self):
        k, h = key(config={"logContent": True})
        with lan.stream("POST", "/api/v1/chat/completions", headers=h,
                        json={"model": "shellb", "stream": True, "messages": [{"role": "user", "content": "hi there"}]}) as r:
            list(r.iter_lines())
        row = rows(k["id"])[0]
        self.assertEqual((row["request"], row["reply"], row["completion_tokens"]), ("hi there", "Hello\n\nworld", 3))

    def test_owner_reads_usage(self):
        k, h = key()
        lan.get("/api/v1/ping", headers=h)
        self.assertEqual(lan.get(f"/api/apikeys/{k['id']}/usage").status_code, 401)
        out = client.get(f"/api/apikeys/{k['id']}/usage", headers=admin()).json()
        self.assertEqual(out["totals"]["calls"], 1)
        self.assertEqual(out["log"][0]["endpoint"], "ping")
        self.assertIn(k["id"], client.get("/api/apikeys/usage", headers=admin()).json()["keys"])


RAW: list[dict] = []


def ollama(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    RAW.append(body)
    if body.get("stream"):
        chunks = [{"choices": [{"index": 0, "delta": {"content": "Hail"}}]}, {"choices": [{"index": 0, "delta": {"content": ", traveler"}}]},
                  {"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 2}}]
        return httpx.Response(200, text="".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n")
    return httpx.Response(200, json={"id": "x", "object": "chat.completion", "model": body["model"],
                                     "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hail, traveler"}}],
                                     "usage": {"prompt_tokens": 11, "completion_tokens": 2}})


class Raw(Base):
    def setUp(self):
        super().setUp()
        RAW.clear()
        self._client = httpx.AsyncClient
        real = self._client
        httpx.AsyncClient = lambda **kw: real(transport=httpx.MockTransport(ollama), **kw)

    def tearDown(self):
        httpx.AsyncClient = self._client
        super().tearDown()

    def test_messages_go_straight_to_the_model(self):
        k, h = key(name="Skyrim", mode="raw", config={"model": "ShellB-Swift", "models": ["qwen3.6:35b-a3b-q8_0"], "maxTokens": 200})
        self.assertEqual([m["id"] for m in lan.get("/api/v1/models", headers=h).json()["data"]], ["ShellB-Swift", "qwen3.6:35b-a3b-q8_0"])
        self.assertEqual(lan.get("/api/v1/agents", headers=h).json(), [])
        msgs = [{"role": "system", "content": "You are Lydia, a housecarl."}, {"role": "user", "content": "Hello"}]
        r = lan.post("/api/v1/chat/completions", headers=h,
                     json={"model": "gpt-4o", "messages": msgs, "max_tokens": 5000, "temperature": 0.9, "keep_alive": -1})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["choices"][0]["message"]["content"], "Hail, traveler")
        sent = RAW[-1]
        self.assertEqual(sent["messages"], msgs)  # nothing of Shell:B added
        self.assertEqual(sent["model"], "ShellB-Swift")  # unknown model → the key's default
        self.assertEqual(sent["max_tokens"], 200)  # capped
        self.assertNotIn("keep_alive", sent)  # only known fields pass
        self.assertEqual(sent["reasoning_effort"], "none")  # thinking off unless the key says otherwise
        self.assertEqual(CALLS, [])  # no agent turn
        lan.post("/api/v1/chat/completions", headers=h, json={"model": "qwen3.6:35b-a3b-q8_0", "messages": msgs})
        self.assertEqual(RAW[-1]["model"], "qwen3.6:35b-a3b-q8_0")
        row = rows(k["id"])[0]
        self.assertEqual((row["mode"], row["target"], row["prompt_tokens"]), ("raw", "qwen3.6:35b-a3b-q8_0", 11))

    def test_thinking_left_to_the_caller(self):
        _, h = key(mode="raw", config={"model": "ShellB-Swift", "thinking": "caller"})
        lan.post("/api/v1/chat/completions", headers=h, json={"messages": [{"role": "user", "content": "hi"}], "reasoning_effort": "high"})
        self.assertEqual(RAW[-1]["reasoning_effort"], "high")

    def test_streaming_hides_the_usage_chunk(self):
        k, h = key(mode="raw", config={"model": "ShellB-Swift"})
        with lan.stream("POST", "/api/v1/chat/completions", headers=h,
                        json={"stream": True, "messages": [{"role": "user", "content": "hi"}]}) as r:
            lines = [x[6:] for x in r.iter_lines() if x.startswith("data: ")]
        self.assertEqual(lines[-1], "[DONE]")
        chunks = [json.loads(x) for x in lines[:-1]]
        self.assertTrue(all(c["choices"] for c in chunks))  # naive clients read choices[0]
        self.assertEqual(rows(k["id"])[0]["completion_tokens"], 2)

    def test_raw_keys_have_no_agents(self):
        _, h = key(mode="raw", config={"model": "ShellB-Swift"})
        r = lan.post("/api/v1/chat", json={"message": "hi", "instructions": "Be a guard."}, headers=h)
        self.assertEqual(r.json()["message"]["content"], "Hail, traveler")
        self.assertEqual(RAW[-1]["messages"][0], {"role": "system", "content": "Be a guard."})
        self.assertEqual(lan.post("/api/v1/mcp", headers=h, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                         "params": {"name": "shellb_ask", "arguments": {"message": "hi"}}}).json()["result"].get("isError"), True)


if __name__ == "__main__":
    unittest.main()
