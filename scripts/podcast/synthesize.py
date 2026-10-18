"""Synthesize one local podcast MP3 with the offline Qwen3-TTS CustomVoice model.

The daily podcast pipeline calls this adapter once per episode language:
  .venv-tts/bin/python scripts/podcast/synthesize.py \
      --text-file episode.txt --language ja --out episode.mp3 --metrics episode.json

Each invocation loads the model exactly once, renders the whole script with
model.generate_custom_voice (the pattern proven in scripts/generate_guide_voices.py),
encodes a single 128k libmp3lame MP3 through the language filter chain from
scripts/podcast/voices.json, and verifies codec, duration, level, clipping,
silence and per-character pacing before publishing the file with a temp-file
rename. The metrics JSON records provenance and measurements.
HF_HUB_OFFLINE is honored when the caller sets it; this adapter never forces it.
The ML runtime is imported only inside the generation step, so every pure helper
stays importable (and testable) with a plain system Python.
"""

import argparse
import array
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


VOICES_PATH = Path(__file__).resolve().parent / "voices.json"
SAMPLE_RATE = 24000
MAX_TOKENS = 3000
MIN_CHARS = 50
# 15k chars: en at 0.082 s/char is ~1230 s of pacing headroom; ja/zh/ko hit the
# MAX_TOKENS model limit long before this, so script.mjs owns the real ceiling.
MAX_CHARS = 15000
# Frozen episode-length contract (config.json "duration"): 5 minutes inclusive
# .. 20 minutes exclusive.
DURATION_MIN = 300.0
DURATION_MAX = 1200.0
MIN_BYTES = 10000
PEAK_MIN = 0.02
RMS_DBFS_MIN = -36.0
CLIPPED_MAX = 0.002
SILENT_MAX = 0.6
LONGEST_SILENCE_MAX = 5.0
EDGE_SILENCE_MAX = 2.5
QUIET_RMS = 0.004  # approximately -48 dBFS RMS, same window rule as the guide voices
CLIP_LEVEL = 0.999
WINDOW_SECONDS = 0.25
DURATION_TOLERANCE = 0.2
WINDOW = int(SAMPLE_RATE * WINDOW_SECONDS)


def default_tool(name):
    """Resolve an ffmpeg/ffprobe executable: FFPROBE/FFMPEG env, Homebrew, then PATH."""
    override = os.environ.get(name.upper())
    if override:
        return override
    preferred = "/opt/homebrew/bin/" + name
    if Path(preferred).is_file():
        return preferred
    return shutil.which(name) or name


def clean_text(raw):
    """Normalize a script: uniform newlines, single spaces, at most one blank line."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[^\S\n]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def duration_bounds_ok(metrics, chars, bounds, tolerance=0.0):
    """Check the characters-per-second rate against voices.json charsPerSecond bounds.

    Accepts inclusively and widens both bounds by ``tolerance`` (0.2 in the CLI:
    only fail when the pace is outside the configured bounds by more than 20%).
    """
    if not isinstance(bounds, (list, tuple)) or len(bounds) != 2:
        return False
    chars = max(len(chars) if isinstance(chars, str) else int(chars), 1)
    duration = float(metrics.get("durationSeconds", 0.0))
    if (not math.isfinite(duration) or duration <= 0) and metrics.get("seconds_per_char") is not None:
        duration = float(metrics["seconds_per_char"]) * chars
    if not math.isfinite(duration) or duration <= 0:
        return False
    slowest = float(bounds[0])
    fastest = float(bounds[1])
    if not 0 < slowest <= fastest:
        return False
    rate = chars / duration
    return slowest * (1.0 - tolerance) <= rate <= fastest * (1.0 + tolerance)


def metrics_failures(metrics):
    """Hard level/clipping/silence/finite gates; returns a list of human-readable problems."""
    problems = []
    values = {}
    for name in ("peak", "rms_dbfs", "clipped_fraction", "silent_fraction",
                 "leading_silence_seconds", "trailing_silence_seconds", "longest_silence_seconds"):
        values[name] = float(metrics.get(name, float("nan")))
    if not all(math.isfinite(value) for value in values.values()):
        problems.append("metrics are empty or non-finite: %s" % values)
        return problems
    if values["peak"] < PEAK_MIN:
        problems.append("peak %.4f < %.2f" % (values["peak"], PEAK_MIN))
    if values["rms_dbfs"] < RMS_DBFS_MIN:
        problems.append("rms %.2f dBFS < %.0f dBFS" % (values["rms_dbfs"], RMS_DBFS_MIN))
    if values["clipped_fraction"] > CLIPPED_MAX:
        problems.append("clipped %.4f > %.3f" % (values["clipped_fraction"], CLIPPED_MAX))
    if values["silent_fraction"] > SILENT_MAX:
        problems.append("silent %.3f > %.2f" % (values["silent_fraction"], SILENT_MAX))
    if values["longest_silence_seconds"] > LONGEST_SILENCE_MAX:
        problems.append("longest silence %.2fs > %.1fs" % (values["longest_silence_seconds"], LONGEST_SILENCE_MAX))
    if max(values["leading_silence_seconds"], values["trailing_silence_seconds"]) > EDGE_SILENCE_MAX:
        problems.append("edge silence %.2fs > %.1fs" % (
            max(values["leading_silence_seconds"], values["trailing_silence_seconds"]), EDGE_SILENCE_MAX))
    return problems


def metrics_ok(metrics):
    """True when the decoded-audio measurement passes every hard gate."""
    return not metrics_failures(metrics)


def build_ffmpeg_args(wav, out, filters, bitrate, ffmpeg="ffmpeg"):
    """ffmpeg command for the one-shot filter chain + libmp3lame encode."""
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
            "-af", filters, "-c:a", "libmp3lame", "-b:a", bitrate, str(out)]


def probe_mp3(path, ffprobe):
    """Read codec and duration from an encoded MP3 with ffprobe."""
    raw = subprocess.check_output([ffprobe, "-v", "error", "-show_entries",
                                   "format=duration:stream=codec_name", "-of", "json", str(path)])
    probe = json.loads(raw)
    streams = probe.get("streams") or []
    duration = float((probe.get("format") or {}).get("duration", 0.0))
    codec = next((stream.get("codec_name") for stream in streams if stream.get("codec_name") == "mp3"), None)
    return {"codec": codec, "duration": duration, "streams": streams}


def probe_issues(probe, size):
    """Container-level gates: MP3 codec, 10..600 s, more than ten kilobytes."""
    problems = []
    if probe.get("codec") != "mp3":
        problems.append("codec is not mp3 (%s)" % probe.get("codec"))
    duration = probe.get("duration")
    if duration is None or not math.isfinite(duration) or not DURATION_MIN <= duration <= DURATION_MAX:
        problems.append("duration %s s outside %.0f..%.0f s" % (duration, DURATION_MIN, DURATION_MAX))
    if size <= MIN_BYTES:
        problems.append("size %d bytes <= %d" % (size, MIN_BYTES))
    return problems


def audio_metrics(path, duration, chars, ffmpeg):
    """Decode to f32le mono 24 kHz and measure level, clipping and silence.

    Mirrors generate_guide_voices.audio_quality with stdlib arithmetic so the
    helper also runs on interpreters without numpy.
    """
    pcm = subprocess.check_output([ffmpeg, "-v", "error", "-i", str(path),
                                  "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "pipe:1"])
    wave = array.array("f")
    wave.frombytes(pcm[:len(pcm) - len(pcm) % 4])
    if sys.byteorder != "little":
        wave.byteswap()
    if not wave:
        raise ValueError("Decoded audio is empty")
    peak = 0.0
    clipped = 0
    total_squares = 0.0
    quiet = []
    for start in range(0, len(wave), WINDOW):
        chunk = wave[start:start + WINDOW]
        window_squares = 0.0
        for value in chunk:
            magnitude = value if value >= 0 else -value
            if magnitude > peak:
                peak = magnitude
            if magnitude >= CLIP_LEVEL:
                clipped += 1
            window_squares += value * value
        total_squares += window_squares
        quiet.append(math.sqrt(window_squares / len(chunk)) < QUIET_RMS)
    if not math.isfinite(total_squares) or not math.isfinite(peak):
        raise ValueError("Decoded audio is non-finite")
    leading = next((index for index, silent in enumerate(quiet) if not silent), len(quiet)) * WINDOW_SECONDS
    trailing = next((index for index, silent in enumerate(reversed(quiet)) if not silent), len(quiet)) * WINDOW_SECONDS
    longest = run = 0
    for silent in quiet:
        run = run + 1 if silent else 0
        longest = max(longest, run)
    rms = math.sqrt(total_squares / len(wave))
    chars = max(len(chars) if isinstance(chars, str) else int(chars), 1)
    return {
        "peak": round(peak, 5),
        "rms_dbfs": round(20 * math.log10(max(rms, 1e-10)), 2),
        "clipped_fraction": round(clipped / len(wave), 6),
        "silent_fraction": round(sum(quiet) / len(quiet), 3),
        "leading_silence_seconds": leading,
        "trailing_silence_seconds": trailing,
        "longest_silence_seconds": longest * WINDOW_SECONDS,
        "seconds_per_char": round(duration / chars, 3),
    }


def load_voices(path):
    """Read and minimally validate a voices.json configuration."""
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    languages = config.get("languages")
    if not isinstance(languages, dict) or not languages:
        raise ValueError("%s defines no languages" % path)
    for key, value in languages.items():
        if not isinstance(value, dict):
            raise ValueError("language %r is not an object" % key)
        missing = [field for field in ("label", "speaker", "language", "style", "filters", "charsPerSecond")
                   if field not in value]
        if missing:
            raise ValueError("language %r is missing %s" % (key, ", ".join(missing)))
        bounds = value["charsPerSecond"]
        if not isinstance(bounds, (list, tuple)) or len(bounds) != 2 or not 0 < float(bounds[0]) < float(bounds[1]):
            raise ValueError("language %r has invalid charsPerSecond %r" % (key, bounds))
    return config


def resolve_model(explicit, voices):
    """Explicit --model wins, then a restored LOCAL_TTS_MODELS_DIR bundle, then voices.json."""
    if explicit:
        return explicit
    bundle = os.environ.get("LOCAL_TTS_MODELS_DIR")
    if bundle:
        candidate = Path(bundle).expanduser() / "models/CustomVoice"
        if candidate.is_dir():
            return str(candidate)
    return voices["model"]


def model_commit(model_source):
    """Snapshot commit of the model: bundle manifest or single HF cache snapshot, else None."""
    path = Path(model_source).expanduser()
    manifest = path.parent.parent / "manifest.json"
    if path.is_dir() and manifest.is_file():
        try:
            commit = json.loads(manifest.read_text(encoding="utf-8"))["models"]["CustomVoice"].get("commit")
            if commit:
                return commit
        except (KeyError, ValueError, OSError):
            pass
    cache = Path.home() / ".cache/huggingface/hub" / ("models--" + str(model_source).replace("/", "--")) / "snapshots"
    if cache.is_dir():
        snapshots = sorted(entry.name for entry in cache.iterdir() if entry.is_dir())
        if len(snapshots) == 1:
            return snapshots[0]
    return None


def write_wav(path, wave, rate):
    """Write a float waveform with soundfile (imported here to keep module import light)."""
    import soundfile

    soundfile.write(path, wave, rate)


def generate_wave(text, speaker, language, instruct, model_source, max_tokens=MAX_TOKENS, verbose=False):
    """Load the model once and render the full script; all ML imports live here on purpose."""
    try:
        import numpy
        from mlx_audio.tts.utils import load_model
    except ImportError as error:
        raise RuntimeError("Local TTS runtime is unavailable (%s); run with .venv-tts/bin/python" % error)
    print("Loading model %s" % model_source, flush=True)
    model = load_model(model_source)
    rate = int(model.sample_rate)
    if verbose:
        print("Model ready: %d Hz, speakers %s" % (rate, ",".join(model.get_supported_speakers())), flush=True)
    print("Rendering %d characters (speaker=%s, language=%s, max_tokens=%d)" % (
        len(text), speaker, language, max_tokens), flush=True)
    results = list(model.generate_custom_voice(text=text, speaker=speaker, language=language,
                                               instruct=instruct, max_tokens=max_tokens))
    if not results:
        raise RuntimeError("Model returned no audio")
    wave = numpy.concatenate([numpy.asarray(result.audio).squeeze() for result in results])
    if wave.ndim != 1 or len(wave) < rate * 2 or not numpy.all(numpy.isfinite(wave)):
        raise RuntimeError("Generated waveform is invalid, non-finite or shorter than two seconds")
    if verbose:
        print("Generated %.2f s of audio at %d Hz" % (len(wave) / rate, rate), flush=True)
    return rate, wave


def run(args, voices, ffmpeg, ffprobe):
    """Validate inputs, render, encode, verify, then publish MP3 + metrics."""
    language = voices["languages"][args.language]
    if args.text_file is not None:
        raw = Path(args.text_file).read_text(encoding="utf-8")
    else:
        raw = args.text
    text = clean_text(raw)
    chars = len(text)
    if not MIN_CHARS <= chars <= MAX_CHARS:
        raise ValueError("Episode text must be %d..%d characters after cleanup, got %d" % (MIN_CHARS, MAX_CHARS, chars))
    model_source = resolve_model(args.model, voices)
    out = Path(args.out)
    metrics_path = Path(args.metrics)
    out.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    rate, wave = generate_wave(text, language["speaker"], language["language"], language["style"],
                               model_source, verbose=args.verbose)
    if rate != int(voices.get("sampleRate", SAMPLE_RATE)):
        print("note: model rate %d Hz differs from voices.json sampleRate %s" % (rate, voices.get("sampleRate")), flush=True)
    with tempfile.TemporaryDirectory(dir=str(out.parent), prefix=".synthesize-") as scratch:
        raw_wav = Path(scratch) / "voice.wav"
        staged_mp3 = Path(scratch) / "voice.mp3"
        write_wav(raw_wav, wave, rate)
        command = build_ffmpeg_args(raw_wav, staged_mp3, language["filters"], voices["bitrate"], ffmpeg)
        if args.verbose:
            print("Encoding: %s" % " ".join(command), flush=True)
        subprocess.run(command, check=True)
        probe = probe_mp3(staged_mp3, ffprobe)
        size = staged_mp3.stat().st_size
        problems = probe_issues(probe, size)
        if problems:
            raise RuntimeError("MP3 validation failed: %s" % "; ".join(problems))
        duration = probe["duration"]
        metrics = audio_metrics(staged_mp3, duration, chars, ffmpeg)
        problems = metrics_failures(metrics)
        if problems:
            raise RuntimeError("Audio quality gate failed: %s" % "; ".join(problems))
        if not duration_bounds_ok(metrics, chars, language["charsPerSecond"], tolerance=DURATION_TOLERANCE):
            raise RuntimeError("Pacing %.3f s/char outside %s chars/s bounds widened by %.0f%%" % (
                duration / chars, language["charsPerSecond"], DURATION_TOLERANCE * 100))
        if not duration_bounds_ok(metrics, chars, language["charsPerSecond"]):
            print("warning: pacing %.3f s/char outside expected %s chars/s bounds (inside hard gate)" % (
                duration / chars, language["charsPerSecond"]), flush=True)
        staged_mp3.replace(out)  # publish only after every gate passed
    record = {
        "provider": voices["provider"],
        "model": model_source,
        "model_commit": model_commit(model_source),
        "language": args.language,
        "voice": language["speaker"],
        "style_chars": len(language["style"]),
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
    print("Wrote %s (%.2f s, %d bytes, %d chars, speaker %s)" % (
        out, duration, size, chars, language["speaker"]), flush=True)
    print("Metrics: %s (rms %.2f dBFS, silent %.3f, s/char %.3f)" % (
        metrics_path, metrics["rms_dbfs"], metrics["silent_fraction"], metrics["seconds_per_char"]), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--text", help="Episode script as a string (alternative to --text-file)")
    parser.add_argument("--text-file", type=Path, help="UTF-8 file with the episode script")
    parser.add_argument("--language", required=True, help="Language key from voices.json, e.g. ja, en, zh, ko")
    parser.add_argument("--out", type=Path, required=True, help="Destination MP3 path")
    parser.add_argument("--metrics", type=Path, required=True, help="Destination metrics JSON path")
    parser.add_argument("--voices", type=Path, default=VOICES_PATH, help="Voice configuration JSON (default: %(default)s)")
    parser.add_argument("--model", help="Model id or local model directory (default: env LOCAL_TTS_MODELS_DIR/models/CustomVoice, else voices.json)")
    parser.add_argument("--ffmpeg", help="ffmpeg executable (default: env FFMPEG, then /opt/homebrew/bin/ffmpeg)")
    parser.add_argument("--ffprobe", help="ffprobe executable (default: env FFPROBE, then /opt/homebrew/bin/ffprobe)")
    parser.add_argument("--verbose", action="store_true", help="Print model, encoding and probe details")
    args = parser.parse_args(argv)
    if (args.text is None) == (args.text_file is None):
        parser.error("exactly one of --text or --text-file is required")
    args.ffmpeg = args.ffmpeg or default_tool("ffmpeg")
    args.ffprobe = args.ffprobe or default_tool("ffprobe")
    try:
        voices = load_voices(args.voices)
        if args.language not in voices["languages"]:
            raise ValueError("Unsupported language %r; %s defines: %s" % (
                args.language, args.voices, ", ".join(sorted(voices["languages"]))))
        run(args, voices, args.ffmpeg, args.ffprobe)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print("error: %s" % error, file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
