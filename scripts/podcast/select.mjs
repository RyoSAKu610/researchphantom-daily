// Deterministic topic selection, catch-up planning and small JSON persistence
// helpers shared by the daily podcast pipeline.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const HISTORY_LIMIT = 800;
const DAY_MS = 86400000;

export function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

// Strict YYYY-MM-DD parsing. Returns {year, month, day, time} or null.
export function parseISODate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const probe = new Date(time);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, time };
}

export function isValidISODate(value) {
  return parseISODate(value) !== null;
}

function dayNumberOf(parsed) {
  return Math.round(parsed.time / DAY_MS);
}

function formatDayNumber(day) {
  const date = new Date(day * DAY_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function dayOfYear(dateISO) {
  const parsed = parseISODate(dateISO);
  if (!parsed) throw new Error(`invalid date: ${dateISO}`);
  const start = Date.UTC(parsed.year, 0, 1);
  return Math.round((parsed.time - start) / DAY_MS) + 1;
}

// Pool order for a given year: stable pseudo-random rotation keyed by sha256(year:id).
export function poolOrder(topics, year) {
  if (!Array.isArray(topics)) return [];
  const key = String(year);
  return topics
    .map((topic, index) => ({ topic, rank: sha256Hex(`${key}:${topic?.id ?? `#${index}`}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((entry) => entry.topic);
}

// Deterministic pick: index = dayOfYear % pool.length, advanced while the
// candidate was used within the last floor(pool.length / 2) days of history.
// Only strictly earlier dates count: the date's own entry (left by an earlier
// run of the same date) is ignored, so a --force rerun / self-repair picks the
// same topic as the original run instead of rotating to a different one.
export function pickTopic(dateISO, topics, history = []) {
  const parsed = parseISODate(dateISO);
  if (!parsed) throw new Error(`invalid date: ${dateISO}`);
  const pool = (Array.isArray(topics) ? topics : []).filter((topic) => topic && typeof topic.id === "string" && topic.id);
  if (pool.length === 0) throw new Error("topic pool is empty");
  const ordered = poolOrder(pool, parsed.year);
  const window = Math.floor(ordered.length / 2);
  const today = dayNumberOf(parsed);
  const blocked = new Set();
  for (const entry of Array.isArray(history) ? history : []) {
    const entryDate = parseISODate(entry?.date);
    if (!entryDate || typeof entry?.topicId !== "string") continue;
    const diff = today - dayNumberOf(entryDate);
    if (diff > 0 && diff <= window) blocked.add(entry.topicId);
  }
  let index = dayOfYear(dateISO) % ordered.length;
  for (let step = 0; step < ordered.length && blocked.has(ordered[index].id); step += 1) {
    index = (index + 1) % ordered.length;
  }
  return ordered[index];
}

// Dates missing between lastRecordedDate and today (oldest first, never more
// than maxDays). Empty history -> [today]. Future/none last date -> [today].
export function planCatchupDates(todayISO, lastRecordedDate, maxDays = 3) {
  const today = parseISODate(todayISO);
  if (!today) throw new Error(`invalid date: ${todayISO}`);
  const cap = Math.max(1, Math.floor(Number(maxDays)) || 1);
  const last = parseISODate(lastRecordedDate);
  if (!last) return [formatDayNumber(dayNumberOf(today))];
  const dates = [];
  for (let day = dayNumberOf(last) + 1; day <= dayNumberOf(today); day += 1) {
    dates.push(formatDayNumber(day));
  }
  if (dates.length === 0) return [];
  return dates.length > cap ? dates.slice(dates.length - cap) : dates;
}

// Deterministic curated entry for a date when arXiv is unavailable.
export function pickFallback(dateISO, entries = []) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry.arxivId === "string" && entry.arxivId);
  if (list.length === 0) return null;
  const seed = sha256Hex(`fallback:${String(dateISO)}`);
  return list[Number.parseInt(seed.slice(0, 8), 16) % list.length];
}

function normalizeHistory(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.date === "string" && typeof entry.topicId === "string")
    .map((entry) => ({ date: entry.date, topicId: entry.topicId }))
    .slice(-HISTORY_LIMIT);
}

export async function loadHistory(path) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return normalizeHistory(raw);
  } catch {
    return [];
  }
}

export async function saveHistory(path, entries) {
  const list = normalizeHistory(entries);
  await writeJsonAtomic(path, list);
  return list;
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Temp file + rename so readers never observe a half-written episode/state file.
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
