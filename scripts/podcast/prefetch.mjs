// arXiv paper prefetch cache. While the box is online, fetch candidate papers
// (metadata + abstracts) for the topics of the coming days and keep them in a
// small local JSON cache, so the daily run survives arXiv 429s / being offline
// instead of dropping to the one-paper curated fallback (short episode).
//
// Off unless PODCAST_PREFETCH=1 (then daily.mjs reads the cache and refreshes
// it for the next days after a run). Standalone use while online:
//
//   node scripts/podcast/prefetch.mjs [--days N] [--all] [--from YYYY-MM-DD]
//
// Cache: $PODCAST_ARXIV_CACHE_DIR (default ~/.cache/researchphantom-daily/arxiv),
// one <topicId>.json per topic: { topicId, keyword, fetchedAt, papers[] }.
// It lives outside the repo, so daily.sh's `git add -A` never commits it.
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchPapers } from "./arxiv.mjs";
import { isValidISODate, loadHistory, parseISODate, pickTopic, readJson, writeJsonAtomic } from "./select.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

export function prefetchEnabled(env = process.env) {
  return String(env.PODCAST_PREFETCH ?? "") === "1";
}

export function cacheSettings(env = process.env) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return {
    dir: env.PODCAST_ARXIV_CACHE_DIR || join(base, "researchphantom-daily", "arxiv"),
    // cache younger than this is used without asking arXiv at all
    freshHours: num(env.PODCAST_ARXIV_CACHE_FRESH_HOURS, 12),
    // older cache is still a fallback when arXiv fails, up to this age
    maxAgeDays: num(env.PODCAST_ARXIV_CACHE_MAX_AGE_DAYS, 14),
    // how many upcoming days daily.mjs prefetches after a run
    days: Math.max(0, Math.floor(num(env.PODCAST_PREFETCH_DAYS, 3))),
  };
}

function safeId(topicId) {
  return String(topicId).replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function readCache(dir, topicId) {
  const entry = await readJson(join(dir, `${safeId(topicId)}.json`), null);
  if (!entry || !Array.isArray(entry.papers) || entry.papers.length === 0) return null;
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return null;
  return { ...entry, ageMs: Date.now() - fetchedAt };
}

export async function writeCache(dir, topic, papers) {
  if (!Array.isArray(papers) || papers.length === 0) return false; // never overwrite with nothing
  await writeJsonAtomic(join(dir, `${safeId(topic.id)}.json`), {
    topicId: topic.id,
    keyword: topic.keyword,
    fetchedAt: new Date().toISOString(),
    papers,
  });
  return true;
}

// Papers for one topic: fresh cache -> live arXiv (cache refreshed) -> stale
// cache (<= maxAgeDays) -> []. Returns { papers, origin, fetchedAt } where
// origin is "cache-fresh" | "arxiv" | "cache-stale" | "none".
export async function getPapers(topic, options = {}) {
  const { max = 10, settings = cacheSettings(), offline = false, fetchImpl, onEvent } = options;
  const cached = await readCache(settings.dir, topic.id);
  if (cached && cached.ageMs <= settings.freshHours * HOUR_MS) {
    return { papers: cached.papers.slice(0, max), origin: "cache-fresh", fetchedAt: cached.fetchedAt };
  }
  if (!offline) {
    const fetched = await fetchPapers(topic.keyword, { max, ...(fetchImpl ? { fetchImpl } : {}), onEvent });
    if (fetched.length > 0) {
      await writeCache(settings.dir, topic, fetched).catch(() => false);
      return { papers: fetched, origin: "arxiv", fetchedAt: new Date().toISOString() };
    }
  }
  if (cached && cached.ageMs <= settings.maxAgeDays * DAY_MS) {
    return { papers: cached.papers.slice(0, max), origin: "cache-stale", fetchedAt: cached.fetchedAt };
  }
  return { papers: [], origin: "none", fetchedAt: null };
}

function addDays(dateISO, days) {
  const parsed = parseISODate(dateISO);
  const d = new Date(parsed.time + days * DAY_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Topics daily.mjs will pick for fromISO .. fromISO+days-1, simulating the
// history entries those runs will add (pickTopic is pure).
export function predictTopics(fromISO, days, topics, history = []) {
  const simulated = (Array.isArray(history) ? history : []).filter((entry) => entry.date < fromISO);
  const plan = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(fromISO, offset);
    const topic = pickTopic(date, topics, simulated);
    plan.push({ date, topic });
    simulated.push({ date, topicId: topic.id });
  }
  return plan;
}

// Refresh the cache for a list of topics (deduplicated). Topics whose cache is
// still fresh are skipped. arxiv.mjs spaces requests >= 3 s apart and backs
// off on 429; after `maxFailures` consecutive failures the run stops early.
export async function prefetchTopics(topicList, options = {}) {
  const { max = 10, settings = cacheSettings(), log = () => {}, maxFailures = 3, fetchImpl } = options;
  const seen = new Set();
  const summary = { fetched: [], fresh: [], failed: [] };
  let consecutiveFailures = 0;
  for (const topic of topicList) {
    if (!topic || seen.has(topic.id)) continue;
    seen.add(topic.id);
    const cached = await readCache(settings.dir, topic.id);
    if (cached && cached.ageMs <= settings.freshHours * HOUR_MS) {
      summary.fresh.push(topic.id);
      continue;
    }
    if (consecutiveFailures >= maxFailures) {
      summary.failed.push(topic.id);
      continue;
    }
    const papers = await fetchPapers(topic.keyword, {
      max,
      ...(fetchImpl ? { fetchImpl } : {}),
      onEvent: (event) => log(`prefetch ${topic.id}: ${event.type}${event.status ? ` ${event.status}` : ""}${event.backoffMs ? ` backoff ${Math.round(event.backoffMs / 1000)}s` : ""}`),
    });
    if (papers.length > 0 && (await writeCache(settings.dir, topic, papers))) {
      summary.fetched.push(topic.id);
      consecutiveFailures = 0;
    } else {
      summary.failed.push(topic.id);
      consecutiveFailures += 1;
    }
  }
  return summary;
}

export async function cacheStatus(settings = cacheSettings()) {
  let files = [];
  try {
    files = (await readdir(settings.dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return { dir: settings.dir, topics: 0, fresh: 0, newest: null };
  }
  let fresh = 0;
  let newest = null;
  for (const name of files) {
    const entry = await readCache(settings.dir, name.replace(/\.json$/, ""));
    if (!entry) continue;
    if (entry.ageMs <= settings.freshHours * HOUR_MS) fresh += 1;
    if (!newest || entry.fetchedAt > newest) newest = entry.fetchedAt;
  }
  return { dir: settings.dir, topics: files.length, fresh, newest };
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const settings = cacheSettings(env);
  let days = Math.max(1, settings.days || 3);
  let all = false;
  let from = todayLocal();
  let statusOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--days") days = Math.max(1, Math.floor(Number(argv[(i += 1)])) || 3);
    else if (arg === "--all") all = true;
    else if (arg === "--from") from = argv[(i += 1)];
    else if (arg === "--status") statusOnly = true;
    else {
      console.error("Usage: node scripts/podcast/prefetch.mjs [--days N] [--all] [--from YYYY-MM-DD] [--status]");
      return 1;
    }
  }
  if (!isValidISODate(from)) {
    console.error(`invalid --from: ${from}`);
    return 1;
  }
  if (statusOnly) {
    console.log(JSON.stringify(await cacheStatus(settings)));
    return 0;
  }
  const config = await readJson(join(moduleDir, "config.json"), {});
  const topics = await readJson(join(moduleDir, "topics.json"), []);
  const history = await loadHistory(join(projectRoot, config.stateDir || "podcast/state", "history.json"));
  const plan = predictTopics(from, days, topics, history);
  const list = plan.map((entry) => entry.topic);
  if (all) list.push(...topics);
  console.log(`prefetch: ${plan.map((entry) => `${entry.date}=${entry.topic.id}`).join(" ")}${all ? ` (+all ${topics.length} topics)` : ""} -> ${settings.dir}`);
  const max = Math.max((config.maxPapers || 8) + 2, 10);
  const summary = await prefetchTopics(list, { max, settings, log: (line) => console.log(line) });
  console.log(`prefetch: fetched=${summary.fetched.length} fresh=${summary.fresh.length} failed=${summary.failed.length}${summary.failed.length ? ` (${summary.failed.join(",")})` : ""}`);
  return summary.failed.length > 0 && summary.fetched.length === 0 && summary.fresh.length === 0 ? 3 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
