"""Synthesize one podcast MP3 with VoiceStudio (OpenAI-compatible local TTS server).

The daily podcast pipeline calls this adapter once per episode language:
  python3 scripts/podcast/synthesize_voicestudio.py \
      --text-file episode.txt --language en --out episode.mp3 --metrics episode.json

The server must already be running (default: http://127.0.0.1:3900/v1/audio/speech,
override with VOICESTUDIO_URL or --url). One JSON POST per invocation requests the
whole script with model "omnivoice-gguf" and the voice profile name from the
voices.json "voicestudio" section (e.g. "Phantom-EN") as the OpenAI-compatible
``voice`` field, response_format "wav". Returned WAV bytes are transcoded by
ffmpeg into a 48kbps mono libmp3lame MP3 through the language filter chain,
verified exactly like scripts/podcast/synthesize.py and published with a
temp-file rename. Timeouts and HTTP 5xx responses are retried twice with
exponential backoff; everything else fails fast. Every failure exits non-zero
with a clear stderr message.

Note: the voicestudio charsPerSecond bounds in voices.json are provisional
AI-suggested placeholders; tune them from measured episode pacing once real
VoiceStudio audio is available (pure JSON, so no inline comment there).

Only the standard library is used, so a plain system Python 3.9 can run it. The
quality gates, probe helpers and text cleanup are reused from synthesize.py,
which must sit in the same directory.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    import synthesize as base
except ImportError as _error:  # pragma: no cover - synthesize.py must ship alongside
    raise ImportError("synthesize.py must sit beside synthesize_voicestudio.py (%s)" % _error)

VOICES_PATH = base.VOICES_PATH
MIN_CHARS = base.MIN_CHARS
MAX_CHARS = base.MAX_CHARS
DEFAULT_URL = "http://127.0.0.1:3900/v1/audio/speech"
DEFAULT_MODEL = "omnivoice-gguf"
DEFAULT_VOICE = "default"
DEFAULT_FORMAT = "wav"
# 1800 s: server engines render 5-20 minute episodes on CPU-only hosts; three
# attempts with backoff keep the post_speech retry logic unchanged.
DEFAULT_TIMEOUT_SECONDS = 1800.0
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 1.0
MAX_ERROR_BODY = 200


def engine_language(voices, language):
    """Return the "voicestudio" engine entry for a language, or raise ValueError."""
    engine = voices.get("voicestudio") or {}
    entries = engine.get("languages") or {}
    entry = entries.get(language)
    if not isinstance(entry, dict):
        raise ValueError("Unsupported language %r for voicestudio engine; %s defines: %s" % (
            language, "voices.json voicestudio section", ", ".join(sorted(entries))))
    missing = [field for field in ("voice", "filters", "charsPerSecond") if field not in entry]
    if missing:
        raise ValueError("voicestudio language %r is missing %s" % (language, ", ".join(missing)))
    return entry


def voicestudio_voice(voices, language):
    """Best-effort voice profile name for episode.json records (None when unknown)."""
    entry = (voices.get("voicestudio") or {}).get("languages", {}).get(language)
    if not isinstance(entry, dict):
        return None
    return str(entry.get("voice") or "").strip() or None


def resolve_url(explicit=None, voices=None, env=None):
    """--url wins, then VOICESTUDIO_URL, then voices.json, then the default."""
    if explicit:
        return str(explicit)
    env = env if env is not None else os.environ
    override = (env.get("VOICESTUDIO_URL") or "").strip()
    if override:
        return override
    configured = ((voices or {}).get("voicestudio") or {}).get("url")
    return str(configured).strip() if configured else DEFAULT_URL


def request_payload(text, model=DEFAULT_MODEL, voice=DEFAULT_VOICE):
    """OpenAI-compatible /v1/audio/speech body; voice is the profile name/id."""
    return {
        "model": model or DEFAULT_MODEL,
        "input": text,
        "voice": voice,
        "response_format": DEFAULT_FORMAT,
    }


def wav_problems(payload, expect_format=DEFAULT_FORMAT):
    """Basic sanity checks for the returned audio bytes; empty list means use it."""
    if not payload:
        return ["empty response body"]
    if expect_format == DEFAULT_FORMAT and not payload[:4] == b"RIFF":
        return ["response is not a WAV (RIFF header missing)"]
    if len(payload) < 1000:
        return ["response is suspiciously small (%d bytes)" % len(payload)]
    return []


def post_speech(url, payload, timeout=DEFAULT_TIMEOUT_SECONDS, attempts=RETRY_ATTEMPTS,
                backoff=RETRY_BACKOFF_SECONDS, sleep=time.sleep, opener=None,
                on_retry=None):
    """POST the payload and return WAV bytes, retrying 5xx/timeouts with backoff.

    ``opener`` is injectable for tests (default: urllib.request.urlopen with an
    absolute timeout). HTTP 4xx and unexpected bodies fail immediately.
    """
    attempts = max(1, int(attempts))
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "audio/wav"}
    last_error = None
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            urlopen = opener or urllib.request.urlopen
            with urlopen(request, timeout=timeout) as response:
                status = response.status
                wav = response.read()
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = error.read().decode("utf-8", "replace")[:MAX_ERROR_BODY]
            except Exception:  # noqa: BLE001 - body reading is best-effort
                pass
            last_error = RuntimeError("HTTP %d from %s%s" % (error.code, url, ": " + detail if detail else ""))
            if error.code < 500:
                raise last_error  # 4xx: retrying will not help
        except (urllib.error.URLError, OSError) as error:  # URLError/OSError cover timeouts
            last_error = RuntimeError("request to %s failed: %s" % (url, error))
        else:
            if 500 <= status < 600:
                last_error = RuntimeError("HTTP %d from %s" % (status, url))
            else:
                problems = wav_problems(wav)
                if not problems:
                    return wav
                last_error = RuntimeError("; ".join(problems))
        if attempt < attempts:
            if on_retry is not None:
                on_retry(last_error, attempt)
            sleep(backoff * (2 ** (attempt - 1)))
    if last_error is None:  # pragma: no cover - defensive
        last_error = RuntimeError("request to %s failed" % url)
    raise last_error


def build_ffmpeg_args_wav(src, out, filters, bitrate, ffmpeg="ffmpeg"):
    """ffmpeg command for the one-shot filter chain + mono libmp3lame encode."""
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
            "-af", filters, "-ac", "1", "-c:a", "libmp3lame", "-b:a", bitrate, str(out)]


def run(args, voices, ffmpeg, ffprobe, request=None, on_retry=None):
    """Validate inputs, request WAV, encode, verify, then publish MP3 + metrics."""
    engine = voices.get("voicestudio") or {}
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
    url = resolve_url(getattr(args, "url", None), voices)
    timeout = DEFAULT_TIMEOUT_SECONDS if getattr(args, "timeout_seconds", None) is None else float(args.timeout_seconds)
    payload = request_payload(text, getattr(args, "model", None) or engine.get("model", DEFAULT_MODEL),
                              entry["voice"])
    if args.verbose:
        print("POST %s (voice=%s, %d chars)" % (url, entry["voice"], chars), flush=True)
    if request is None:
        request = lambda: post_speech(url, payload, timeout=timeout, on_retry=on_retry)  # noqa: E731
    with tempfile.TemporaryDirectory(dir=str(out.parent), prefix=".synthesize-voicestudio-") as scratch:
        raw_wav = Path(scratch) / "voice.wav"
        staged_mp3 = Path(scratch) / "voice.mp3"
        wav = request()
        raw_wav.write_bytes(wav)
        command = build_ffmpeg_args_wav(raw_wav, staged_mp3, entry["filters"],
                                        engine.get("bitrate", "48k"), ffmpeg)
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
        "provider": engine.get("provider", "voicestudio-omnivoice"),
        "model": payload["model"],
        "model_commit": None,
        "language": args.language,
        "voice": payload["voice"],
        "endpoint": url,
        "style_chars": len(entry["voice"]),
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
    parser.add_argument("--language", required=True, help="Language key from voices.json, e.g. en (voicestudio supports en/zh/ko)")
    parser.add_argument("--out", type=Path, required=True, help="Destination MP3 path")
    parser.add_argument("--metrics", type=Path, required=True, help="Destination metrics JSON path")
    parser.add_argument("--voices", type=Path, default=VOICES_PATH, help="Voice configuration JSON (default: %(default)s)")
    parser.add_argument("--url", help="Speech endpoint (default: VOICESTUDIO_URL, voices.json, then %(default)r)" % {
        "default": DEFAULT_URL})
    parser.add_argument("--model", help="Speech engine id (default: voices.json voicestudio.model, then %s)" % DEFAULT_MODEL)
    parser.add_argument("--timeout-seconds", type=float, default=None,
                        help="Per-request timeout in seconds (default: %s s)" % DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--ffmpeg", help="ffmpeg executable (default: env FFMPEG, then /opt/homebrew/bin/ffmpeg)")
    parser.add_argument("--ffprobe", help="ffprobe executable (default: env FFPROBE, then /opt/homebrew/bin/ffprobe)")
    parser.add_argument("--verbose", action="store_true", help="Print request, encoding and probe details")
    args = parser.parse_args(argv)
    if (args.text is None) == (args.text_file is None):
        parser.error("exactly one of --text or --text-file is required")
    args.ffmpeg = args.ffmpeg or base.default_tool("ffmpeg")
    args.ffprobe = args.ffprobe or base.default_tool("ffprobe")
    try:
        voices = base.load_voices(args.voices)
        run(args, voices, args.ffmpeg, args.ffprobe, on_retry=lambda error, attempt: print(
            "voicestudio attempt %d failed: %s; retrying" % (attempt, error), file=sys.stderr, flush=True))
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print("error: %s" % error, file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
