"""transcribe.py (timestamps, URL rules, tool errors), studio_edit.py (pure graph builders), the LoRA hook in
tools._flux_workflow, and the Gemini importer."""
import asyncio
import unittest
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import importer
import studio_edit
import tools
import transcribe


class Transcribe(unittest.TestCase):
    def test_timestamps_and_media_detection(self):
        segs = [{"start": 0.0, "end": 2.0, "text": "Hello"}, {"start": 2.5, "end": 4.0, "text": "there"},
                {"start": 31.0, "end": 33.0, "text": "later"}, {"start": 3700.0, "end": 3701.0, "text": "an hour in"}]
        out = transcribe.with_timestamps(segs)
        self.assertTrue(out.startswith("[0:00] Hello there"))
        self.assertIn("\n[0:31] later", out)
        self.assertIn("\n[1:01:40] an hour in", out)
        self.assertTrue(transcribe.is_media("talk.MP4") and transcribe.is_video("a.mkv") and not transcribe.is_video("a.mp3"))
        self.assertFalse(transcribe.is_media("notes.pdf"))

    def test_download_refuses_streaming_sites_and_local_hosts(self):
        import tempfile
        from pathlib import Path
        d = Path(tempfile.mkdtemp())
        with self.assertRaises(ValueError) as cm:
            asyncio.run(transcribe.download("https://www.youtube.com/watch?v=abc", d))
        self.assertIn("yt-dlp", str(cm.exception))
        with self.assertRaises(ValueError):
            asyncio.run(transcribe.download("http://192.168.0.5/talk.mp3", d))

    def test_tool_errors_are_clear(self):
        class Ctx:
            project_id = None
            conv_id = "conv-media-test"
        out = asyncio.run(transcribe.transcribe_tool({}, Ctx()))
        self.assertTrue(out.error)
        out = asyncio.run(transcribe.transcribe_tool({"file": "/work/missing.mp3"}, Ctx()))
        self.assertTrue(out.error and "No such file" in out.text)
        out = asyncio.run(transcribe.transcribe_tool({"url": "https://youtu.be/x"}, Ctx()))
        self.assertTrue(out.error and "Streaming sites" in out.text)


class EditGraphs(unittest.TestCase):
    def test_graphs_wire_the_right_nodes(self):
        g = studio_edit.cutout_graph("in.png")
        self.assertEqual(g["31"]["class_type"], "RemoveBackground")
        self.assertEqual(g["33"]["inputs"]["images"], ["32", 0])
        g = studio_edit.upscale_graph("in.png", "4x_ESRGAN.pth")
        self.assertEqual(g["40"]["inputs"]["model_name"], "4x_ESRGAN.pth")
        self.assertEqual(g["41"]["inputs"]["upscale_model"], ["40", 0])
        flux = studio_edit.inpaint_graph("in.png", "a red door", 7, mask_name="mask.png", flux=True)
        self.assertEqual(flux["12"]["class_type"], "ImageToMask")
        self.assertEqual(flux["14"]["class_type"], "InpaintModelConditioning")
        self.assertEqual(flux["8"]["inputs"]["latent_image"], ["14", 2])
        self.assertEqual(flux["8"]["inputs"]["seed"], 7)
        self.assertEqual(flux["4"]["inputs"]["text"], "a red door")
        bg = studio_edit.inpaint_graph("in.png", "a beach", 1, auto="background", flux=False, checkpoint="sdxl.safetensors")
        self.assertEqual(bg["35"]["class_type"], "InvertMask")  # background = everything but the subject
        self.assertEqual(bg["14"]["class_type"], "VAEEncodeForInpaint")
        self.assertEqual(bg["1"]["inputs"]["ckpt_name"], "sdxl.safetensors")
        subj = studio_edit.inpaint_graph("in.png", "x", 1, auto="subject", flux=True)
        self.assertNotIn("35", subj)
        self.assertEqual(subj["13"]["inputs"]["mask"], ["31", 0])

    def test_edit_tool_input_checks(self):
        class Ctx:
            project_id = None
            conv_id = "conv-media-test"
            agent = {"model": "x"}
            settings = {}
        out = asyncio.run(studio_edit.edit_image({"action": "blur", "image": "x"}, Ctx()))
        self.assertTrue(out.error)
        out = asyncio.run(studio_edit.edit_image({"action": "cutout", "image": "/work/nope.png"}, Ctx()))
        self.assertTrue(out.error and "Give `image`" in out.text)

    def test_flux_lora_hook(self):
        wf = tools._flux_workflow("a cat", 512, 512, 1)
        self.assertNotIn("11", wf)
        with mock.patch.object(tools, "loras", return_value=["style.safetensors"]):
            wf = tools._flux_workflow("a cat", 512, 512, 1, lora="style.safetensors", lora_strength=0.6)
            self.assertEqual(wf["11"]["class_type"], "LoraLoader")
            self.assertEqual(wf["11"]["inputs"]["strength_model"], 0.6)
            self.assertEqual(wf["4"]["inputs"]["clip"], ["11", 1])
            self.assertEqual(wf["8"]["inputs"]["model"], ["11", 0])
            wf = tools._flux_workflow("a cat", 512, 512, 1, lora="unknown.safetensors")
            self.assertNotIn("11", wf)  # only installed files


class Gemini(unittest.TestCase):
    RECORDS = [
        {"header": "Gemini Apps", "title": "Prompted write a haiku about rain", "time": "2026-03-01T10:00:00.000Z", "products": ["Gemini Apps"]},
        {"header": "Gemini Apps", "title": "Prompted make it shorter", "time": "2026-03-01T10:02:00.000Z",
         "subtitles": [{"name": "Rain taps the window, soft."}]},
        {"header": "Gemini Apps", "title": "Used Gemini Apps", "time": "2026-03-01T10:03:00.000Z"},
        {"header": "Gemini Apps", "title": "Prompted plan a trip", "time": "2026-03-04T08:00:00.000Z"},
        {"header": "Search", "title": "Searched for weather", "time": "2026-03-04T08:01:00.000Z"},
    ]

    def test_detect_and_parse(self):
        source, convs = importer.parse(self.RECORDS)
        self.assertEqual(source, "gemini")
        self.assertEqual([c["title"] for c in convs], ["Gemini · 2026-03-01", "Gemini · 2026-03-04"])
        first = convs[0]["messages"]
        self.assertEqual([m["role"] for m in first], ["user", "assistant"])  # consecutive prompts merge, like other imports
        self.assertIn("write a haiku about rain", first[0]["text"])
        self.assertIn("make it shorter", first[0]["text"])
        self.assertEqual(first[1]["text"], "Rain taps the window, soft.")
        self.assertEqual(len(convs[1]["messages"]), 1)
        # the other formats still detect
        self.assertEqual(importer.detect([{"mapping": {}, "title": "x"}])[0], "chatgpt")
        self.assertEqual(importer.detect([{"chat_messages": []}])[0], "claude")
        with self.assertRaises(ValueError):
            importer.detect([{"foo": 1}])


if __name__ == "__main__":
    unittest.main()
