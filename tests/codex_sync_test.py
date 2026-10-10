"""Calendar and contacts interchange (server/codex_sync.py): .ics and .vcf round-trips, recurrence, reminders."""
import io
import unittest
import unittest.mock
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from smoke_test import client, shellb  # noqa: F401

import codex
import codex_sync as cs
import db


def setUpModule():
    # codex.create hands indexing to the server's event loop, which these tests don't run
    global _spawn_patch
    _spawn_patch = unittest.mock.patch.object(codex, "_spawn", lambda coro: coro.close())
    _spawn_patch.start()


def tearDownModule():
    _spawn_patch.stop()

TZ = ZoneInfo("America/Chicago")


class Ics(unittest.TestCase):
    def test_round_trip(self):
        e = {"id": "cx-test1", "title": "Dentist; cleaning", "body": "Bring the card",
             "meta": {"date": "2026-11-03", "time": "14:30", "endTime": "15:15", "location": "Oak St, Suite 2",
                      "attendees": ["Dr. Lee"], "recurrence": "none", "status": "confirmed", "reminderMinutes": 30}}
        text = cs.calendar_ics([e], "America/Chicago")
        self.assertIn("BEGIN:VCALENDAR", text)
        self.assertIn("SUMMARY:Dentist\\; cleaning", text)
        self.assertIn("DTSTART;TZID=America/Chicago:20261103T143000", text)
        self.assertIn("TRIGGER:-PT30M", text)
        back = cs.ics_events(text, TZ)
        self.assertEqual(len(back), 1)
        b = back[0]
        self.assertEqual(b["title"], "Dentist; cleaning")
        self.assertEqual(b["body"], "Bring the card")
        self.assertEqual(b["meta"]["date"], "2026-11-03")
        self.assertEqual(b["meta"]["time"], "14:30")
        self.assertEqual(b["meta"]["endTime"], "15:15")
        self.assertEqual(b["meta"]["location"], "Oak St, Suite 2")
        self.assertEqual(b["meta"]["attendees"], ["Dr. Lee"])
        self.assertEqual(b["meta"]["reminderMinutes"], 30)
        self.assertEqual(b["meta"]["uid"], "cx-test1@shellb")

    def test_google_style_import(self):
        text = ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:20261105T150000Z\r\nDTEND:20261105T160000Z\r\n"
                "RRULE:FREQ=WEEKLY;BYDAY=TH\r\nSUMMARY:Team sync\r\nUID:abc123@google.com\r\n"
                "DESCRIPTION:Agenda in the doc\\, as usual\\nSecond line\r\nEND:VEVENT\r\n"
                "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261225\r\nDTEND;VALUE=DATE:20261226\r\nSUMMARY:Christmas\r\n"
                "RRULE:FREQ=YEARLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
        evs = cs.ics_events(text, TZ)
        self.assertEqual([e["title"] for e in evs], ["Team sync", "Christmas"])
        sync, xmas = evs
        self.assertEqual(sync["meta"]["time"], "09:00")  # 15:00 UTC in Chicago (CST in November)
        self.assertEqual(sync["meta"]["endTime"], "10:00")
        self.assertEqual(sync["meta"]["recurrence"], "custom")
        self.assertEqual(sync["meta"]["rrule"], "FREQ=WEEKLY;BYDAY=TH")
        self.assertEqual(sync["body"], "Agenda in the doc, as usual\nSecond line")
        self.assertTrue(xmas["meta"]["allDay"])
        self.assertNotIn("endDate", xmas["meta"])  # exclusive DTEND of one day → same-day
        self.assertEqual(xmas["meta"]["recurrence"], "yearly")


class Recurrence(unittest.TestCase):
    def test_occurrences(self):
        weekly = {"date": "2026-10-01", "recurrence": "weekly"}
        self.assertEqual(cs.occurrences(weekly, date(2026, 10, 10), date(2026, 10, 31)), [date(2026, 10, 15), date(2026, 10, 22), date(2026, 10, 29)])
        custom = {"date": "2026-10-05", "recurrence": "custom", "rrule": "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2"}
        self.assertEqual(cs.occurrences(custom, date(2026, 10, 5), date(2026, 10, 25)), [date(2026, 10, 5), date(2026, 10, 7), date(2026, 10, 19), date(2026, 10, 21)])
        once = {"date": "2026-10-20"}
        self.assertEqual(cs.occurrences(once, date(2026, 10, 1), date(2026, 10, 31)), [date(2026, 10, 20)])
        self.assertEqual(cs.occurrences(once, date(2026, 11, 1), date(2026, 11, 30)), [])
        bad = {"date": "2026-10-20", "recurrence": "custom", "rrule": "FREQ=NEVER"}
        self.assertEqual(cs.occurrences(bad, date(2026, 10, 1), date(2026, 10, 31)), [date(2026, 10, 20)])

    def test_prompt_lists_weekly_events(self):
        e = codex.create({"kind": "event", "title": "Stand-up", "meta": {"date": "2026-01-05", "time": "09:00", "recurrence": "weekly"}})
        try:
            block = codex.upcoming_schedule_prompt(now=datetime(2026, 10, 12, 8, 0, tzinfo=TZ), days=7)
            self.assertIn("Stand-up at 09:00 (Weekly)", block)
        finally:
            codex.delete(e["id"])


class Reminders(unittest.TestCase):
    def test_fires_once_per_occurrence(self):
        saved = db.kv_get("calendar_fired")
        e = codex.create({"kind": "event", "title": "Pick up the parcel", "meta": {"date": "2026-10-13", "time": "17:00", "reminderMinutes": 30}})
        try:
            with unittest.mock.patch.object(cs, "tz", return_value=TZ):
                early = datetime(2026, 10, 13, 16, 0, tzinfo=TZ)
                self.assertEqual([x[0]["id"] for x in cs.due_reminders(early)], [])
                due = datetime(2026, 10, 13, 16, 35, tzinfo=TZ)
                self.assertEqual([x[0]["id"] for x in cs.due_reminders(due)], [e["id"]])
                self.assertEqual(cs.fire_reminders(due), 1)
                self.assertEqual(cs.fire_reminders(due + timedelta(minutes=5)), 0)
            rows = client.get("/api/activity?source=calendar").json()["items"]
            self.assertTrue(any(r["title"].startswith("Pick up the parcel") and r["status"] == "due" and r["attention"] for r in rows))
        finally:
            codex.delete(e["id"])
            db.kv_set("calendar_fired", saved)


class Vcf(unittest.TestCase):
    def test_round_trip_and_import_merge(self):
        c = {"id": "cx-c1", "title": "Ada Lovelace", "body": "Met at EWNA",
             "meta": {"role": "Engineer", "company": "Analytical Engines", "email": "ada@example.org", "phone": "+1 555 0100",
                      "location": "London", "birthday": "1815-12-10", "pronouns": "she/her", "aka": ["Ada"], "urls": ["https://example.org"]}}
        text = cs.contacts_vcf([c])
        self.assertIn("FN:Ada Lovelace", text)
        self.assertIn("N:Lovelace;Ada;;;", text)
        self.assertIn("BDAY:1815-12-10", text)
        back = cs.vcf_contacts(text)[0]
        self.assertEqual(back["title"], "Ada Lovelace")
        self.assertEqual(back["meta"]["email"], "ada@example.org")
        self.assertEqual(back["meta"]["phone"], "+1 555 0100")
        self.assertEqual(back["meta"]["company"], "Analytical Engines")
        self.assertEqual(back["meta"]["role"], "Engineer")
        self.assertEqual(back["meta"]["location"], "London")
        self.assertEqual(back["meta"]["aka"], ["Ada"])
        self.assertEqual(back["body"], "Met at EWNA")
        # a phone export with two numbers, no UID: matched to the existing contact by name, missing fields filled in
        made = codex.create({"kind": "contact", "title": "Grace Hopper", "meta": {"email": "grace@example.org"}})
        try:
            phone = ("BEGIN:VCARD\r\nVERSION:3.0\r\nN:Hopper;Grace;;;\r\nFN:Grace Hopper\r\nTEL;TYPE=CELL:+1 555 0199\r\n"
                     "TEL;TYPE=WORK:+1 555 0198\r\nORG:US Navy\r\nEND:VCARD\r\n")
            r = cs.import_entries("contact", cs.vcf_contacts(phone))
            self.assertEqual((r["added"], r["updated"]), (0, 1))
            got = codex.get(made["id"])
            self.assertEqual(got["meta"]["phone"], "+1 555 0199")
            self.assertEqual(got["meta"]["phones"], ["+1 555 0199", "+1 555 0198"])
            self.assertEqual(got["meta"]["email"], "grace@example.org")
            self.assertEqual(got["meta"]["company"], "US Navy")
        finally:
            codex.delete(made["id"])

    def test_routes(self):
        r = client.get("/api/codex/contacts.vcf")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("text/vcard"))
        r = client.get("/api/codex/calendar.ics")
        self.assertEqual(r.status_code, 200)
        self.assertIn("BEGIN:VCALENDAR", r.text)
        ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:rt-1\r\nDTSTART;VALUE=DATE:20270301\r\nSUMMARY:Route test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        r = client.post("/api/codex/import/ics", files=[("files", ("x.ics", io.BytesIO(ics.encode()), "text/calendar"))])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["added"], 1)
        r = client.post("/api/codex/import/ics", files=[("files", ("x.ics", io.BytesIO(ics.encode()), "text/calendar"))])
        self.assertEqual((r.json()["added"], r.json()["updated"]), (0, 1))
        with db.conn() as c:
            ids = [row["id"] for row in c.execute("SELECT id FROM codex_entries WHERE kind='event' AND title='Route test'")]
        for i in ids:
            codex.delete(i)
        self.assertEqual(len(ids), 1)
        r = client.post("/api/codex/import/vcf", files=[("files", ("x.vcf", io.BytesIO(b"nothing"), "text/vcard"))])
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
