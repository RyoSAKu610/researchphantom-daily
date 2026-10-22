"""Synthesize one podcast MP3 with the edge-tts library (Microsoft neural voices).

The daily podcast pipeline calls this adapter once per episode language:
  .venv-edge/bin/python scripts/podcast/synthesize_edge.py \
      --text-file episode.txt --language ja --out episode.mp3 --metrics episode.json

An active edge-tts==7.3.1 installation is required (``.venv-edge``); the library
streams MP3 audio from speech.platform.bing.com and needs network access. The
whole script is rendered through one Communicate instance, re-encoded to a 48kbps
mono libmp3lame MP3 through the language filter chain from scripts/podcast/voices.json
("edge" section), and verified like scripts/podcast/synthesize.py before the file
is published with a temp-file rename. The metrics JSON records the same keys.

edge-tts is imported only inside the collection step, so every pure helper stays
importable (and testable) with a plain system Python. The quality gates, probe
helpers and text cleanup are reused from synthesize.py, which must sit in the
same directory.
"""

import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    import synthesize as base
except ImportError as _error:  # pragma: no cover - synthesize.py must ship alongside
    raise ImportError("synthesize.py must sit beside synthesize_edge.py (%s)" % _error)

VOICES_PATH = base.VOICES_PATH
MIN_CHARS = base.MIN_CHARS
MAX_CHARS = base.MAX_CHARS
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 1.0


def engine_language(voices, language):
    """Return the "edge" engine entry for a language, or raise ValueError."""
    engine = voices.get("edge") or {}
    entries = engine.get("languages") or {}
    entry = entries.get(language)
    if not isinstance(entry, dict):
        raise ValueError("Unsupported language %r for edge engine; %s defines: %s" % (
            language, "voices.json edge section", ", ".join(sorted(entries))))
    missing = [field for field in ("voice", "filters", "charsPerSecond") if field not in entry]
    if missing:
        raise ValueError("edge language %r is missing %s" % (language, ", ".join(missing)))
    return entry


def edge_voice(voices, language):
    """Best-effort voice name for episode.json records (None when unknown)."""
    entry = (voices.get("edge") or {}).get("languages", {}).get(language)
    if not isinstance(entry, dict):
        return None
    return str(entry.get("voice") or "").strip() or None


def with_retries(callable_, attempts=RETRY_ATTEMPTS, backoff=RETRY_BACKOFF_SECONDS,
                 sleep=time.sleep, on_retry=None):
    """Run ``callable_()`` up to ``attempts`` times with exponential backoff.

    Raises the last error when every attempt failed. ``on_retry`` receives
    (error, attempt) so callers can log what went wrong.
    """
    attempts = max(1, int(attempts))
    for attempt in range(1, attempts + 1):
        try:
            return callable_()
        except Exception as error:  # noqa: BLE001 - the caller formats reason strings
            if attempt >= attempts:
                raise
            if on_retry is not None:
                on_retry(error, attempt)
            sleep(backoff * (2 ** (attempt - 1)))


async def _stream_audio(text, voice):
    """Collect edge-tts MP3 bytes for one script through a single Communicate."""
    import edge_tts

    communicate = edge_tts.Communicate(text, voice)
    chunks = []
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio":
            chunks.append(chunk["data"])
    if not chunks:
        raise RuntimeError("edge-tts returned no audio")
    return b"".join(chunks)


def collect_audio(text, voice):
    """Render the script and return one MP3 byte string (asyncio bridge)."""
    return asyncio.run(_stream_audio(text, voice))


def build_ffmpeg_args_mp3(src, out, filters, bitrate, ffmpeg="ffmpeg"):
    """ffmpeg command for the one-shot filter chain + mono libmp3lame encode."""
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
            "-af", filters, "-ac", "1", "-c:a", "libmp3lame", "-b:a", bitrate, str(out)]


def run(args, voices, ffmpeg, ffprobe, collect=collect_audio, on_retry=None):
    """Validate inputs, render, encode, verify, then publish MP3 + metrics."""
    entry = engine_language(voices, args.language)
    raw = Path(args.text_file).read_text(encoding="utf-8") if args.text_file is not None else args.text
    text = base.clean_text(raw)
    chars = len(text)
    if not MIN_CHARS <= chars <= MAX_CHARS:
        raise ValueError("Episode text must be %d..%d characters after cleanup, got %d" % (
            MIN_CHARS, MAX_CHARS, chars))
    out = Path(args.out)
    metrics_path = Path(args.metrics)
    out.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=str(out.parent), prefix=".synthesize-edge-") as scratch:
        raw_mp3 = Path(scratch) / "voice.mp3"
        staged_mp3 = Path(scratch) / "voice-usable.mp3"

        def speak():
            payload = collect(text, entry["voice"])
            if len(payload) < base.MIN_BYTES:
                raise RuntimeError("edge-tts audio is too small (%d bytes)" % len(payload))
            return payload

        print("Rendering %d characters with edge-tts (voice=%s)" % (chars, entry["voice"]), flush=True)
        raw_mp3.write_bytes(with_retries(speak, on_retry=on_retry))
        command = build_ffmpeg_args_mp3(raw_mp3, staged_mp3, entry["filters"],
                                        (voices.get("edge") or {}).get("bitrate", "48k"), ffmpeg)
        if args.verbose:
            print("Encoding: %s" % " ".join(command), flush=True)
        subprocess.run(command, check=True)
        probe = base.probe_mp3(staged_mp3, ffprobe)
        size = staged_mp3.stat().st_size
        problems = base.probe_issues(probe, size)
        if problems:
            raise RuntimeError("MP3 validation failed: %s" % "; ".join(problems))
        duration = probe["duration"]
        metrics = base.audio_metrics(staged_mp3, duration, chars, ffmpeg)
        problems = base.metrics_failures(metrics)
        if problems:
            raise RuntimeError("Audio quality gate failed: %s" % "; ".join(problems))
        if not base.duration_bounds_ok(metrics, chars, entry["charsPerSecond"], tolerance=base.DURATION_TOLERANCE):
            raise RuntimeError("Pacing %.3f s/char outside %s chars/s bounds widened by %.0f%%" % (
                duration / chars, entry["charsPerSecond"], base.DURATION_TOLERANCE * 100))
        if not base.duration_bounds_ok(metrics, chars, entry["charsPerSecond"]):
            print("warning: pacing %.3f s/char outside expected %s chars/s bounds (inside hard gate)" % (
                duration / chars, entry["charsPerSecond"]), flush=True)
        staged_mp3.replace(out)  # publish only after every gate passed
    record = {
        "provider": (voices.get("edge") or {}).get("provider", "edge-tts"),
        "model": edge_voice(voices, args.language),
        "model_commit": None,
        "language": args.language,
        "voice": edge_voice(voices, args.language),
        "style_chars": 0,
        "text_chars": chars,
        "durationSeconds": round(duration, 3),
        "bytes": size,
        "sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
        "peak": metrics["peak"],
        "rms_dbfs": metrics["rms_dbfs"],
        "clipped_fraction": metrics["clipped_fraction"],
        "silent_fraction": metrics["silent_fraction"],
        "leading_silence_seconds": metrics["leading_silence_seconds"],
        "trailing_silence_seconds": metrics["trailing_silence_seconds"],
        "longest_silence_seconds": metrics["longest_silence_seconds"],
        "seconds_per_char": metrics["seconds_per_char"],
    }
    temporary = metrics_path.with_name(metrics_path.name + ".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(metrics_path)
    print("Wrote %s (%.2f s, %d bytes, %d chars, voice %s)" % (
        out, duration, size, chars, record["voice"]), flush=True)
    print("Metrics: %s (rms %.2f dBFS, silent %.3f, s/char %.3f)" % (
        metrics_path, metrics["rms_dbfs"], metrics["silent_fraction"], metrics["seconds_per_char"]), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--text", help="Episode script as a string (alternative to --text-file)")
    parser.add_argument("--text-file", type=Path, help="UTF-8 file with the episode script")
    parser.add_argument("--language", required=True, help="Language key from voices.json, e.g. ja, zh, de, es, ru, it")
    parser.add_argument("--out", type=Path, required=True, help="Destination MP3 path")
    parser.add_argument("--metrics", type=Path, required=True, help="Destination metrics JSON path")
    parser.add_argument("--voices", type=Path, default=VOICES_PATH, help="Voice configuration JSON (default: %(default)s)")
    parser.add_argument("--ffmpeg", help="ffmpeg executable (default: env FFMPEG, then /opt/homebrew/bin/ffmpeg)")
    parser.add_argument("--ffprobe", help="ffprobe executable (default: env FFPROBE, then /opt/homebrew/bin/ffprobe)")
    parser.add_argument("--verbose", action="store_true", help="Print collection, encoding and probe details")
    args = parser.parse_args(argv)
    if (args.text is None) == (args.text_file is None):
        parser.error("exactly one of --text or --text-file is required")
    args.ffmpeg = args.ffmpeg or base.default_tool("ffmpeg")
    args.ffprobe = args.ffprobe or base.default_tool("ffprobe")
    try:
        voices = base.load_voices(args.voices)
        run(args, voices, args.ffmpeg, args.ffprobe, on_retry=lambda error, attempt: print(
            "edge-tts attempt %d failed: %s; retrying" % (attempt, error), file=sys.stderr, flush=True))
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print("error: %s" % error, file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())