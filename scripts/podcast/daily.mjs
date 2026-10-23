// Daily podcast generation: topic selection -> arXiv fetch -> scripts -> TTS
// -> episode.json / history / status / log -> site build.
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchPapers } from "./arxiv.mjs";
import { buildScript, trimExcerpt } from "./script.mjs";
import {
  isValidISODate,
  loadHistory,
  pickFallback,
  pickTopic,
  planCatchupDates,
  readJson,
  saveHistory,
  writeJsonAtomic,
} from "./select.mjs";

const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const LOCK_STALE_MS = 30 * 60 * 1000;
const TTS_TIMEOUT_MS = 1800000;  // 30 min: 5-20 minute episodes can be slow on CPU-only engines
const DEFAULT_VOICES = { ja: "ono_anna", en: "aiden", zh: "serena", ko: "sohee" };
const DEFAULT_ENGINE_VOICES = {
  edge: { ja: "ja-JP-NanamiNeural", en: "en-US-AndrewNeural", zh: "zh-CN-XiaoxiaoNeural", ko: "ko-KR-SunHiNeural" },
  irodori: {},
  voicestudio: {},
};
// Adapter script + fallback venv per engine. qwen keeps the historical defaults so
// the original path (synthesize.py + .venv-tts) is byte-for-byte unchanged.
export const TTS_ENGINES = ["qwen", "edge", "irodori", "voicestudio"];
const TTS_SCRIPTS = { qwen: "synthesize.py", edge: "synthesize_edge.py", irodori: "synthesize_irodori.py", voicestudio: "synthesize_voicestudio.py" };
const ENGINE_VENV = { qwen: ".venv-tts", edge: ".venv-edge", irodori: null, voicestudio: null };
const TTS_FAILURE = {
  ja: (reason) => `音声合成に失敗しました（${reason}）`,
  en: (reason) => `Speech synthesis failed (${reason})`,
  zh: (reason) => `语音合成失败（${reason}）`,
  ko: (reason) => `음성 합성 실패 (${reason})`,
};

export function parseCliArgs(argv = []) {
  const args = { date: null, catchup: null, force: false, offline: false, noTts: false, noSite: false, verbose: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : null;
    if (name === "--date") {
      const value = inline ?? argv[index + 1];
      if (inline === null) index += 1;
      if (!isValidISODate(value)) throw new Error(`invalid --date: ${value}`);
      args.date = String(value);
    } else if (name === "--catchup") {
      let value = inline;
      if (value === null && argv[index + 1] !== undefined && /^\d+$/.test(String(argv[index + 1]))) value = String(argv[(index += 1)]);
      if (value !== null && !/^[1-9]\d*$/.test(value)) throw new Error(`invalid --catchup: ${value}`);
      args.catchup = value === null ? -1 : Number(value);
    } else if (name === "--force") {
      args.force = true;
    } else if (name === "--offline") {
      args.offline = true;
    } else if (name === "--no-tts") {
      args.noTts = true;
    } else if (name === "--no-site") {
      args.noSite = true;
    } else if (name === "--verbose") {
      args.verbose = true;
    } else if (name === "--help" || name === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return args;
}

const USAGE = `Usage: node scripts/podcast/daily.mjs [options]

  --date YYYY-MM-DD   target date (default: today, local time)
  --catchup [N]       also fill missing dates (N days max, default config.backfillDays)
  --force             regenerate even when an episode already exists
  --offline           skip arXiv and use the curated fallback catalog
  --no-tts            write scripts + episode.json without running TTS
  --no-site           do not run scripts/podcast/site.mjs afterwards
  --verbose           extra logging
`;

export function toISODate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ISO8601 with local offset, e.g. 2026-10-18T06:30:12+09:00
export function localIso(date = new Date()) {
  const pad = (n) => String(Math.abs(n)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${toISODate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

export function shouldSkip(dateISO, dir) {
  if (!isValidISODate(dateISO)) return false;
  // dir is normally the episodes root (<dir>/<date>/episode.json); a direct
  // episode directory is accepted too.
  return existsSync(join(dir, dateISO, "episode.json")) || existsSync(join(dir, "episode.json"));
}

// 0: audio produced or every date already existed; 3: an episode was written
// but no audio came out of this run.
export function exitCodeFor(totalDates, skippedDates, audioCount) {
  if (totalDates === 0 || skippedDates === totalDates) return 0;
  return audioCount > 0 ? 0 : 3;
}

export function voiceFor(voices, lang, fallback = DEFAULT_VOICES) {
  const defaults = fallback?.[lang] ?? "default";
  if (!voices || typeof voices !== "object") return defaults;
  const candidates = [voices?.[lang], voices?.languages?.[lang], voices?.voices?.[lang]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      for (const key of ["speaker", "voice", "name", "id"]) {
        if (typeof candidate[key] === "string" && candidate[key].trim()) return candidate[key].trim();
      }
    }
  }
  return defaults;
}

export function buildTtsEnv(env = process.env) {
  const result = { ...env };
  if (String(env.PODCAST_TTS_ONLINE ?? "") === "1") return result;
  result.HF_HUB_OFFLINE = "1";
  return result;
}

export function resolvePython(env = process.env) {
  if (env.PODCAST_PYTHON) return env.PODCAST_PYTHON;
  const venv = join(projectRoot, ".venv-tts", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

// Parse PODCAST_TTS_ENGINE (global default, "qwen" when unset) plus the optional
// PODCAST_TTS_MAP="ja:irodori,en:edge" per-language overrides. Invalid values
// throw so a typo in CI fails loudly instead of silently falling back to qwen.
export function parseTtsEnv(env = process.env) {
  const raw = String(env.PODCAST_TTS_ENGINE ?? "").trim().toLowerCase();
  const engine = raw === "" ? "qwen" : raw;
  if (!TTS_ENGINES.includes(engine)) {
    throw new Error(`invalid PODCAST_TTS_ENGINE "${env.PODCAST_TTS_ENGINE}" (expected: ${TTS_ENGINES.join(", ")})`);
  }
  const map = {};
  for (const pair of String(env.PODCAST_TTS_MAP ?? "").split(",")) {
    const token = pair.trim();
    if (!token) continue;
    const separator = token.indexOf(":");
    const lang = separator >= 0 ? token.slice(0, separator).trim().toLowerCase() : "";
    const langEngine = separator >= 0 ? token.slice(separator + 1).trim().toLowerCase() : "";
    if (!lang || !langEngine || !TTS_ENGINES.includes(langEngine)) {
      throw new Error(`invalid PODCAST_TTS_MAP entry "${token}" (expected lang:engine with engine in ${TTS_ENGINES.join(", ")})`);
    }
    map[lang] = langEngine;
  }
  return { engine, map };
}

export function engineForLang(tts, lang) {
  return tts?.map?.[lang] ?? tts?.engine ?? "qwen";
}

// Interpreter for one engine: PODCAST_PYTHON wins, then the engine venv, then
// python3. irodori is stdlib-only, so it runs on whichever interpreter exists.
export function resolveTtsPython(engine, env = process.env) {
  if (env.PODCAST_PYTHON) return env.PODCAST_PYTHON;
  const venvName = ENGINE_VENV[engine] ?? null;
  if (venvName) {
    const venv = join(projectRoot, venvName, "bin", "python");
    if (existsSync(venv)) return venv;
  }
  return "python3";
}

// Voice (or irodori caption) recorded in episode.json for one engine+language.
export function engineVoiceFor(voices, engine, lang) {
  if (engine === "edge") {
    const value = voices?.edge?.languages?.[lang]?.voice ?? voices?.engines?.edge?.languages?.[lang]?.voice;
    return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ENGINE_VOICES.edge[lang] ?? "none";
  }
  if (engine === "irodori") {
    const value = voices?.irodori?.languages?.[lang]?.caption ?? voices?.engines?.irodori?.languages?.[lang]?.caption;
    return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ENGINE_VOICES.irodori[lang] ?? "none";
  }
  if (engine === "voicestudio") {
    const value = voices?.voicestudio?.languages?.[lang]?.voice ?? voices?.engines?.voicestudio?.languages?.[lang]?.voice;
    return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ENGINE_VOICES.voicestudio[lang] ?? "none";
  }
  return voiceFor(voices, lang);
}

function short(value, length = 90) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, length);
}

function ttsError(lang, reason) {
  const template = TTS_FAILURE[lang] ?? TTS_FAILURE.en;
  return template(short(reason, 60) || "unknown");
}

// Verify a synthesized file against synthesize.py metrics (and by hashing it).
export async function verifyAudio(outPath, metricsPath) {
  let buffer;
  try {
    buffer = await readFile(outPath);
  } catch {
    return { ok: false, reason: "no audio file" };
  }
  const bytes = buffer.length;
  if (bytes <= 0) return { ok: false, reason: "empty audio file" };
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const metrics = await readJson(metricsPath, null);
  if (!metrics || typeof metrics !== "object") {
    return { ok: true, bytes, sha256, durationSeconds: null, note: "metrics json missing" };
  }
  const expectedBytes = Number(metrics.bytes);
  if (Number.isFinite(expectedBytes) && expectedBytes !== bytes) {
    return { ok: false, reason: `bytes mismatch (${bytes} != ${expectedBytes})` };
  }
  const expectedSha = typeof metrics.sha256 === "string" ? metrics.sha256.trim().toLowerCase() : "";
  if (expectedSha && expectedSha !== sha256) return { ok: false, reason: "sha256 mismatch" };
  const duration = Number(metrics.durationSeconds);
  return {
    ok: true,
    bytes,
    sha256,
    durationSeconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
    note: null,
  };
}

// Spawn the engine adapter for one language. Never throws: returns an outcome
// object so the caller can record failures and continue with other languages.
export async function runTts(lang, options = {}) {
  const {
    episodeDir,
    env = process.env,
    engine = "qwen",
    pythonPath,
    timeoutMs = TTS_TIMEOUT_MS,
    voice = voiceFor(null, lang),
    spawnImpl = spawn,
  } = options;
  const python = pythonPath || resolveTtsPython(engine, env);
  const scriptName = TTS_SCRIPTS[engine] ?? TTS_SCRIPTS.qwen;
  const scriptPath = join(episodeDir, `script-${lang}.txt`);
  const outPath = join(episodeDir, `${lang}.mp3`);
  const metricsPath = join(episodeDir, `${lang}.metrics.json`);
  const failure = (reason) => ({ status: "failed", error: ttsError(lang, reason), durationSeconds: null, bytes: null, sha256: null, voice });
  await rm(outPath, { force: true });
  await rm(metricsPath, { force: true });

  const outcome = await new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(python, [
        join(moduleDir, scriptName),
        "--text-file", scriptPath,
        "--language", lang,
        "--out", outPath,
        "--metrics", metricsPath,
      ], { cwd: projectRoot, env: buildTtsEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ kind: "spawn", detail: error?.message ?? "spawn failed" });
      return;
    }
    if (!child || typeof child.on !== "function") {
      resolve({ kind: "spawn", detail: "spawn returned no process" });
      return;
    }
    let settled = false;
    let timedOut = false;
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // the process may already be gone
      }
    }, timeoutMs);
    child.on("error", (error) => finish({ kind: "spawn", detail: error?.message ?? "process error" }));
    child.on("close", (code, signal) => {
      if (timedOut) return finish({ kind: "timeout", detail: "timeout" });
      if (code === 0) return finish({ kind: "done" });
      return finish({ kind: "exit", detail: `exit ${code ?? signal ?? "unknown"}${stderr ? `: ${stderr}` : ""}` });
    });
  });

  if (outcome.kind === "timeout") return failure("timeout");
  if (outcome.kind === "spawn") return failure(`launch: ${outcome.detail}`);
  if (outcome.kind === "exit") return failure(outcome.detail);
  const verified = await verifyAudio(outPath, metricsPath);
  if (!verified.ok) return failure(verified.reason);
  return { status: "ok", durationSeconds: verified.durationSeconds, bytes: verified.bytes, sha256: verified.sha256, voice, note: verified.note ?? null };
}

// ---- config / inputs ---------------------------------------------------------

async function loadJsonOrThrow(path, label) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label} (${path}): ${short(error?.message ?? error)}`);
  }
  return raw;
}

export async function loadConfig() {
  const config = await loadJsonOrThrow(join(moduleDir, "config.json"), "config.json");
  if (!config || typeof config !== "object") throw new Error("config.json must be an object");
  if (!Array.isArray(config.languages) || config.languages.length === 0) throw new Error("config.languages must be a non-empty array");
  return {
    ...config,
    languages: config.languages.map((lang) => String(lang)),
    languageLabels: config.languageLabels && typeof config.languageLabels === "object" ? config.languageLabels : {},
    maxPapers: Math.max(1, Math.floor(Number(config.maxPapers)) || 3),
    maxExcerptChars: config.maxExcerptChars && typeof config.maxExcerptChars === "object" ? config.maxExcerptChars : {},
    backfillDays: Math.max(1, Math.floor(Number(config.backfillDays)) || 3),
    duration: {
      minSeconds: Math.floor(Number(config.duration?.minSeconds)) || 300,
      maxSeconds: Math.floor(Number(config.duration?.maxSeconds)) || 1200,
      targetSeconds: Math.floor(Number(config.duration?.targetSeconds)) || 660,
    },
    episodeDir: typeof config.episodeDir === "string" && config.episodeDir ? config.episodeDir : "podcast/episodes",
    stateDir: typeof config.stateDir === "string" && config.stateDir ? config.stateDir : "podcast/state",
  };
}

export async function loadTopics() {
  const topics = await loadJsonOrThrow(join(moduleDir, "topics.json"), "topics.json");
  const valid = (Array.isArray(topics) ? topics : []).filter((topic) =>
    topic && typeof topic.id === "string" && topic.id &&
    typeof topic.keyword === "string" && topic.keyword.trim() &&
    topic.labels && typeof topic.labels === "object");
  if (valid.length === 0) throw new Error("topics.json contains no usable topics");
  return valid;
}

export async function loadFallback() {
  const entries = await readJson(join(moduleDir, "fallback.json"), []);
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry.arxivId === "string" && entry.arxivId && typeof entry.title === "string" && entry.title);
}

// ---- lock --------------------------------------------------------------------

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireLock(lockPath, log = () => {}) {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
      return lockPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readJson(lockPath, null);
      const startedAt = Date.parse(existing?.startedAt ?? "");
      const age = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity;
      if (isPidAlive(existing?.pid) && age < LOCK_STALE_MS) return null;
      log(`removing stale lock (pid ${existing?.pid ?? "?"})`);
      await rm(lockPath, { force: true });
    }
  }
  return null;
}

export async function releaseLock(lockPath) {
  const existing = await readJson(lockPath, null);
  if (existing?.pid === process.pid) await rm(lockPath, { force: true });
}

// ---- per-date generation ------------------------------------------------------

function curatedToPaper(entry) {
  return {
    arxivId: entry.arxivId,
    title: entry.title,
    authors: Array.isArray(entry.authors) ? entry.authors : [],
    primaryCategory: entry.primaryCategory ?? "",
    published: entry.published ?? (entry.year ? `${entry.year}-01-01` : ""),
    url: entry.url ?? `https://arxiv.org/abs/${entry.arxivId}`,
    pdfUrl: entry.pdfUrl ?? `https://arxiv.org/pdf/${entry.arxivId}`,
    abstract: entry.excerpt ?? "",
  };
}

function toEpisodePaper(paper, config, source) {
  const abstract = paper.abstract ?? paper.excerpt ?? "";
  const limit = source === "curated" ? Number(config.maxExcerptChars?.ja) || 220 : Number(config.maxExcerptChars?.en) || 300;
  return {
    arxivId: paper.arxivId ?? "",
    title: paper.title ?? "",
    authors: Array.isArray(paper.authors) ? paper.authors : [],
    primaryCategory: paper.primaryCategory ?? "",
    published: paper.published ?? "",
    url: paper.url ?? (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : ""),
    pdfUrl: paper.pdfUrl ?? (paper.arxivId ? `https://arxiv.org/pdf/${paper.arxivId}` : ""),
    excerpt: trimExcerpt(abstract, limit),
  };
}

function topicLabels(topic, languages) {
  const labels = {};
  for (const lang of languages) {
    const value = topic.labels?.[lang];
    labels[lang] = typeof value === "string" && value.trim() ? value.trim() : topic.id;
  }
  return labels;
}

async function generateEpisode(date, context) {
  const { config, topics, fallback, history, args, env, episodeRoot, log, verbose, tts = parseTtsEnv(env) } = context;
  const topic = pickTopic(date, topics, history);
  const notes = [];
  let papers = [];
  let source = "curated";
  if (!args.offline) {
    // Pool wider than maxPapers on purpose: buildScript may need to grow the
    // episode (up to maxPapers) instead of only shrinking it.
    const fetched = await fetchPapers(topic.keyword, { max: Math.max(config.maxPapers + 2, 10) });
    if (fetched.length > 0) {
      source = "arxiv";
      papers = fetched.slice(0, config.maxPapers);
    }
  }
  if (papers.length === 0) {
    const entry = pickFallback(date, fallback);
    if (!entry) throw new Error("no arXiv papers and no curated fallback entry available");
    papers = [curatedToPaper(entry)];
    notes.push(args.offline
      ? "offline mode: curated catalog entry used (not fetched from arXiv)"
      : "arXiv returned no usable papers: curated catalog entry used");
    notes.push("curated excerpt is our edited Japanese summary of the paper, not the original abstract");
  } else {
    notes.push(`papers fetched from the arXiv export API for keyword "${topic.keyword}"`);
  }
  log.info(`topic=${topic.id} source=${source} papers=${papers.length}`);

  const episodeDir = join(episodeRoot, date);
  await mkdir(episodeDir, { recursive: true });
  const voices = await readJson(join(moduleDir, "voices.json"), null);
  const languages = {};
  const trimmedLanguages = [];
  for (const lang of config.languages) {
    const label = typeof config.languageLabels?.[lang] === "string" ? config.languageLabels[lang] : lang;
    const engine = engineForLang(tts, lang);
    const voice = engineVoiceFor(voices, engine, lang);
    const script = buildScript(lang, {
      date,
      topic,
      papers,
      languageLabels: config.languageLabels,
      source,
      maxPapers: config.maxPapers,
      maxExcerptChars: config.maxExcerptChars?.[lang],
    });
    if (script.papersUsed < papers.length) trimmedLanguages.push(lang);
    verbose && log.detail(`  ${lang}: ~${script.estimatedSeconds}s, papers=${script.papersUsed}, excerptLimit=${script.excerptLimit}`);
    const scriptName = `script-${lang}.txt`;
    await writeFile(join(episodeDir, scriptName), script.text.endsWith("\n") ? script.text : `${script.text}\n`, "utf8");
    if (args.noTts) {
      languages[lang] = { label, status: "failed", text: scriptName, audio: null, durationSeconds: null, bytes: null, sha256: null, voice, error: "skipped (--no-tts)" };
      continue;
    }
    verbose && log.detail(`  ${lang}: synthesizing (${engine}: ${voice})`);
    const result = await runTts(lang, { episodeDir, env, voice, engine });
    languages[lang] = {
      label,
      status: result.status,
      text: scriptName,
      audio: result.status === "ok" ? `${lang}.mp3` : null,
      durationSeconds: result.durationSeconds,
      bytes: result.bytes,
      sha256: result.sha256,
      voice: result.voice ?? voice,
      error: result.error ?? null,
    };
    if (result.status !== "ok") notes.push(`${lang}: audio failed (${result.error})`);
    else {
      if (result.note) notes.push(`${lang}: ${result.note}`);
      // Episode-level duration gate (mirrors the adapter gate in
      // synthesize*.py): record when a published track is outside [min, max).
      const { minSeconds, maxSeconds } = config.duration;
      const seconds = result.durationSeconds;
      if (Number.isFinite(seconds)) {
        if (seconds < minSeconds) notes.push(`${lang}: audio ${Math.round(seconds)}s is below config.duration.minSeconds (${minSeconds}s)`);
        else if (seconds >= maxSeconds) notes.push(`${lang}: audio ${Math.round(seconds)}s is at/above config.duration.maxSeconds (${maxSeconds}s)`);
      }
    }
  }
  if (trimmedLanguages.length > 0) {
    notes.push(`audio brief plan adjusted (papers/excerpts) to stay inside the 5-20 minute episode target for: ${trimmedLanguages.join(", ")} (full paper links and abstracts remain in this episode data)`);
  }
  const enginesUsed = [...new Set(config.languages.map((lang) => engineForLang(tts, lang)))];
  if (enginesUsed.some((engine) => engine !== "qwen")) {
    notes.push(`TTS engines: ${config.languages.map((lang) => `${lang}=${engineForLang(tts, lang)}`).join(", ")}`);
  }
  if (args.noTts) notes.push("audio generation skipped (--no-tts); statuses are recorded as failed on purpose");

  const episode = {
    version: 1,
    date,
    topic: { id: topic.id, labels: topicLabels(topic, config.languages) },
    source,
    generatedAt: localIso(new Date()),
    papers: papers.map((paper) => toEpisodePaper(paper, config, source)),
    languages,
    notes,
  };
  await writeJsonAtomic(join(episodeDir, "episode.json"), episode);
  const audioLanguages = config.languages.filter((lang) => languages[lang]?.status === "ok");
  return { ok: true, audioLanguages, topicId: topic.id, source, paperCount: papers.length, languages };
}

// ---- logging / status ----------------------------------------------------------

function makeLogger(verbose) {
  return {
    info: (message) => console.log(message),
    detail: (message) => {
      if (verbose) console.log(message);
    },
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  };
}

async function appendLog(logPath, line) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${line}\n`, "utf8");
}

function logLine(date, outcome, config) {
  const audio = config.languages.filter((lang) => outcome.languages?.[lang]?.status === "ok").join(",") || "-";
  return `${localIso(new Date())} ${date} topic=${outcome.topicId} source=${outcome.source} papers=${outcome.paperCount} audio=${audio}`;
}

function okLanguages(episode) {
  const languages = episode?.languages;
  if (!languages || typeof languages !== "object") return [];
  return Object.keys(languages).filter((lang) => languages[lang]?.status === "ok");
}

function latestHistoryDate(history) {
  let latest = null;
  for (const entry of Array.isArray(history) ? history : []) {
    if (isValidISODate(entry?.date) && (latest === null || entry.date > latest)) latest = entry.date;
  }
  return latest;
}

// ---- main ----------------------------------------------------------------------

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    console.error(short(error?.message ?? error));
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const verbose = args.verbose || String(env.PODCAST_VERBOSE ?? "") === "1";
  const log = makeLogger(verbose);
  try {
    const config = await loadConfig();
    const tts = parseTtsEnv(env);  // fail loudly on a bad engine configuration
    const topics = await loadTopics();
    const fallback = await loadFallback();
    const episodeRoot = join(projectRoot, config.episodeDir);
    const stateDir = join(projectRoot, config.stateDir);
    const logPath = join(projectRoot, "podcast", "logs", "daily.log");
    const historyPath = join(stateDir, "history.json");
    const statusPath = join(stateDir, "status.json");
    const lockPath = join(stateDir, "daily.lock");
    const todayISO = args.date || toISODate(new Date());

    const lock = await acquireLock(lockPath, (message) => log.warn(message));
    if (!lock) {
      log.error(`another run is in progress (lock: ${lockPath}); exiting`);
      return 2;
    }
    try {
      const history = await loadHistory(historyPath);
      let dates;
      if (args.catchup !== null) {
        const maxDays = args.catchup > 0 ? args.catchup : config.backfillDays;
        dates = planCatchupDates(todayISO, latestHistoryDate(history), maxDays);
        log.detail(`catch-up plan: ${dates.join(", ") || "(nothing missing)"}`);
      } else {
        dates = [todayISO];
      }

      const results = [];
      let audioCount = 0;
      let skippedCount = 0;
      for (const date of dates) {
        if (!args.force && shouldSkip(date, episodeRoot)) {
          const existing = await readJson(join(episodeRoot, date, "episode.json"), null);
          const audioLanguages = okLanguages(existing);
          log.info(`already generated: ${date}`);
          await appendLog(logPath, `${localIso(new Date())} ${date} skipped (episode.json exists)`);
          results.push({ date, ok: true, audioLanguages });
          skippedCount += 1;
          continue;
        }
        let outcome;
        try {
          outcome = await generateEpisode(date, { config, topics, fallback, history, args, env, episodeRoot, log, verbose, tts });
        } catch (error) {
          log.error(`failed: ${date}: ${short(error?.message ?? error, 200)}`);
          await appendLog(logPath, `${localIso(new Date())} ${date} error: ${short(error?.message ?? error, 300)}`);
          results.push({ date, ok: false, audioLanguages: [] });
          continue;
        }
        log.info(`generated: ${date} topic=${outcome.topicId} source=${outcome.source} audio=${outcome.audioLanguages.join(",") || "none"}`);
        audioCount += outcome.audioLanguages.length;
        results.push({ date, ok: true, audioLanguages: outcome.audioLanguages });
        // one history entry per date (a --force rerun replaces its old entry)
        const kept = history.filter((entry) => entry.date !== date);
        kept.push({ date, topicId: outcome.topicId });
        kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        history.length = 0;
        history.push(...kept);
        await saveHistory(historyPath, history);
        await appendLog(logPath, logLine(date, outcome, config));
      }

      let siteBuiltAt = (await readJson(statusPath, null))?.siteBuiltAt ?? null;
      if (!args.noSite) {
        const siteScript = join(moduleDir, "site.mjs");
        if (!existsSync(siteScript)) {
          log.warn(`site builder not found, skipping: ${siteScript}`);
        } else {
          const site = spawnSync(process.execPath, [siteScript], { cwd: projectRoot, env: { ...env }, encoding: "utf8", timeout: 600000 });
          if (site.status === 0) {
            siteBuiltAt = localIso(new Date());
          } else {
            log.warn(`site build failed (exit ${site.status ?? site.signal}): ${short(site.stderr, 200)}`);
          }
        }
      }
      await writeJsonAtomic(statusPath, { lastRunAt: localIso(new Date()), results, siteBuiltAt });

      return exitCodeFor(results.length, skippedCount, audioCount);
    } finally {
      await releaseLock(lockPath);
    }
  } catch (error) {
    console.error(`daily.mjs: ${short(error?.stack ?? error, 400)}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`daily.mjs: ${short(error?.stack ?? error, 400)}`);
    process.exitCode = 1;
  });
}
