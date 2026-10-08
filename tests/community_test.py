"""Community Hub: registry entries map to safe install options, installs need admin, agents can't install silently."""
import asyncio
import types
import unittest

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import community

ENTRY = {"name": "io.github.example/weather", "version": "1.2.0", "description": "Weather",
         "repository": {"url": "https://github.com/example/weather"},
         "packages": [{"registryType": "npm", "identifier": "@example/weather-mcp", "version": "1.2.0",
                       "transport": {"type": "stdio"},
                       "environmentVariables": [{"name": "WEATHER_KEY", "isSecret": True, "isRequired": True}]},
                      {"registryType": "pypi", "identifier": "weather-mcp", "version": "1.2.0", "transport": {"type": "stdio"}}],
         "remotes": [{"type": "streamable-http", "url": "https://mcp.example.com/mcp",
                      "headers": [{"name": "Authorization", "value": "Bearer {api_key}", "isSecret": True}]}]}


class Options(unittest.TestCase):
    def test_mapping(self):
        opts = {o["kind"]: o for o in community.install_options(ENTRY)}
        self.assertEqual(set(opts), {"remote", "npm", "pypi"})
        self.assertEqual(opts["remote"]["fields"][0]["key"], "api_key")
        self.assertEqual(opts["remote"]["fields"][0]["kind"], "secret")
        self.assertEqual(opts["npm"]["fields"][0]["key"], "WEATHER_KEY")

    def test_packages_run_isolated_and_secrets_stay_out_of_argv(self):
        opt = next(o for o in community.install_options(ENTRY) if o["kind"] == "npm")
        cfg = community.build({"option": opt, "sid": "weather"}, {"WEATHER_KEY": "s3cret"})
        argv = " ".join(cfg["args"])
        for flag in ("--cap-drop ALL", "--network shellb-mcp", "--name shellb-mcp-weather", "node:22-slim"):
            self.assertIn(flag, argv)
        self.assertNotIn("s3cret", argv)
        self.assertEqual(cfg["env"]["WEATHER_KEY"], "s3cret")
        self.assertIn("@example/weather-mcp@1.2.0", argv)

    def test_remote_header_template(self):
        opt = next(o for o in community.install_options(ENTRY) if o["kind"] == "remote")
        cfg = community.build({"option": opt}, {"api_key": "abc"})
        self.assertEqual(cfg["headers"], {"Authorization": "Bearer abc"})
        self.assertEqual(community.build({"option": opt}, {})["headers"], {})  # no "Bearer " with nothing after it


class Gates(unittest.TestCase):
    def test_install_and_sources_need_admin(self):
        self.assertEqual(client.post("/api/community/install", json={"id": "x"}).status_code, 403)
        self.assertEqual(client.post("/api/community/sources", json={"repo": "a/b"}).status_code, 403)

    def test_tool_cannot_install_by_itself(self):
        ctx = types.SimpleNamespace(agent={"id": "shellb"})
        r = asyncio.run(community.find_capability({"action": "propose", "id": "skill:x:y"}, ctx))
        self.assertTrue(r.error)

    def test_source_parsing(self):
        with self.assertRaises(ValueError):
            community.add_source("not a repo")


if __name__ == "__main__":
    unittest.main()
