"""Deep time: the agents' deep_time tool and the Worlds prehistory layers share one site list and one sea-level curve.
Checks the curve in server/deeptime.py matches ui/src/maps/deeptime.ts, the site list is well formed, and the tool's
answers (Newgrange's midwinter sunrise, Ice Age sea level, French cards, map blocks)."""
import asyncio
import json
import re
import unittest
from types import SimpleNamespace

from smoke_test import WEB, client, shellb  # noqa: F401

import deeptime


def run(args):
    return asyncio.run(deeptime.deep_time_tool(args, SimpleNamespace(conv_id="conv-test")))


class DeepTime(unittest.TestCase):
    def test_curve_matches_the_map(self):
        ts = (WEB / "ui" / "src" / "maps" / "deeptime.ts").read_text(encoding="utf-8")
        body = re.search(r"const CURVE: \[number, number\]\[\] = \[(.*?)\];", ts, re.S).group(1)
        pairs = [(int(a), int(b)) for a, b in re.findall(r"\[(-?\d+), (-?\d+)\]", body)]
        self.assertEqual(pairs, deeptime.CURVE)

    def test_sites_are_well_formed(self):
        ids = set()
        for s in deeptime.sites():
            self.assertNotIn(s["id"], ids)
            ids.add(s["id"])
            self.assertTrue(-90 <= s["lat"] <= 90 and -180 <= s["lon"] <= 180, s["id"])
            self.assertTrue(s["desc"] and s["fr"]["desc"], s["id"])
            self.assertEqual(bool(s.get("highlight")), bool(s["fr"].get("highlight")), s["id"])
            for e in s.get("align", []):
                self.assertIn(e, deeptime.EVENTS)
        self.assertGreaterEqual(len(ids), 60)

    def test_periods_and_countries_have_french(self):
        fr = json.loads((WEB / "ui" / "src" / "i18n" / "fr.json").read_text(encoding="utf-8"))
        for s in deeptime.sites():
            self.assertIn(s["period"], fr, s["id"])
            self.assertIn(s["country"], fr, s["id"])

    def test_sun_and_sea(self):
        self.assertAlmostEqual(deeptime.obliquity(2000), 23.4393, places=3)
        self.assertAlmostEqual(deeptime.solar(53.6947, -3200, ["ws-rise"])["ws-rise"], 131.9, delta=0.2)
        self.assertAlmostEqual(deeptime.solar(51.1789, -2500, ["ss-rise"])["ss-rise"], 48.2, delta=0.5)
        self.assertIsNone(deeptime.solar(80, 2000, ["ws-rise"])["ws-rise"])  # polar night
        self.assertEqual(deeptime.sea_level(21000), -130)
        self.assertEqual(deeptime.sea_level(0), 0)

    def test_tool(self):
        r = run({"action": "site", "query": "newgrange"})
        self.assertFalse(r.error)
        self.assertIn("winter solstice sunrise", r.text)
        self.assertIn("```map", r.text)
        spec = json.loads(r.text.split("```map\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(len(spec["lines"]), 1)
        fr = run({"action": "site", "id": "chauvet", "language": "fr"})
        self.assertIn("Grotte Chauvet", fr.text)
        near = run({"action": "sites", "lat": 47.6, "lon": -3.0, "radius_km": 30})
        self.assertIn("carnac", near.text)
        self.assertNotIn("lascaux", near.text)
        self.assertIn("-130 m", run({"action": "sea_level", "years_ago": 21000}).text)
        self.assertTrue(run({"action": "sea_level", "years_ago": 500000}).error)
        self.assertTrue(run({"action": "sun"}).error)


if __name__ == "__main__":
    unittest.main()
