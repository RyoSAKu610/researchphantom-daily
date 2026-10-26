// Optional local-LLM narration for the per-paper part of each script.
//
// Off unless PODCAST_SCRIPT_LLM=1. Then daily.mjs starts a llama.cpp
// `llama-server` (CPU, open-weights GGUF model, loopback only), asks it for a
// short spoken explanation of each paper IN THE TARGET LANGUAGE, grounded only
// in the paper's title + abstract, validates every answer and stops the server
// before TTS starts. Anything wrong (binary/model missing, server start or
// request failure, timeout, budget exhausted, validation failure, script too
// short) falls back to the deterministic template script from script.mjs for
// that language — the template path is never removed.
//
// Validation per paper narration: target language (script + stop words),
// length window, no URLs/markdown, no looping repetition, every number must
// occur in the title/abstract, and Latin-script names/acronyms the model uses
// must occur in the title/abstract (no invented models/datasets).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { buildScriptFromBodies, cleanAbstract } from "./script.mjs";

const LANGUAGE_NAMES = { ja: "Japanese", zh: "Simplified Chinese", de: "German", es: "Spanish", ru: "Russian", it: "Italian" };

// Measured seconds per character of the self-hosted voices on real episodes
// (2026-10-21/22 Fish runs: ja 0.113-0.118 with English quotes inside, Latin
// scripts 0.066-0.074). Native-language narration is slower per character for
// CJK, so ja/zh use conservative speech rates. Used only to size LLM
// narrations and to gate them against the 5-minute minimum.
export const LLM_PACE = { ja: 0.13, zh: 0.17, de: 0.068, es: 0.063, ru: 0.07, it: 0.064 };
// Average characters per word, for "about N words" prompts (non-CJK).
const CHARS_PER_WORD = { de: 7, es: 6, ru: 7, it: 6 };
// Rough tokens per character for the max_tokens cap.
const TOKENS_PER_CHAR = { ja: 1.0, zh: 0.9, de: 0.32, es: 0.3, ru: 0.38, it: 0.32 };

export function llmSettings(env = process.env) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const opt = join(homedir(), "opt");
  return {
    enabled: String(env.PODCAST_SCRIPT_LLM ?? "") === "1",
    serverBin: env.PODCAST_LLM_SERVER || join(opt, "llama.cpp", "current", "llama-server"),
    model: env.PODCAST_LLM_MODEL || join(opt, "llm-models", "current.gguf"),
    url: env.PODCAST_LLM_URL || "",          // use an already running OpenAI-compatible server instead
    port: Math.floor(num(env.PODCAST_LLM_PORT, 3911)),
    threads: Math.floor(num(env.PODCAST_LLM_THREADS, 8)),
    ctx: Math.floor(num(env.PODCAST_LLM_CTX, 8192)),
    maxPapers: Math.floor(num(env.PODCAST_LLM_MAX_PAPERS, 5)),
    targetSeconds: num(env.PODCAST_LLM_TARGET_SECONDS, 450),
    minSeconds: num(env.PODCAST_LLM_MIN_SECONDS, 330),
    startTimeoutMs: num(env.PODCAST_LLM_START_TIMEOUT_SEC, 240) * 1000,
    requestTimeoutMs: num(env.PODCAST_LLM_REQUEST_TIMEOUT_SEC, 360) * 1000,
    langTimeoutMs: num(env.PODCAST_LLM_LANG_TIMEOUT_SEC, 900) * 1000,
    budgetMs: num(env.PODCAST_LLM_BUDGET_SEC, 4500) * 1000,
    retries: Math.floor(num(env.PODCAST_LLM_RETRIES, 1)),
    // finished LLM scripts are kept here so a --force rerun / self-repair of
    // the same date+topic+papers reuses them instead of regenerating
    scriptCacheDir: env.PODCAST_LLM_SCRIPT_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "researchphantom-daily", "llm-scripts"),
  };
}

export function llmModelName(settings) {
  if (settings.url) return `server:${settings.url}`;
  let path = settings.model;
  try {
    path = realpathSync(settings.model);  // current.gguf is usually a symlink
  } catch {
    // keep the configured name
  }
  return basename(path).replace(/\.gguf$/i, "");
}

// Why the LLM path cannot run (null when it can be tried).
export function llmUnavailableReason(settings) {
  if (!settings.enabled) return "disabled (PODCAST_SCRIPT_LLM!=1)";
  if (settings.url) return null;
  if (!existsSync(settings.serverBin)) return `llama-server not found: ${settings.serverBin}`;
  if (!existsSync(settings.model)) return `model not found: ${settings.model}`;
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- server lifecycle ---------------------------------------------------------

export class LlmServer {
  constructor(settings, log = () => {}) {
    this.settings = settings;
    this.log = log;
    this.child = null;
    this.base = settings.url ? settings.url.replace(/\/+$/, "") : `http://127.0.0.1:${settings.port}`;
  }

  async start() {
    if (this.settings.url) return this.waitHealthy(15000);
    const s = this.settings;
    const args = [
      "-m", s.model, "-c", String(s.ctx), "-t", String(s.threads), "-np", "1",
      "--host", "127.0.0.1", "--port", String(s.port),
      "--jinja", "--reasoning-budget", "0", "-cram", "0", "--no-webui", "--log-disable",
    ];
    this.child = spawn(s.serverBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    this.child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    this.child.on("error", () => {});
    this.exited = new Promise((resolve) => this.child.once("exit", resolve));
    const ok = await this.waitHealthy(s.startTimeoutMs);
    if (!ok) {
      await this.stop();
      throw new Error(`llama-server did not become healthy: ${stderr.replace(/\s+/g, " ").slice(-200)}`);
    }
    return true;
  }

  async waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) return false;
      try {
        const response = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) return true;
      } catch {
        // not up yet
      }
      await sleep(1000);
    }
    return false;
  }

  async chat(messages, { maxTokens, timeoutMs }) {
    const response = await fetch(`${this.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.05,
        presence_penalty: 0.3,
        chat_template_kwargs: { enable_thinking: false },
        cache_prompt: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`llm http ${response.status}`);
    const data = await response.json();
    const choice = data?.choices?.[0];
    return {
      text: String(choice?.message?.content ?? ""),
      finish: choice?.finish_reason ?? "",
      tokens: Number(data?.usage?.completion_tokens) || 0,
    };
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    const killed = await Promise.race([this.exited, sleep(10000).then(() => false)]);
    if (killed === false) this.child.kill("SIGKILL");
  }
}

// ---- prompts --------------------------------------------------------------------

function lengthInstruction(lang, chars) {
  if (lang === "ja") return `about ${chars} Japanese characters`;
  if (lang === "zh") return `about ${chars} Chinese characters`;
  return `about ${Math.round(chars / (CHARS_PER_WORD[lang] || 6))} words`;
}

export function buildMessages(lang, paper, targetChars, strict = false) {
  const name = LANGUAGE_NAMES[lang];
  const system = [
    `You are the narrator of a daily research podcast. You write spoken narration in ${name} only.`,
    "Strict rules:",
    "- Use only information stated in the given title and abstract. Do not add facts, results, names, datasets, models, comparisons or opinions that are not in the abstract.",
    "- Never write a number unless that exact number appears in the abstract or title. If the abstract gives no number, give none.",
    "- Keep English technical names exactly as written in the abstract; do not invent new ones.",
    "- Do not praise or rate the work (no \"impressive\", \"remarkable\", \"better than previous approaches\" unless the abstract says so).",
    "- Plain flowing prose for reading aloud: no markdown, no lists, no headings, no URLs, no greetings, no sign-off.",
  ].join("\n");
  const authors = Array.isArray(paper.authors) ? paper.authors.slice(0, 6).join(", ") : "";
  const user = [
    `Title: ${paper.title}`,
    authors ? `Authors: ${authors}` : "",
    `Abstract: ${cleanAbstract(paper.abstract ?? paper.excerpt ?? "")}`,
    "",
    `Write a spoken explanation of this paper in ${name}, ${lengthInstruction(lang, targetChars)}.`,
    "Cover: the problem the paper addresses, what the authors propose or do, and what they report, all only as stated in the abstract. Explain technical terms simply for a general listener.",
    "Do not start by repeating the title and do not mention the authors; they are introduced separately.",
    strict ? "Your previous answer broke a rule (language, length, numbers or names not in the abstract). Follow every rule exactly this time." : "",
    `Output only the ${name} narration.`,
  ].filter((line) => line !== "").join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

// ---- validation -----------------------------------------------------------------

const STOP_WORDS = {
  de: ["der", "die", "das", "und", "ist", "nicht", "mit", "für", "auf", "ein", "eine", "einen", "dem", "den", "des", "zu", "sich", "von", "wird", "werden", "auch", "wie"],
  es: ["el", "los", "las", "y", "es", "que", "en", "del", "una", "un", "por", "para", "con", "se", "como", "más", "su", "al", "este", "esta"],
  it: ["il", "gli", "della", "che", "di", "è", "per", "non", "sono", "nel", "degli", "delle", "un", "una", "questo", "questa", "come", "più", "dei"],
  en: ["the", "and", "of", "to", "is", "that", "with", "for", "this", "are", "we", "on", "by", "which"],
};
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
// generic terms a narration may use even when the abstract does not
const ALLOWED_LATIN = new Set(["ai", "arxiv", "ki", "ia", "dna", "rna", "adn", "arn", "gpu", "cpu"]);

export function cleanNarration(raw) {
  let text = String(raw ?? "");
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  text = text.normalize("NFKC");
  text = text.replace(/^\s*#+\s*/gm, "").replace(/^\s*[-*•]\s+/gm, "");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*\n]+)\*/g, "$1").replace(/`([^`]*)`/g, "$1");
  text = text.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  return text;
}

// Cut at the last sentence end (finish_reason=length leaves a dangling tail).
function cutToSentence(text) {
  const match = /^[\s\S]*[。！？.!?](?=\s|$|[」』"»])/.exec(text);
  return match ? match[0].trim() : text;
}

function counts(text) {
  return {
    kana: (text.match(/[\u3040-\u30ff]/g) || []).length,
    han: (text.match(/[\u4e00-\u9fff]/g) || []).length,
    hangul: (text.match(/[\uac00-\ud7af]/g) || []).length,
    cyr: (text.match(/[\u0400-\u04ff]/g) || []).length,
    latin: (text.match(/[A-Za-zÀ-ÿ]/g) || []).length,
  };
}

function stopScore(words, lang) {
  const set = new Set(STOP_WORDS[lang]);
  return words.filter((word) => set.has(word)).length / Math.max(1, words.length);
}

export function languageOk(lang, text) {
  const c = counts(text);
  const letters = c.kana + c.han + c.hangul + c.cyr + c.latin || 1;
  if (lang === "ja") return c.kana / letters >= 0.2 && (c.kana + c.han) / letters >= 0.6;
  if (lang === "zh") return c.han / letters >= 0.6 && c.kana / letters < 0.01 && c.hangul === 0;
  if (lang === "ru") return c.cyr / letters >= 0.6;
  if ((c.latin / letters) < 0.85) return false;
  const words = text.toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean);
  const own = stopScore(words, lang);
  const others = ["de", "es", "it", "en"].filter((other) => other !== lang).map((other) => stopScore(words, other));
  return own >= 0.08 && others.every((score) => own > score);
}

function sourceText(paper) {
  return `${paper.title ?? ""} ${(paper.authors || []).join(" ")} ${paper.abstract ?? paper.excerpt ?? ""}`.normalize("NFKC");
}

function numberToken(value) {
  return value.replace(/(\d),(\d{3})\b/g, "$1$2").replace(/(\d),(\d)/g, "$1.$2");
}

const SCALE_WORDS = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, b: 1e9, trillion: 1e12 };
const CJK_SCALE = { 千: 1e3, 万: 1e4, 萬: 1e4, 億: 1e8, 亿: 1e8, 兆: 1e12 };
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

// Numeric values stated in the source: plain numbers plus "231 million" style
// expansions (so a Japanese "2億3100万" can be matched against it).
function sourceValues(source) {
  const values = [];
  for (const match of source.matchAll(/(\d+(?:[.,]\d+)*)(?:\s*(thousand|million|billion|trillion|k|m|b)\b)?/gi)) {
    const base = Number(numberToken(match[1]));
    if (!Number.isFinite(base)) continue;
    values.push(base);
    const scale = match[2] ? SCALE_WORDS[match[2].toLowerCase()] : null;
    if (scale) values.push(base * scale);
  }
  return values;
}

// Numbers in the narration that do not occur in the source. CJK compounds
// such as 2億3100万 / 23.1亿 are evaluated as one value first.
export function ungroundedNumbers(text, paper) {
  const source = sourceText(paper);
  const values = sourceValues(source);
  const sourceLower = source.toLowerCase();
  const grounded = (value) => values.some((v) => near(v, value));
  const bad = [];
  let rest = text;
  rest = rest.replace(/(?:\d+(?:[.,]\d+)*\s?[千万萬億亿兆]\s?)+(?:\d+(?:[.,]\d+)*)?/g, (raw) => {
    const compound = numberToken(raw.replace(/\s/g, ""));
    let total = 0;
    for (const part of compound.matchAll(/(\d+(?:\.\d+)?)([千万萬億亿兆]?)/g)) {
      total += Number(part[1]) * (part[2] ? CJK_SCALE[part[2]] : 1);
    }
    const plain = Number((compound.match(/^\d+(?:\.\d+)?/) || ["NaN"])[0]);
    if (!grounded(total) && !grounded(plain)) bad.push(raw);
    return " ";
  });
  for (const raw of rest.match(/\d+(?:[.,]\d+)*/g) || []) {
    const value = Number(numberToken(raw));
    if (grounded(value)) continue;
    if (Number.isInteger(value) && value >= 0 && value <= 10 && new RegExp(`\\b${NUMBER_WORDS[value]}\\b`).test(sourceLower)) continue;
    bad.push(raw);
  }
  return bad;
}

// Latin-script names/acronyms not present in the source. For ja/zh/ru every
// Latin word counts; for de/es/it only acronym-like tokens (>= 2 capitals or
// letter+digit mixes) are checked, ordinary words are the language itself.
export function ungroundedNames(lang, text, paper) {
  const source = sourceText(paper).toLowerCase();
  const tokens = text.match(/[A-Za-z][A-Za-z0-9+\-]*[A-Za-z0-9+]|[A-Za-z]/g) || [];
  const latinScript = !["ja", "zh", "ru"].includes(lang);
  const bad = [];
  for (const token of tokens) {
    // hyphenated compounds ("RNA-Ausdruckswerte"): judge each part
    const parts = token.split("-").filter((part) => part.length >= 2);
    const suspicious = parts.filter((part) => {
      const lower = part.toLowerCase();
      if (ALLOWED_LATIN.has(lower)) return false;
      if (latinScript) {
        const caps = (part.match(/[A-Z]/g) || []).length;
        if (!(caps >= 2 || /\d/.test(part))) return false;  // ordinary word of the language
      }
      if (source.includes(lower)) return false;
      // plural/possessive of a grounded term ("LLMs")
      return !(lower.length > 3 && lower.endsWith("s") && source.includes(lower.slice(0, -1)));
    });
    if (suspicious.length > 0) bad.push(token);
  }
  return [...new Set(bad)];
}

function repeated(text) {
  const sentences = text.split(/(?<=[。！？.!?])\s*/).map((s) => s.trim()).filter((s) => s.length >= 12);
  const seen = new Set();
  for (const sentence of sentences) {
    if (seen.has(sentence)) return true;
    seen.add(sentence);
  }
  return false;
}

// Returns { ok, text, reason }.
export function validateNarration(lang, raw, paper, targetChars, finish = "stop") {
  let text = cleanNarration(raw);
  if (finish === "length") text = cutToSentence(text);
  if (!text) return { ok: false, text, reason: "empty" };
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, text, reason: "url" };
  if (!languageOk(lang, text)) return { ok: false, text, reason: "wrong language" };
  if (text.length < targetChars * 0.5) return { ok: false, text, reason: `too short (${text.length}/${targetChars})` };
  if (text.length > targetChars * 2.2) text = cutToSentence(text.slice(0, Math.round(targetChars * 1.6)));
  if (repeated(text)) return { ok: false, text, reason: "repetition" };
  const numbers = ungroundedNumbers(text, paper);
  if (numbers.length > 0) return { ok: false, text, reason: `numbers not in abstract: ${numbers.slice(0, 4).join(" ")}` };
  const names = ungroundedNames(lang, text, paper);
  if (names.length > 0) return { ok: false, text, reason: `names not in abstract: ${names.slice(0, 4).join(" ")}` };
  return { ok: true, text, reason: null };
}

// ---- per-language generation ----------------------------------------------------

export function narrationTarget(lang, scriptOptions, paperCount, settings) {
  // template overhead (intro/overview/titles/authors/commentary/outro) with
  // one-character placeholder bodies
  const skeleton = buildScriptFromBodies(lang, scriptOptions, Array(paperCount).fill("x"));
  const overhead = skeleton.text.length - paperCount;
  const total = Math.round(settings.targetSeconds / LLM_PACE[lang]);
  const per = Math.round((total - overhead) / Math.max(1, paperCount));
  const floor = ["ja", "zh"].includes(lang) ? 250 : 600;
  return Math.max(floor, per);
}

// Generate a whole script for one language. Returns
// { ok, script?, reason, stats: { papers, failedPapers, tokens, ms } }.
export async function generateLlmScript(lang, server, scriptOptions, settings, deadline, log = () => {}) {
  const started = Date.now();
  const papers = (scriptOptions.papers || []).filter((p) => p && p.title).slice(0, Math.min(settings.maxPapers, scriptOptions.maxPapers || 8));
  if (papers.length === 0) return { ok: false, reason: "no papers", stats: { papers: 0, failedPapers: 0, tokens: 0, ms: 0 } };
  const targetChars = narrationTarget(lang, { ...scriptOptions, papers }, papers.length, settings);
  const langDeadline = Math.min(deadline, started + settings.langTimeoutMs);
  const bodies = [];
  let tokens = 0;
  let failedPapers = 0;
  for (const [index, paper] of papers.entries()) {
    let body = null;
    for (let attempt = 0; attempt <= settings.retries && body === null; attempt += 1) {
      const remaining = langDeadline - Date.now();
      if (remaining < 20000) {
        return { ok: false, reason: `time budget exhausted at paper ${index + 1}`, stats: { papers: papers.length, failedPapers, tokens, ms: Date.now() - started } };
      }
      try {
        const reply = await server.chat(buildMessages(lang, paper, targetChars, attempt > 0), {
          maxTokens: Math.round(targetChars * (TOKENS_PER_CHAR[lang] || 0.4) * 1.8) + 64,
          timeoutMs: Math.min(settings.requestTimeoutMs, remaining),
        });
        tokens += reply.tokens;
        const check = validateNarration(lang, reply.text, paper, targetChars, reply.finish);
        if (process.env.PODCAST_LLM_DEBUG_FILE) {
          appendFileSync(process.env.PODCAST_LLM_DEBUG_FILE, `=== ${lang} paper ${index + 1} attempt ${attempt + 1} finish=${reply.finish} tokens=${reply.tokens} -> ${check.reason ?? "ok"}\n${reply.text}\n`);
        }
        if (check.ok) body = check.text;
        else log(`  llm ${lang} paper ${index + 1} attempt ${attempt + 1}: rejected (${check.reason})`);
      } catch (error) {
        log(`  llm ${lang} paper ${index + 1} attempt ${attempt + 1}: ${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
    if (body === null) failedPapers += 1;
    bodies.push(body);  // null -> this paper keeps the verbatim abstract quote
  }
  const stats = { papers: papers.length, failedPapers, tokens, ms: Date.now() - started };
  if (failedPapers * 2 > papers.length) return { ok: false, reason: `${failedPapers}/${papers.length} paper narrations rejected`, stats };
  const script = buildScriptFromBodies(lang, { ...scriptOptions, papers }, bodies);
  const seconds = script.text.length * LLM_PACE[lang];
  if (seconds < settings.minSeconds) return { ok: false, reason: `script too short (~${Math.round(seconds)}s < ${settings.minSeconds}s)`, stats };
  script.llmEstimatedSeconds = Math.round(seconds);
  return { ok: true, script, reason: null, stats };
}
