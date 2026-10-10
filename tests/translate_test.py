"""Translation (server/translate.py) on the local utility model, mocked here."""
import asyncio
import json
import unittest
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import translate


class _Resp:
    def __init__(self, content):
        self._c = content
    def raise_for_status(self): pass
    def json(self): return {"message": {"content": self._c}}


class Translate(unittest.TestCase):
    def test_route_and_tool(self):
        seen = []

        async def post(path, private=False, timeout=0, body=None):
            seen.append(body)
            text = body["messages"][1]["content"].removeprefix("TEXT:\n")
            return _Resp(json.dumps({"detected": "English", "translation": f"[fr] {text}"}))
        with mock.patch("fleet.post", post):
            r = client.post("/api/translate", json={"text": "Good morning", "to": "French"})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json(), {"translation": "[fr] Good morning", "detected": "English", "to": "French", "model": r.json()["model"]})
            self.assertTrue(seen[0]["options"]["temperature"] == 0 and seen[0]["format"] == "json")
            self.assertIn("material to translate", seen[0]["messages"][0]["content"])
            out = asyncio.run(translate.translate_tool({"text": "Hi", "to": "German"}, None))
            self.assertIn("English → German", out.text)
            self.assertEqual(client.post("/api/translate", json={"text": "", "to": "French"}).status_code, 400)
            self.assertEqual(client.post("/api/translate", json={"text": "x" * 20000, "to": "French"}).status_code, 400)

    def test_long_texts_go_in_paragraph_chunks(self):
        text = "\n\n".join(f"Paragraph {i} " + "word " * 300 for i in range(6))
        chunks = translate._chunks(text)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(c) <= translate.CHUNK + 50 for c in chunks))
        self.assertEqual("\n\n".join(chunks), text)

    def test_languages(self):
        self.assertIn("French", client.get("/api/translate/languages").json()["languages"])


if __name__ == "__main__":
    unittest.main()
