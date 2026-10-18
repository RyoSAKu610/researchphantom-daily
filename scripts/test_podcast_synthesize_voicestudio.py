"""Fast unit tests for scripts/podcast/synthesize_voicestudio.py (no server, no SDK).

VoiceStudio is mocked with in-process HTTP servers (http.server on loopback), so
no local OpenAI-compatible TTS server is needed. Realistic WAV fixtures are
built with /opt/homebrew/bin/ffmpeg lavfi; the resulting MP3 passes through the
same ffmpeg/ffprobe probes as production.
Run: PATH=/opt/homebrew/bin:/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_podcast_synthesize_voicestudio.py' -v
"""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts/podcast/synthesize_voicestudio.py"
FFMPEG = os.environ.get("FFMPEG") or (
    "/opt/homebrew/bin/ffmpeg" if Path("/opt/homebrew/bin/ffmpeg").is_file() else shutil.which("ffmpeg"))
FFPROBE = os.environ.get("FFPROBE") or (
    "/opt/homebrew/bin/ffprobe" if Path("/opt/homebrew/bin/ffprobe").is_file() else shutil.which("ffprobe"))
VOICES = Path(__file__).resolve().parent / "podcast/voices.json"
TEXT_LONG = ("Today's research brief covers a fresh topic in clear narration "
             "with steady volume and natural pacing for listeners everywhere. ") * 8


def load_adapters():
    adapters = {}
    for name in ("synthesize", "synthesize_voicestudio"):
        spec = importlib.util.spec_from_file_location("podcast_%s_vs" % name,
                                                      ROOT / ("scripts/podcast/%s.py" % name))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        adapters[name] = module
    return adapters["synthesize"], adapters["synthesize_voicestudio"]


synth, voicestudio = load_adapters()


def make_wav(seconds=12.0, amplitude="0.2"):
    """Tiny sine wav with lavfi (peaks around 0.125*amplitude)."""
    result = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                             "-i", "sine=frequency=440:sample_rate=24000:duration=%s" % seconds,
                             "-af", "volume=%s" % amplitude, "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
                            check=True, timeout=120, stdout=subprocess.PIPE)
    return result.stdout


class RequestPayloadTests(unittest.TestCase):
    def test_payload_matches_voicestudio_contract(self):
        payload = voicestudio.request_payload("Hello there.", model=None, voice="Phantom-EN")
        self.assertEqual(payload["model"], "omnivoice-gguf")
        self.assertEqual(payload["voice"], "Phantom-EN")
        self.assertEqual(payload["response_format"], "wav")
        self.assertEqual(payload["input"], "Hello there.")
        self.assertEqual(sorted(payload), ["input", "model", "response_format", "voice"])

    def test_payload_defaults(self):
        payload = voicestudio.request_payload("Hello there.")
        self.assertEqual(payload["model"], "omnivoice-gguf")
        self.assertEqual(payload["voice"], "default")

    def test_engine_language_reads_voicestudio_section(self):
        voices = json.loads(VOICES.read_text(encoding="utf-8"))
        entry = voicestudio.engine_language(voices, "en")
        self.assertEqual(entry["voice"], voices["voicestudio"]["languages"]["en"]["voice"])
        self.assertEqual(voicestudio.engine_language(voices, "zh")["voice"], "Phantom-ZH")
        self.assertEqual(voicestudio.engine_language(voices, "ko")["voice"], "Phantom-KO")
        with self.assertRaises(ValueError):
            voicestudio.engine_language(voices, "ja")  # ja stays on irodori
        with self.assertRaises(ValueError):
            voicestudio.engine_language(voices, "de")

    def test_engine_language_missing_field_raises(self):
        voices = {"voicestudio": {"languages": {"de": {"voice": "x", "filters": "none"}}}}
        with self.assertRaises(ValueError) as caught:
            voicestudio.engine_language(voices, "de")
        self.assertIn("missing", str(caught.exception))
        self.assertIn("charsPerSecond", str(caught.exception))

    def test_resolve_url_precedence(self):
        self.assertEqual(voicestudio.resolve_url("http://flag", None, {}), "http://flag")
        self.assertEqual(voicestudio.resolve_url(None, None, {"VOICESTUDIO_URL": "http://env"}), "http://env")
        voices = {"voicestudio": {"url": "http://voices"}}
        self.assertEqual(voicestudio.resolve_url(None, voices, {}), "http://voices")
        self.assertEqual(voicestudio.resolve_url(None, None, {}), "http://127.0.0.1:3900/v1/audio/speech")

    def test_resolve_url_ignores_irodori_and_qwen_sections(self):
        voices = {"irodori": {"url": "http://irodori:8088/v1/audio/speech"},
                  "qwen": {"url": "http://qwen/v1/audio/speech"}}
        self.assertEqual(voicestudio.resolve_url(None, voices, {}), "http://127.0.0.1:3900/v1/audio/speech")


class FakeServer:
    """Scripted HTTP server that serves one behaviour function per request."""

    def __init__(self, behaviours):
        container = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler API
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                container.requests.append(body)
                behaviour = container.behaviours.next_(json.loads(body))
                status, headers, payload = behaviour
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.requests = []
        self.behaviours = _Behaviours(behaviours)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def url(self):
        return "http://127.0.0.1:%d/v1/audio/speech" % self.server.server_address[1]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *args):
        self.stop()


class _Behaviours:
    def __init__(self, behaviours):
        self.behaviours = list(behaviours) if behaviours is not None else None
        self.index = 0

    def next_(self, body):
        if self.behaviours is None or self.index >= len(self.behaviours):
            return 200, {"Content-Type": "audio/wav"}, b""
        behaviour = self.behaviours[self.index]
        self.index += 1
        if callable(behaviour):
            return behaviour(body)
        return behaviour


class PostSpeechRetryTests(unittest.TestCase):
    def setUp(self):
        self.wav = make_wav(2.0)
        self.sleeps = []
        self.sleep = lambda seconds: self.sleeps.append(seconds)

    def test_retries_timeouts_and_5xx_with_backoff(self):
        responses = [self._timeout_stub(), self._timeout_stub(),
                     (200, {"Content-Type": "audio/wav"}, self.wav)]
        with FakeServer(responses) as server:
            wav = voicestudio.post_speech(server.url(), {}, timeout=1.0, backoff=0.25,
                                          sleep=self.sleep, opener=urllib.request.urlopen)
            self.assertEqual(wav, self.wav)
        self.assertEqual(len(server.requests), 3)
        self.assertEqual(self.sleeps, [0.25, 0.5])

    @staticmethod
    def _timeout_stub():
        def behaviour(body):
            import time as _time
            _time.sleep(2.0)
            return 200, {}, b""
        return behaviour

    def test_5xx_is_retried_4xx_is_not(self):
        with FakeServer([(500, {"Content-Type": "text/plain"}, b"boom"),
                         (200, {"Content-Type": "audio/wav"}, self.wav)]) as server:
            wav = voicestudio.post_speech(server.url(), {}, backoff=0.0, sleep=self.sleep)
            self.assertEqual(wav, self.wav)

        with FakeServer([(404, {"Content-Type": "text/plain"}, b"nope")]) as server:
            with self.assertRaises(RuntimeError) as caught:
                voicestudio.post_speech(server.url(), {}, backoff=0.0, sleep=self.sleep)
            self.assertIn("HTTP 404", str(caught.exception))
            self.assertEqual(len(server.requests), 1)

    def test_4xx_error_body_detail_is_included(self):
        with FakeServer([(422, {"Content-Type": "application/json"},
                          b'{"error":{"message":"unknown voice"}}')]) as server:
            with self.assertRaises(RuntimeError) as caught:
                voicestudio.post_speech(server.url(), {}, backoff=0.0, sleep=self.sleep)
        self.assertIn("unknown voice", str(caught.exception))
        self.assertEqual(len(server.requests), 1)

    def test_empty_and_non_wav_bodies_are_rejected(self):
        for payload in (b"", b"not-a-wav"):
            with FakeServer([(200, {"Content-Type": "audio/wav"}, payload)]) as server:
                with self.assertRaises(RuntimeError):
                    voicestudio.post_speech(server.url(), {}, backoff=0.0, sleep=self.sleep)

    def test_all_attempts_exhausted_raises_clear_error(self):
        with FakeServer(None) as server:  # always returns empty body
            with self.assertRaises(RuntimeError) as caught:
                voicestudio.post_speech(server.url(), {}, attempts=2, backoff=0.0, sleep=self.sleep)
        self.assertIn("empty response body", str(caught.exception))
        self.assertEqual(len(server.requests), 2)

    def test_server_down_after_retries(self):
        # Bound-but-not-listening socket always answers connect() with ECONNREFUSED.
        import socket

        blocker = socket.socket()
        blocker.bind(("127.0.0.1", 0))
        port = blocker.getsockname()[1]
        blocker.close()
        url = "http://127.0.0.1:%d/v1/audio/speech" % port
        with self.assertRaises(RuntimeError) as caught:
            voicestudio.post_speech(url, {}, attempts=2, backoff=0.0, sleep=self.sleep)
        self.assertIn("request to", str(caught.exception))


class RunTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        # 310 s: the 300..1200 s container gate needs episode-length audio;
        # TEXT_LONG (en, ~3070 chars at 310 s) also satisfies the en pacing bounds.
        self.wav = make_wav(310.0, amplitude="0.4")

    def cli_args(self, url, text_source=None, language="en"):
        text = Path(self.directory.name) / "episode.txt"
        text.write_text(text_source or TEXT_LONG, encoding="utf-8")
        import argparse

        return argparse.Namespace(text=None, text_file=text, language=language,
                                  out=Path(self.directory.name) / ("%s.mp3" % language),
                                  metrics=Path(self.directory.name) / ("%s.metrics.json" % language),
                                  voices=VOICES, url=url, model=None, timeout_seconds=None,
                                  ffmpeg=FFMPEG, ffprobe=FFPROBE, verbose=False)

    def test_run_publishes_mp3_and_metrics(self):
        with FakeServer([(200, {"Content-Type": "audio/wav"}, self.wav)]) as server:
            args = self.cli_args(server.url())
            voicestudio.run(args, json.loads(VOICES.read_text(encoding="utf-8")), FFMPEG, FFPROBE)
        record = json.loads(args.metrics.read_text(encoding="utf-8"))
        self.assertEqual(record["provider"], "voicestudio-omnivoice")
        self.assertEqual(record["model"], "omnivoice-gguf")
        self.assertEqual(record["voice"], "Phantom-EN")
        self.assertEqual(record["language"], "en")
        self.assertGreaterEqual(record["durationSeconds"], 10.0)
        audio = Path(self.directory.name) / "en.mp3"
        self.assertGreater(audio.stat().st_size, voicestudio.base.MIN_BYTES)
        import hashlib

        self.assertEqual(record["sha256"], hashlib.sha256(audio.read_bytes()).hexdigest())
        self.assertEqual(record["bytes"], audio.stat().st_size)
        self.assertEqual(record["style_chars"], len("Phantom-EN"))

    def test_run_records_endpoint_and_payload(self):
        with FakeServer([(200, {"Content-Type": "audio/wav"}, self.wav)]) as server:
            args = self.cli_args(server.url())
            voicestudio.run(args, json.loads(VOICES.read_text(encoding="utf-8")), FFMPEG, FFPROBE)
        record = json.loads(args.metrics.read_text(encoding="utf-8"))
        self.assertEqual(record["endpoint"], server.url())
        payload = json.loads(server.requests[0].decode("utf-8"))
        self.assertEqual(payload["model"], "omnivoice-gguf")
        self.assertEqual(payload["voice"], "Phantom-EN")
        self.assertEqual(payload["response_format"], "wav")
        self.assertGreater(len(payload["input"]), 50)

    def test_run_retries_and_succeeds_with_retry_log(self):
        buffer_ = io.StringIO()
        with FakeServer([(503, {"Content-Type": "text/plain"}, b"busy"),
                         (200, {"Content-Type": "audio/wav"}, self.wav)]) as server:
            args = self.cli_args(server.url())
            voices = json.loads(VOICES.read_text(encoding="utf-8"))
            voicestudio.run(args, voices, FFMPEG, FFPROBE, on_retry=lambda error, attempt: buffer_.write(
                "voicestudio attempt %d failed: %s" % (attempt, error)))
        self.assertIn("voicestudio attempt 1 failed", buffer_.getvalue())
        self.assertEqual(len(server.requests), 2)
        self.assertTrue(args.out.exists())


class CliTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.wav = make_wav(310.0, amplitude="0.4")  # 300..1200 s container gate
        self.text = Path(self.directory.name) / "episode.txt"
        self.text.write_text(TEXT_LONG, encoding="utf-8")

    def base(self, url):
        return ["--text-file", str(self.text), "--language", "en",
                "--out", str(Path(self.directory.name) / "en.mp3"),
                "--metrics", str(Path(self.directory.name) / "en.metrics.json"),
                "--url", url]

    def test_end_to_end_with_mock_server(self):
        with FakeServer([(200, {"Content-Type": "audio/wav"}, self.wav)]) as server:
            result = subprocess.run([sys.executable, str(MODULE_PATH)] + self.base(server.url()),
                                    capture_output=True, text=True, cwd=str(ROOT), timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wrote", result.stdout)
        metrics = json.loads((Path(self.directory.name) / "en.metrics.json").read_text(encoding="utf-8"))
        self.assertEqual(metrics["voice"], "Phantom-EN")
        payload = json.loads(server.requests[0].decode("utf-8"))
        self.assertEqual(payload["model"], "omnivoice-gguf")
        self.assertEqual(payload["voice"], "Phantom-EN")
        self.assertEqual(payload["response_format"], "wav")
        self.assertGreater(len(payload["input"]), 50)

    def test_repeated_5xx_exits_nonzero_with_clear_stderr(self):
        with FakeServer([(500, {"Content-Type": "text/plain"}, b"boom")] * 3) as server:
            result = subprocess.run([sys.executable, str(MODULE_PATH)] + self.base(server.url()),
                                    capture_output=True, text=True, cwd=str(ROOT), timeout=180)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HTTP 500", result.stderr)
        self.assertFalse((Path(self.directory.name) / "en.mp3").exists())

    def test_server_unreachable_exits_nonzero(self):
        # Nothing is listening: the connection is refused deterministically.
        url = "http://127.0.0.1:9/v1/audio/speech"
        result = subprocess.run([sys.executable, str(MODULE_PATH)] + self.base(url),
                                capture_output=True, text=True, cwd=str(ROOT), timeout=60)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error:", result.stderr)
        self.assertFalse((Path(self.directory.name) / "en.mp3").exists())

    def test_unsupported_language_fails_without_requests(self):
        with FakeServer([]) as server:
            arguments = ["--text-file", str(self.text), "--language", "ja",
                         "--out", str(Path(self.directory.name) / "ja.mp3"),
                         "--metrics", str(Path(self.directory.name) / "ja.metrics.json"),
                         "--url", server.url()]
            result = subprocess.run([sys.executable, str(MODULE_PATH)] + arguments,
                                    capture_output=True, text=True, cwd=str(ROOT), timeout=60)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Unsupported language", result.stderr)
            self.assertEqual(len(server.requests), 0)


if __name__ == "__main__":
    unittest.main()
