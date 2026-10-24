// CI audit for the daily podcast: verifies that recent episode dates exist and
// ship every configured language with in-duration audio. Read-only by design —
// GitHub-hosted runners cannot synthesize audio (the engines live on the bot
// VM), and edge-tts is banned from this pipeline anyway. A scheduled run with a
// non-zero exit ("red X") is the signal to repair the engine server and re-run
// scripts/podcast/bot/daily.sh.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseISODate } from "./select.mjs";
import { loadConfig, toISODate } from "./daily.mjs";

const moduleDir = fileURLToPath(new URL(".", import.meta.url));

// today, today-1, ... oldest (inclusive window of `days` calendar dates).
export function recentDates(todayISO, days) {
  const parsed = parseISODate(todayISO);
  if (!parsed) throw new Error(`invalid date: ${todayISO}`);
  const count = Math.max(1, Math.floor(Number(days)) || 1);
  const dates = [];
  for (let shift = 0; shift < count; shift += 1) {
    const t = new Date(parsed.time - shift * 86400000);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, "0");
    const d = String(t.getUTCDate()).padStart(2, "0");
    dates.unshift(`${y}-${m}-${d}`);
  }
  return dates;
}

export async function auditEpisode(date, episodeRoot, config) {
  const problems = [];
  const file = join(episodeRoot, date, "episode.json");
  if (!existsSync(file)) return { date, problems: ["episode.json missing"] };
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return { date, problems: [`episode.json unreadable (${String(error?.message ?? error)})`] };
  }
  if (data?.date !== date) problems.push(`episode.json date mismatch (got ${JSON.stringify(data?.date)})`);
  const langs = data?.languages && typeof data.languages === "object" ? data.languages : {};
  for (const lang of config.languages) {
    const entry = langs[lang];
    if (!entry || typeof entry !== "object") {
      problems.push(`${lang}: entry missing`);
      continue;
    }
    if (entry.status !== "ok") {
      problems.push(`${lang}: status=${JSON.stringify(entry.status)}${entry.error ? ` (${String(entry.error).slice(0, 60)})` : ""}`);
      continue;
    }
    if (entry.audio && !existsSync(join(episodeRoot, date, entry.audio))) {
      problems.push(`${lang}: audio file missing (${entry.audio})`);
    }
    const dur = Number(entry.durationSeconds);
    if (!Number.isFinite(dur) || dur < config.duration.minSeconds || dur >= config.duration.maxSeconds) {
      const got = Number.isFinite(dur) ? `${Math.round(dur)}s` : "none";
      problems.push(`${lang}: duration ${got} outside [${config.duration.minSeconds},${config.duration.maxSeconds})`);
    }
  }
  return { date, problems };
}

function short(value, length = 100) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, length);
}

export async function main({ argv = process.argv.slice(2) } = {}) {
  const config = await loadConfig();
  const todayISO = toISODate(new Date());
  const dates = recentDates(todayISO, config.backfillDays + 1);
  const episodeRoot = join(moduleDir, "..", "..", config.episodeDir);

  let failed = false;
  for (const date of dates) {
    const { problems } = await auditEpisode(date, episodeRoot, config);
    if (problems.length > 0) {
      failed = true;
      console.error(`[audit] ${date}: PROBLEM`);
      for (const problem of problems) console.error(`  - ${short(problem)}`);
    } else {
      console.log(`[audit] ${date}: ok (all ${config.languages.length} languages within duration bounds)`);
    }
  }
  if (failed) {
    console.error(`[audit] FAIL: repair the engine server (tts-hub / VoiceStudio) on the bot VM, then run scripts/podcast/bot/daily.sh`);
    return 1;
  }
  console.log(`[audit] OK: last ${dates.length} dates complete (${config.languages.join(", ")})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exitCode = code;
}
