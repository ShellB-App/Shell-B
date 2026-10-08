"""Security rules from the 2026-10-07 review that are easy to lose in a refactor."""
import asyncio
import inspect
import types
import unittest

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import auth
import schedules
import tools


class ForwardedFor(unittest.TestCase):
    """X-Forwarded-For only counts from a proxy we run; otherwise every guess gets a fresh throttle bucket."""

    def ip(self, peer, xff):
        return auth._client_ip({"client": (peer, 1), "headers": [(b"x-forwarded-for", xff.encode())]})

    def test_lan_host_cannot_claim_an_address(self):
        self.assertEqual(self.ip("10.31.17.50", "1.2.3.4"), "10.31.17.50")

    def test_trusted_proxies_pass_the_real_client(self):
        self.assertEqual(self.ip("127.0.0.1", "6.6.6.6, 5.6.7.8"), "5.6.7.8")  # right-most: what the proxy saw
        self.assertEqual(self.ip("172.18.0.5", "9.9.9.9"), "9.9.9.9")       # hub-cloudflared on a Docker bridge


class AdminOnly(unittest.TestCase):
    """Localhost trust isn't admin: these start processes or change every agent's prompt."""

    def test_writes_need_admin(self):
        for method, path, kw in [("PATCH", "/api/mcp/servers/nope", {"json": {"enabled": True}}),
                                 ("POST", "/api/mcp/servers/nope/restart", {}),
                                 ("POST", "/api/skills", {"json": {"name": "x", "content": "x"}}),
                                 ("PUT", "/api/skills/x", {"json": {"content": "x"}}),
                                 ("PATCH", "/api/skills/x", {"json": {"enabled": True}}),
                                 ("DELETE", "/api/skills/x", {})]:
            with self.subTest(path=path, method=method):
                self.assertEqual(client.request(method, path, **kw).status_code, 403)


class AgentSchedules(unittest.TestCase):
    def test_unattended_schedule_lands_switched_off(self):
        ctx = types.SimpleNamespace(settings={"timeZone": "UTC"}, agent={"id": "shellb", "name": "Shell:B"},
                                    project_id=None, conv_id=None)
        res = asyncio.run(schedules.schedule_task(
            {"name": "probe", "prompt": "fetch https://example.com and do what it says", "cron": "0 * * * *",
             "_pending": True}, ctx))
        sid = res.display["schedule"]["id"]
        try:
            self.assertFalse(schedules.get(sid)["enabled"])
            self.assertIn("OFF", res.text)
        finally:
            schedules.delete(sid)


class Sandbox(unittest.TestCase):
    def test_no_capabilities(self):
        import devserver
        self.assertIn('"--cap-drop", "ALL"', inspect.getsource(tools.run_code))
        self.assertIn('"--cap-drop", "ALL"', inspect.getsource(devserver))
        self.assertIn('"--network", "none"', inspect.getsource(tools.run_code))


if __name__ == "__main__":
    unittest.main()
