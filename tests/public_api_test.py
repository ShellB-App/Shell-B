"""Shell:B API (server/public_api.py): keys are required on every /api/v1 call (not even localhost or the owner's cookie
get in without one), a key only reaches its own chats and agents, adult agents never answer, and the OpenAI-compatible
endpoints have OpenAI's shapes. Turns are faked: public_api.begin_turn is swapped for one that answers at once."""
import asyncio
import json
import unittest

from fastapi.testclient import TestClient

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import db
import public_api
from roster import get_agents

lan = TestClient(shellb.app, client=("10.0.0.9", 50000), raise_server_exceptions=False)
CALLS: list[dict] = []


def fake_begin_turn(conv, body, stream=True, note="", adult_ok=False, interactive=None):
    CALLS.append({"conv": conv["id"], "body": body, "note": note, "interactive": interactive, "stream": stream})
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


if __name__ == "__main__":
    unittest.main()
