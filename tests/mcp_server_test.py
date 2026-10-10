"""Shell:B as an MCP server (server/mcp_server.py): JSON-RPC over POST /api/v1/mcp, behind the API keys, with turns faked
as in public_api_test."""
import unittest

from public_api_test import Base, CALLS, key, lan, normal_agent

import db
import public_api

URL = "/api/v1/mcp"


def rpc(h, method, params=None, rid=1):
    return lan.post(URL, headers=h, json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


class Mcp(Base):
    def test_needs_a_key(self):
        self.assertEqual(lan.post(URL, json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}).status_code, 401)

    def test_handshake_and_tools(self):
        _, h = key()
        r = rpc(h, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
        self.assertEqual(r.json()["result"]["protocolVersion"], "2025-06-18")
        self.assertIn("tools", r.json()["result"]["capabilities"])
        n = lan.post(URL, headers=h, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(n.status_code, 202)
        names = {t["name"] for t in rpc(h, "tools/list").json()["result"]["tools"]}
        self.assertEqual(names, {"shellb_agents", "shellb_ask", "shellb_conversations", "shellb_read", "shellb_stop", "shellb_artifact",
                                 "shellb_library_search", "shellb_memory_search", "shellb_memory_save"})
        self.assertEqual(rpc(h, "nope").json()["error"]["code"], -32601)

    def test_ask_and_read(self):
        k, h = key(agents=[normal_agent()])
        res = rpc(h, "tools/call", {"name": "shellb_ask", "arguments": {"message": "hi"}}).json()["result"]
        self.assertNotIn("isError", res)
        self.assertTrue(res["content"][0]["text"].startswith("Hello\n\nworld"))
        conv = res["structuredContent"]["conversation"]
        self.assertIs(CALLS[-1]["interactive"], False)
        read = rpc(h, "tools/call", {"name": "shellb_read", "arguments": {"conversation": conv, "last": 1}}).json()["result"]
        self.assertEqual([m["role"] for m in read["structuredContent"]["messages"]], ["assistant"])
        with db.conn() as c:  # one call counts once against the rate limit
            self.assertEqual(c.execute("SELECT uses FROM api_keys WHERE id=?", (k["id"],)).fetchone()["uses"], 2)

    def test_refusals_are_tool_errors(self):
        _, a = key(name="A")
        _, b = key(name="B")
        conv = rpc(a, "tools/call", {"name": "shellb_ask", "arguments": {"message": "hi"}}).json()["result"]["structuredContent"]["conversation"]
        res = rpc(b, "tools/call", {"name": "shellb_read", "arguments": {"conversation": conv}}).json()["result"]
        self.assertTrue(res["isError"])
        res = rpc(a, "tools/call", {"name": "shellb_ask", "arguments": {"message": "hi", "agent": "aphrodite"}}).json()["result"]
        self.assertTrue(res["isError"])

    def test_batch(self):
        _, h = key()
        r = lan.post(URL, headers=h, json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"},
                                           {"jsonrpc": "2.0", "method": "notifications/initialized"}])
        self.assertEqual(r.json(), [{"jsonrpc": "2.0", "id": 1, "result": {}}])
        public_api._recent.clear()


if __name__ == "__main__":
    unittest.main()
