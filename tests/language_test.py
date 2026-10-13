"""The language setting on the server side: agents get a note to answer in it, guests carry one in their config, and
the auth check reports it so the UI (ui/src/i18n) can switch before anything renders."""
import unittest

from smoke_test import client, shellb  # noqa: F401  (shellb: the scratch server is imported)

import auth
import guests
import prompts
import translate

ADMIN = {"x-shellb-admin": open(str(shellb.db.DATA / "admin.key")).read().strip()} if (shellb.db.DATA / "admin.key").is_file() else {}


class Language(unittest.TestCase):
    def test_note_only_for_non_english(self):
        self.assertEqual(prompts.language_note(""), "")
        self.assertEqual(prompts.language_note("en"), "")
        self.assertIn("Reply in French", prompts.language_note("fr"))
        self.assertEqual(prompts.language_note("xx"), "")  # unknown codes add nothing rather than a wrong name
        self.assertIn("Reply in Klingon", prompts.language_note("tlh"))

    def test_guest_config_keeps_a_known_language(self):
        self.assertEqual(guests.clean_config({"language": "fr"})["language"], "fr")
        self.assertEqual(guests.clean_config({"language": "de"})["language"], "")
        self.assertEqual(guests.clean_config({})["language"], "")

    def test_guest_note_carries_the_language(self):
        g = {"name": "Guy", "config": {"language": "fr"}}
        self.assertIn("## Language", guests.note(g))
        self.assertIn("Guy", guests.note(g))
        self.assertNotIn("## Language", guests.note({"name": "Josh", "config": {}}))

    def test_auth_me_reports_the_setting(self):
        self.assertEqual(client.get("/api/auth/me").json().get("language"), "")
        r = client.put("/api/settings", json={"language": "fr"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["language"], "fr")
        self.assertEqual(client.get("/api/auth/me").json()["language"], "fr")
        client.put("/api/settings", json={"language": ""})

    def test_system_prompt_includes_the_note(self):
        agent = {"systemPrompt": "You are Spark.", "model": "ShellB-Swift"}
        text = prompts.build_system(agent, [], "medium", [], [], [], {"language": "fr"})
        self.assertIn("Reply in French", text)
        text = prompts.build_system(agent, [], "medium", [], [], [], {"language": ""})
        self.assertNotIn("## Language", text)

    def test_catalogues_are_public_and_checked(self):
        # the login screen loads its language before anyone signs in
        self.assertTrue(auth.PUBLIC.match("/api/translate/catalogue/sr-Latn"))
        self.assertTrue(auth.PUBLIC.match("/api/translate/locales"))
        self.assertFalse(auth.PUBLIC.match("/api/translate/coverage"))
        self.assertFalse(auth.PUBLIC.match("/api/translate/catalogue/../keys"))
        self.assertEqual(client.get("/api/translate/catalogue/x.y").status_code, 400)
        self.assertEqual(client.get("/api/translate/catalogue/zz-none").status_code, 404)
        if (translate.TRANSLATIONS_DIR / "locales" / "fr.json").is_file():
            self.assertEqual(client.get("/api/translate/catalogue/fr").json()["Log in"], "Se connecter")


if __name__ == "__main__":
    unittest.main()
