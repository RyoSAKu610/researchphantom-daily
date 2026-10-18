"""Fast unit tests for scripts/podcast/synthesize.py (no model, no ML runtime).

Fixtures are tiny sine MP3s built with /opt/homebrew/bin/ffmpeg lavfi. The
adapter module is imported directly from its path so the tests never need the
.venv-tts interpreter or numpy.
Run: PATH=/opt/homebrew/bin:/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_podcast_synthesize.py' -v
"""

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts/podcast/synthesize.py"
FFMPEG = os.environ.get("FFMPEG") or (
    "/opt/homebrew/bin/ffmpeg" if Path("/opt/homebrew/bin/ffmpeg").is_file() else shutil.which("ffmpeg"))
FFPROBE = os.environ.get("FFPROBE") or (
    "/opt/homebrew/bin/ffprobe" if Path("/opt/homebrew/bin/ffprobe").is_file() else shutil.which("ffprobe"))
ML_RUNTIME_PRESENT = importlib.util.find_spec("mlx_audio") is not None
LONG_TEXT = "Phantomresearch Daily covers fresh diffusion model papers with short, clear summaries. " * 2


def load_adapter():
    spec = importlib.util.spec_from_file_location("podcast_synthesize", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


synth = load_adapter()


class CleanTextTests(unittest.TestCase):
    def test_collapses_whitespace_and_blank_lines(self):
        raw = "第一段落。\n\n\n\n   第二段落  \t  with   spaces  \n\n\n第三段落。\n"
        self.assertEqual(synth.clean_text(raw), "第一段落。\n\n第二段落 with spaces\n\n第三段落。")

    def test_preserves_unicode_and_single_breaks(self):
        self.assertEqual(synth.clean_text("こんにちは。　全角　スペース。"), "こんにちは。 全角 スペース。")
        self.assertEqual(synth.clean_text("a\r\nb\rc"), "a\nb\nc")
        self.assertEqual(synth.clean_text("안녕하세요. 팬텀리서치 데일리입니다."), "안녕하세요. 팬텀리서치 데일리입니다.")

    def test_strips_edges(self):
        self.assertEqual(synth.clean_text("\n\n  hello  \n\n"), "hello")


class DurationBoundsTests(unittest.TestCase):
    BOUNDS = [6.0, 30.0]  # 6..30 characters per second

    def metrics(self, duration, chars):
        return {"durationSeconds": duration, "seconds_per_char": duration / chars}

    def test_accepts_inside_bounds(self):
        self.assertTrue(synth.duration_bounds_ok(self.metrics(10.0, 100), 100, self.BOUNDS))

    def test_inclusive_edges(self):
        self.assertTrue(synth.duration_bounds_ok(self.metrics(10.0, 60), 60, self.BOUNDS))
        self.assertTrue(synth.duration_bounds_ok(self.metrics(2.0, 60), 60, self.BOUNDS))

    def test_rejects_outside_hard_bounds(self):
        self.assertFalse(synth.duration_bounds_ok(self.metrics(25.0, 100), 100, self.BOUNDS))
        self.assertFalse(synth.duration_bounds_ok(self.metrics(2.0, 100), 100, self.BOUNDS))
        self.assertFalse(synth.duration_bounds_ok(self.metrics(25.0, 100), 100, self.BOUNDS, tolerance=0.2))

    def test_tolerance_allows_warn_zone(self):
        metrics = self.metrics(19.0, 100)  # 5.26 chars/s: 12% under the slow bound -> warn, not fail
        self.assertFalse(synth.duration_bounds_ok(metrics, 100, self.BOUNDS))
        self.assertTrue(synth.duration_bounds_ok(metrics, 100, self.BOUNDS, tolerance=0.2))

    def test_rejects_bad_input(self):
        self.assertFalse(synth.duration_bounds_ok(self.metrics(10.0, 100), 100, [6.0]))
        self.assertFalse(synth.duration_bounds_ok({"durationSeconds": 0}, 100, self.BOUNDS))
        self.assertFalse(synth.duration_bounds_ok({"seconds_per_char": 0.0}, 100, self.BOUNDS))
        self.assertFalse(synth.duration_bounds_ok({"durationSeconds": float("nan")}, 100, self.BOUNDS))
        self.assertFalse(synth.duration_bounds_ok(self.metrics(10.0, 100), 100, [30.0, 6.0]))


class MetricsTests(unittest.TestCase):
    GOOD = {"peak": 0.8, "rms_dbfs": -20.0, "clipped_fraction": 0.0, "silent_fraction": 0.2,
            "leading_silence_seconds": 0.5, "trailing_silence_seconds": 1.0, "longest_silence_seconds": 1.0}

    def test_accepts_healthy_metrics(self):
        self.assertTrue(synth.metrics_ok(dict(self.GOOD)))
        self.assertEqual(synth.metrics_failures(dict(self.GOOD)), [])

    def test_accepts_exact_thresholds(self):
        edge = {"peak": 0.02, "rms_dbfs": -36.0, "clipped_fraction": 0.002, "silent_fraction": 0.6,
                "leading_silence_seconds": 2.5, "trailing_silence_seconds": 2.5, "longest_silence_seconds": 5.0}
        self.assertTrue(synth.metrics_ok(edge))

    def test_rejects_each_violation(self):
        for name, bad in (("peak", 0.01), ("rms_dbfs", -40.0), ("clipped_fraction", 0.01),
                          ("silent_fraction", 0.7), ("longest_silence_seconds", 6.0),
                          ("leading_silence_seconds", 3.0), ("trailing_silence_seconds", 2.6)):
            metrics = dict(self.GOOD)
            metrics[name] = bad
            self.assertFalse(synth.metrics_ok(metrics), name)

    def test_rejects_missing_or_non_finite_metrics(self):
        self.assertFalse(synth.metrics_ok({}))
        broken = dict(self.GOOD)
        broken["rms_dbfs"] = float("nan")
        self.assertFalse(synth.metrics_ok(broken))


class BuildFfmpegArgsTests(unittest.TestCase):
    def test_contains_encoder_bitrate_and_filters(self):
        command = synth.build_ffmpeg_args(Path("in.wav"), Path("out.mp3"),
                                          "highpass=f=75,lowpass=f=11000,loudnorm=I=-18:TP=-2:LRA=11", "128k")
        self.assertEqual(command[0], "ffmpeg")
        self.assertIn("-af", command)
        self.assertEqual(command[command.index("-af") + 1],
                         "highpass=f=75,lowpass=f=11000,loudnorm=I=-18:TP=-2:LRA=11")
        self.assertIn("libmp3lame", command)
        self.assertEqual(command[command.index("-b:a") + 1], "128k")
        self.assertEqual(command[-1], "out.mp3")


class ProbeIssueTests(unittest.TestCase):
    def test_rejects_wrong_codec_duration_and_size(self):
        self.assertTrue(synth.probe_issues({"codec": "aac", "duration": 120.0}, 200000))
        self.assertTrue(synth.probe_issues({"codec": "mp3", "duration": 5.0}, 200000))
        self.assertTrue(synth.probe_issues({"codec": "mp3", "duration": 700.0}, 200000))
        self.assertTrue(synth.probe_issues({"codec": "mp3", "duration": 120.0}, 9999))

    def test_accepts_valid_mp3_container(self):
        self.assertEqual(synth.probe_issues({"codec": "mp3", "duration": 120.0}, 200000), [])


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg and ffprobe are required for MP3 fixtures")
class Mp3FixtureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def make_mp3(self, name, seconds, bitrate="128k", amplitude="4"):
        # This ffmpeg's lavfi sine source peaks near 0.125, so volume=4 lands near 0.5 full swing.
        target = Path(self.directory.name) / name
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                        "-i", "sine=frequency=440:sample_rate=24000:duration=%s" % seconds,
                        "-af", "volume=%s" % amplitude, "-c:a", "libmp3lame", "-b:a", bitrate, str(target)],
                       check=True, timeout=120)
        return target

    def test_probe_reads_codec_and_duration(self):
        probe = synth.probe_mp3(self.make_mp3("ok.mp3", 12), FFPROBE)
        self.assertEqual(probe["codec"], "mp3")
        self.assertAlmostEqual(probe["duration"], 12.0, delta=0.5)

    def test_audio_metrics_on_real_tone(self):
        target = self.make_mp3("tone.mp3", 12)
        probe = synth.probe_mp3(target, FFPROBE)
        self.assertEqual(synth.probe_issues(probe, target.stat().st_size), [])
        metrics = synth.audio_metrics(target, probe["duration"], 120, FFMPEG)
        self.assertGreater(metrics["peak"], 0.2)
        self.assertGreater(metrics["rms_dbfs"], -20.0)
        self.assertLess(metrics["silent_fraction"], 0.6)
        self.assertTrue(synth.metrics_ok(metrics))

    def test_audio_metrics_rejects_inaudible_silence(self):
        target = self.make_mp3("quiet.mp3", 1.5, bitrate="32k", amplitude="0.0005")
        metrics = synth.audio_metrics(target, 1.5, 120, FFMPEG)
        self.assertLess(metrics["peak"], 0.02)
        self.assertGreater(metrics["silent_fraction"], 0.6)
        self.assertFalse(synth.metrics_ok(metrics))


class CliValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.text_file = Path(self.directory.name) / "episode.txt"
        self.text_file.write_text(LONG_TEXT, encoding="utf-8")
        self.out = Path(self.directory.name) / "out.mp3"
        self.metrics = Path(self.directory.name) / "out.json"

    def run_cli(self, *arguments):
        return subprocess.run([sys.executable, str(MODULE_PATH)] + list(arguments),
                              capture_output=True, text=True, cwd=str(ROOT), timeout=120)

    def base(self):
        return ["--text-file", str(self.text_file), "--language", "ja",
                "--out", str(self.out), "--metrics", str(self.metrics)]

    def test_missing_arguments_exit_nonzero(self):
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.out.exists())

    def test_language_flag_is_required(self):
        result = self.run_cli("--text-file", str(self.text_file), "--out", str(self.out), "--metrics", str(self.metrics))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.out.exists())

    def test_bad_language_fails_before_model_load(self):
        result = self.run_cli("--text-file", str(self.text_file), "--language", "de",
                              "--out", str(self.out), "--metrics", str(self.metrics))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsupported language", result.stderr)
        self.assertNotIn("Loading model", result.stdout)
        self.assertFalse(self.out.exists())

    def test_text_and_text_file_are_mutually_exclusive(self):
        arguments = self.base() + ["--text", LONG_TEXT]
        result = self.run_cli(*arguments)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exactly one of --text or --text-file", result.stderr)
        self.assertFalse(self.out.exists())

    def test_short_and_long_text_rejected(self):
        for candidate, tail in (("短いテキスト。", "got 7"), ("あ" * 8001, "got 8001")):
            self.text_file.write_text(candidate, encoding="utf-8")
            result = self.run_cli(*self.base())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(tail, result.stderr)
            self.assertFalse(self.out.exists())

    def test_missing_voices_file_fails(self):
        arguments = self.base()
        result = self.run_cli(*arguments, "--voices", str(Path(self.directory.name) / "absent.json"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.out.exists())

    @unittest.skipIf(ML_RUNTIME_PRESENT, "mlx_audio is installed here; deferral check needs a plain interpreter")
    def test_valid_arguments_reach_deferred_runtime_error(self):
        result = self.run_cli(*self.base())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Local TTS runtime is unavailable", result.stderr)
        self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
