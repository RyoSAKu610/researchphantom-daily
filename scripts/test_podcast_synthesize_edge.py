"""Fast unit tests for scripts/podcast/synthesize_edge.py (no network, no edge-tts).

A fake edge_tts module is injected into sys.modules and streams chunks of a real
lavfi-built MP3 fixture, so the full run() flow (re-encode, probe, gates, publish)
is exercised without contacting speech.platform.bing.com and without installing
edge-tts under the testing interpreter.
Run: PATH=/opt/homebrew/bin:/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_podcast_synthesize_edge.py' -v
"""

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts/podcast/synthesize_edge.py"
FFMPEG = os.environ.get("FFMPEG") or (
    "/opt/homebrew/bin/ffmpeg" if Path("/opt/homebrew/bin/ffmpeg").is_file() else shutil.which("ffmpeg"))
FFPROBE = os.environ.get("FFPROBE") or (
    "/opt/homebrew/bin/ffprobe" if Path("/opt/homebrew/bin/ffprobe").is_file() else shutil.which("ffprobe"))
VOICES = Path(__file__).resolve().parent / "podcast/voices.json"
EDGE_TTS_INSTALLED = importlib.util.find_spec("edge_tts") is not None
TEXT_LONG = "Phantomresearch Daily covers a fresh research topic briefly in four languages. " * 14


def load_adapters():
    modules = []
    for name in ("synthesize", "synthesize_edge"):
        spec = importlib.util.spec_from_file_location("podcast_%s_edge" % name,
                                                      ROOT / ("scripts/podcast/%s.py" % name))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules.append(module)
    return modules


synth, edge = load_adapters()


def make_mp3(seconds=12.0):
    """A real twelve-seconds MP3 fixture split into stream()-style chunks."""
    with tempfile.TemporaryDirectory() as directory:
        fixture = Path(directory) / "voice.mp3"
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                        "-i", "sine=frequency=440:sample_rate=24000:duration=%s" % seconds,
                        "-af", "volume=0.4", "-c:a", "libmp3lame", "-b:a", "48k", str(fixture)],
                       check=True, timeout=120)
        payload = fixture.read_bytes()
    half = len(payload) // 2
    return payload, [payload[:half], payload[half:]]


class FakeCommunicate:
    """Replaces edge_tts.Communicate: streams chunked audio like the real library."""

    instances = []

    def __init__(self, text, voice, *args, **kwargs):
        self.text = text
        self.voice = voice
        FakeCommunicate.instances.append(self)

    def stream(self):
        async def chunks():
            for chunk in FakeCommunicate.audio_chunks:
                yield {"type": "audio", "data": chunk}
            yield {"type": "WordBoundary", "offset": 0, "duration": 1, "text": "ignored"}
        return chunks()


def install_fake_edge_tts():
    fake = types.ModuleType("edge_tts")
    fake.Communicate = FakeCommunicate
    fake.__version__ = "7.3.1-fake"
    return fake


class WithRetriesTests(unittest.TestCase):
    def test_returns_first_success(self):
        self.assertEqual(edge.with_retries(lambda: "ok"), "ok")

    def test_retries_then_succeeds_and_backs_off(self):
        sleeps = []
        attempts = []

        def flaky():
            attempts.append(len(attempts))
            if len(attempts) < 3:
                raise RuntimeError("temporary failure")
            return "recovered"

        result = edge.with_retries(flaky, attempts=3, backoff=0.5,
                                   sleep=sleeps.append, on_retry=lambda e, a: None)
        self.assertEqual(result, "recovered")
        self.assertEqual(attempts, [0, 1, 2])
        self.assertEqual(sleeps, [0.5, 1.0])

    def test_exhausted_attempts_raise_last_error(self):
        def always_fails():
            raise RuntimeError("no luck")

        with self.assertRaises(RuntimeError) as caught:
            edge.with_retries(always_fails, attempts=2, backoff=0.0, sleep=lambda s: None)
        self.assertEqual(str(caught.exception), "no luck")

    def test_bound_respects_minimum(self):
        # failures on the final attempt never sleep, and with attempts=1 there is no retry
        sleeps = []
        with self.assertRaises(ZeroDivisionError):
            edge.with_retries(lambda: 1 / 0, attempts=1, backoff=5.0, sleep=sleeps.append)
        self.assertEqual(sleeps, [])


class EngineLanguageTests(unittest.TestCase):
    def test_reads_voice_config_and_rejects_unknown_language(self):
        voices = json.loads(VOICES.read_text(encoding="utf-8"))
        for language, expected in (("ja", "ja-JP-NanamiNeural"), ("en", "en-US-AndrewNeural"),
                                   ("zh", "zh-CN-XiaoxiaoNeural"), ("ko", "ko-KR-SunHiNeural")):
            self.assertEqual(edge.engine_language(voices, language)["voice"], expected)
            self.assertEqual(edge.edge_voice(voices, language), expected)
        with self.assertRaises(ValueError):
            edge.engine_language(voices, "de")


class RunTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.payload, self.chunks = make_mp3(310.0)  # 300..1200 s container gate needs episode length
        FakeCommunicate.instances = []
        FakeCommunicate.audio_chunks = self.chunks
        self._previous = sys.modules.get("edge_tts")
        sys.modules["edge_tts"] = install_fake_edge_tts()
        self.addCleanup(self.restore_module)

    def restore_module(self):
        if self._previous is not None:
            sys.modules["edge_tts"] = self._previous
        else:
            sys.modules.pop("edge_tts", None)
        FakeCommunicate.instances = []

    def args(self, language="en"):
        text = Path(self.directory.name) / "episode.txt"
        text.write_text(TEXT_LONG, encoding="utf-8")
        return argparse.Namespace(text=None, text_file=text, language=language,
                                  out=Path(self.directory.name, "%s.mp3" % language),
                                  metrics=Path(self.directory.name, "%s.metrics.json" % language),
                                  voices=VOICES, ffmpeg=FFMPEG, ffprobe=FFPROBE, verbose=False)

    def test_full_run_publishes_verified_mp3_and_metrics(self):
        out = Path(self.directory.name) / "out"
        out.mkdir(exist_ok=True)
        arguments = self.args()
        arguments.out = out / "en.mp3"
        arguments.metrics = out / "en.metrics.json"
        edge.run(arguments, json.loads(VOICES.read_text(encoding="utf-8")), FFMPEG, FFPROBE)
        record = json.loads(arguments.metrics.read_text(encoding="utf-8"))
        self.assertEqual(record["provider"], "edge-tts")
        self.assertEqual(record["voice"], "en-US-AndrewNeural")
        self.assertEqual(record["language"], "en")
        self.assertGreaterEqual(record["durationSeconds"], 10.0)
        self.assertGreater(record["bytes"], edge.base.MIN_BYTES)
        audio = out / "en.mp3"
        self.assertEqual(record["sha256"], hashlib.sha256(audio.read_bytes()).hexdigest())
        self.assertEqual(record["bytes"], audio.stat().st_size)
        self.assertEqual(len(FakeCommunicate.instances), 1)
        self.assertTrue(FakeCommunicate.instances[0].text.startswith("Phantomresearch"))

    def test_run_reorders_edge_languages_independently(self):
        voices = json.loads(VOICES.read_text(encoding="utf-8"))
        self.assertEqual(edge.engine_language(voices, "ja")["voice"], "ja-JP-NanamiNeural")

    def test_empty_stream_fails(self):
        FakeCommunicate.audio_chunks = []
        with self.assertRaises(RuntimeError):
            edge.run(self.args(), json.loads(VOICES.read_text(encoding="utf-8")), FFMPEG, FFPROBE)
        self.assertFalse((Path(self.directory.name) / "en.mp3").exists())

    def test_tiny_audio_fails_before_encode(self):
        FakeCommunicate.audio_chunks = [b"RIFF"[:10]] * 10
        with self.assertRaises(RuntimeError) as caught:
            edge.run(self.args(), json.loads(VOICES.read_text(encoding="utf-8")), FFMPEG, FFPROBE)
        self.assertIn("too small", str(caught.exception))


class CliValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.text = Path(self.directory.name) / "episode.txt"
        self.text.write_text(TEXT_LONG, encoding="utf-8")
        self.out = Path(self.directory.name) / "out.mp3"
        self.metrics = Path(self.directory.name) / "out.json"

    def run_cli(self, *arguments):
        return subprocess.run([sys.executable, str(MODULE_PATH)] + list(arguments),
                              capture_output=True, text=True, cwd=str(ROOT), timeout=120)

    def base(self):
        return ["--text-file", str(self.text), "--language", "ja",
                "--out", str(self.out), "--metrics", str(self.metrics)]

    def test_missing_arguments_exit_nonzero(self):
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.out.exists())

    def test_text_and_text_file_are_mutually_exclusive(self):
        result = self.run_cli(*self.base() + ["--text", TEXT_LONG])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exactly one of --text or --text-file", result.stderr)

    def test_bad_language_fails_before_network(self):
        result = self.run_cli("--text-file", str(self.text), "--language", "de",
                              "--out", str(self.out), "--metrics", str(self.metrics))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsupported language", result.stderr)
        self.assertFalse(self.out.exists())

    @unittest.skipUnless(EDGE_TTS_INSTALLED, "network rendering needs edge-tts installed")
    def test_real_package_imports(self):
        import edge_tts

        self.assertTrue(hasattr(edge_tts.Communicate, "stream"))


if __name__ == "__main__":
    unittest.main()