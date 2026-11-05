// Static site builder for the daily podcast: a plain download site
// (index.html), per-language RSS 2.0 feeds and a machine-readable
// episodes.json, plus copies of every episode's audio/transcript so the
// output folder is deployable as-is.
//
// `node scripts/podcast/site.mjs` wipes and rebuilds podcast-site/ from
// scratch on every run: all episode directories are scanned, nothing is
// incremental, and zero episodes must produce empty-but-valid output (empty
// index, empty feeds, empty episodes.json).
//
// No dependencies beyond Node builtins. The generated index is the library UI
// (音の図書館): all CSS and the player script are inlined, so the page has zero
// external dependencies and the deploy output set stays index + feeds + JSON.
// Base URL contract (pickBaseUrl): absolute URLs are used in RSS enclosures
// and episodes.json; index.html always writes relative paths so a local
// preview straight off the filesystem simply works.
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./daily.mjs";
import { isValidISODate, readJson, writeJsonAtomic } from "./select.mjs";

const LANG_DEFAULTS = {
  labels: { ja: "日本語", zh: "中文", de: "Deutsch", es: "Español", ru: "Русский", it: "Italiano" },
  download: { ja: "ダウンロード（MP3）", zh: "下载（MP3）", de: "Download (MP3)", es: "Descarga (MP3)", ru: "Загрузка (MP3)", it: "Download (MP3)" },
  transcript: { ja: "スクリプト", zh: "文稿", de: "Skript", es: "Guion", ru: "Сценарий", it: "Trascrizione" },
  rss: { ja: "RSS（日本語）", zh: "RSS（中文）", de: "RSS (Deutsch)", es: "RSS (Español)", ru: "RSS (Русский)", it: "RSS (Italiano)" },
  itemDescription: {
    ja: (label, count) => `テーマ「${label}」。論文${count}件。`,
    zh: (label, count) => `主题「${label}」·论文${count}篇。`,
    de: (label, count) => `Thema: ${label}. ${count} Papers.`,
    es: (label, count) => `Tema: ${label}. ${count} artículos.`,
    ru: (label, count) => `Тема: ${label}. Статей: ${count}.`,
    it: (label, count) => `Tema: ${label}. ${count} articoli.`,
  },
  channelSuffix: { ja: "（{label}）", zh: "（{label}）", de: " ({label})", es: " ({label})", ru: " ({label})", it: " ({label})" },
};

// RSS <language> channel tag: BCP-47-ish code per lineup language (zh gets the
// region suffix like the old feed-XML contract).
const XML_LANG = { ja: "ja", zh: "zh-CN", de: "de", es: "es", ru: "ru", it: "it" };

// ---- small helpers ------------------------------------------------------------

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const escapeXml = escapeHtml;

// Sanitize one candidate base URL: http(s) only, no trailing slash, else "".
// "" is a valid result: the site then runs fully on relative URLs (local
// preview) and RSS enclosures stay relative too.
export function resolveBaseUrl(raw) {
  let value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) value = "";
  return value;
}

// Precedence: PODCAST_SITE_BASE_URL env -> config.site.baseUrl (when the
// "site" object exists, even empty) -> legacy config.siteBaseUrl -> "".
export function pickBaseUrl(config = null, env = process.env) {
  const envValue = env && typeof env === "object" ? String(env.PODCAST_SITE_BASE_URL ?? "") : "";
  if (envValue.trim()) return resolveBaseUrl(envValue);
  if (config && typeof config === "object" && Object.hasOwn(config, "site")) {
    return resolveBaseUrl(config.site?.baseUrl);
  }
  if (config && typeof config === "object") return resolveBaseUrl(config.siteBaseUrl);
  return "";
}

export function joinUrl(base, path) {
  const clean = String(path ?? "").replace(/^\/+/, "");
  const origin = resolveBaseUrl(base);
  return origin ? `${origin}/${clean}` : clean;
}

export function langLabel(config, lang) {
  const value = config?.languageLabels?.[lang] ?? LANG_DEFAULTS.labels[lang];
  return typeof value === "string" && value.trim() ? value.trim() : String(lang);
}

export function channelTitle(config, lang) {
  const title = String(config?.title ?? "Phantomresearch Daily").trim() || "Phantomresearch Daily";
  const pattern = LANG_DEFAULTS.channelSuffix[lang] ?? " ({label})";
  return `${title}${pattern.replaceAll("{label}", langLabel(config, lang))}`;
}

export function slugify(value) {
  const slug = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "phantomresearch-daily";
}

// Suggested save-name for the `download` attribute.
export function audioFileName(config, date, lang) {
  return `${slugify(config?.title)}-${date}-${lang}.mp3`;
}

// RFC822/2822 pubDate derived only from episode data (never Date.now()), so a
// rebuild of the same episode data is byte-identical (idempotency contract).
export function rfc822Date(dateISO, generatedAt = null) {
  const parsed = Date.parse(String(generatedAt ?? ""));
  const source = Number.isFinite(parsed) ? new Date(parsed) : new Date(`${dateISO}T12:00:00Z`);
  return Number.isNaN(source.getTime()) ? new Date(0).toUTCString() : source.toUTCString();
}

export function formatDuration(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? String(Math.round(value)) : null;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  return value >= 1000000 ? `${(value / 1000000).toFixed(1)} MB` : `${Math.round(value / 1000)} KB`;
}

// ---- episode scanning ------------------------------------------------------------

// Returns [{ dirName, episode, langEntries }] sorted newest first. Broken or
// invalid directories are skipped; a missing/empty root yields [].
export async function loadEpisodes(episodeRoot) {
  let names;
  try {
    names = (await readdir(episodeRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const episodes = [];
  for (const dirName of names) {
    const episode = await readJson(join(episodeRoot, dirName, "episode.json"), null);
    if (!episode || typeof episode !== "object") continue;
    const date = isValidISODate(episode.date) ? episode.date : isValidISODate(dirName) ? dirName : null;
    if (!date || !episode.topic || typeof episode.topic !== "object") continue;
    episodes.push({
      dirName,
      episodeObject: { ...episode, date },
      langEntries: episode.languages && typeof episode.languages === "object" ? episode.languages : {},
    });
  }
  // readdir order is unspecified: sort explicitly instead of relying on it.
  return episodes.sort((a, b) => (a.episodeObject.date > b.episodeObject.date ? -1 : a.episodeObject.date < b.episodeObject.date ? 1 : 0));
}

// Languages that actually produced audio for an episode. Missing keys and
// entries not marked status:"ok" are excluded — the "hide unavailable
// buttons" contract applies to the page, feeds and episodes.json alike.
export function availableLanguages(langEntries, languages) {
  const result = [];
  for (const lang of languages ?? Object.keys(langEntries ?? {})) {
    const entry = langEntries?.[lang];
    if (entry && entry.status === "ok" && typeof entry.audio === "string" && entry.audio.trim()) {
      result.push(lang);
    }
  }
  return result;
}

// ---- shared plain-data view -------------------------------------------------------

// One episode -> a normalized, serializable summary used by feed/page/JSON
// builders. `audio[lang]` is null whenever that language has no usable audio.
export function episodeView(entry, config, languages) {
  const { episodeObject, langEntries } = entry;
  const topicLabels = {};
  for (const lang of languages) {
    const value = episodeObject.topic?.labels?.[lang];
    topicLabels[lang] = typeof value === "string" && value.trim() ? value.trim() : String(episodeObject.topic?.id ?? "");
  }
  const audio = {};
  for (const lang of languages) {
    const langEntry = langEntries?.[lang];
    const usable = Boolean(
      langEntry
      && langEntry.status === "ok"
      && typeof langEntry.audio === "string"
      && langEntry.audio.trim()
      && (Number.isFinite(Number(langEntry.bytes)) || Number.isFinite(Number(langEntry.observedBytes))),
    );
    audio[lang] = usable ? {
      path: `episodes/${episodeObject.date}/${lang}.mp3`,
      bytes: Number.isFinite(Number(langEntry.bytes)) ? Number(langEntry.bytes) : Number(langEntry.observedBytes),
      durationSeconds: Number.isFinite(Number(langEntry.durationSeconds)) ? Number(langEntry.durationSeconds) : null,
      voice: langEntry.voice ?? null,
      scriptPath: langEntry.scriptFile ? `episodes/${episodeObject.date}/${langEntry.scriptFile}` : null,
    } : null;
  }
  return {
    date: episodeObject.date,
    topicId: String(episodeObject.topic?.id ?? ""),
    topicLabels,
    source: episodeObject.source ?? "",
    generatedAt: episodeObject.generatedAt ?? null,
    papers: Array.isArray(episodeObject.papers) ? episodeObject.papers : [],
    notes: Array.isArray(episodeObject.notes) ? episodeObject.notes : [],
    audio,
  };
}

// ---- RSS 2.0 ---------------------------------------------------------------------

function rssItem(view, lang, baseUrl, position) {
  const audioInfo = view.audio[lang];
  const url = joinUrl(baseUrl, audioInfo.path);
  const topicLabel = view.topicLabels[lang] ?? view.date;
  const describer = LANG_DEFAULTS.itemDescription[lang] ?? LANG_DEFAULTS.itemDescription.ja;
  // Without a base URL there is no permalink; a stable urn-ish tag still
  // keeps the guid unique and deterministic.
  const guid = baseUrl ? url : `phantomresearch-daily-${view.date}-${lang}`;
  const duration = formatDuration(audioInfo.durationSeconds);
  return [
    "    <item>",
    `      <title>${escapeXml(`${view.date} — ${topicLabel}`)}</title>`,
    `      <link>${escapeXml(joinUrl(baseUrl, `episodes/${view.date}/`))}</link>`,
    `      <description>${escapeXml(describer(topicLabel, view.papers.length))}</description>`,
    `      <enclosure url="${escapeXml(url)}" type="audio/mpeg" length="${Math.max(0, Math.floor(Number(audioInfo.bytes)))}"/>`,
    `      <guid isPermaLink="${Boolean(baseUrl)}">${escapeXml(guid)}</guid>`,
    `      <pubDate>${escapeXml(rfc822Date(view.date, view.generatedAt))}</pubDate>`,
    duration !== null ? `      <itunes:duration>${escapeXml(duration)}</itunes:duration>` : null,
    `      <itunes:order>${position}</itunes:order>`,
    "    </item>",
  ].filter((line) => line !== null).join("\n");
}

export function buildFeedXml(lang, episodeEntries, config, baseUrl) {
  const subtitle = config?.subtitle?.[lang] ?? config?.subtitle?.ja ?? config?.title ?? "";
  const link = baseUrl ? `${baseUrl}/` : "index.html";
  const selfLink = baseUrl ? joinUrl(baseUrl, `feed-${lang}.xml`) : null;
  const views = episodeEntries.map((entry) => episodeView(entry, config, [lang]));
  const items = [];
  let position = 1;
  for (const [index, view] of views.entries()) {
    if (!view.audio[lang]) continue;
    items.push(rssItem(view, lang, baseUrl, position));
    position += 1;
  }
  const latest = episodeEntries[0]?.episodeObject ?? null;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(channelTitle(config, lang))}</title>`,
    `    <link>${escapeXml(link)}</link>`,
    `    <language>${escapeXml(XML_LANG[lang] ?? lang)}</language>`,
    `    <description>${escapeXml(subtitle)}</description>`,
    selfLink ? `    <atom:link rel="self" type="application/rss+xml" href="${escapeXml(selfLink)}"/>` : null,
    "    <itunes:author>Phantomresearch</itunes:author>",
    `    <itunes:summary>${escapeXml(subtitle)}</itunes:summary>`,
    "    <itunes:explicit>false</itunes:explicit>",
    "    <itunes:owner><itunes:name>Phantomresearch</itunes:name></itunes:owner>",
    '    <itunes:category text="Science"/>',
    latest ? `    <lastBuildDate>${escapeXml(rfc822Date(latest.date, latest.generatedAt))}</lastBuildDate>` : null,
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].filter((line) => line !== null).join("\n");
}

// ---- episodes.json ----------------------------------------------------------------

export function buildEpisodesJson(episodeEntries, config, baseUrl, languages) {
  languages = (languages ?? (config?.languages ?? [])).filter(Boolean);
  const views = episodeEntries.map((entry) => episodeView(entry, config, languages));
  return {
    version: 1,
    podcast: config?.title ?? "Phantomresearch Daily",
    subtitle: config?.subtitle ?? {},
    languages,
    baseUrl: baseUrl || null,
    generatedAt: views[0]?.generatedAt ?? null,
    episodeCount: views.length,
    feeds: Object.fromEntries(languages.map((lang) => [lang, `feed-${lang}.xml`])),
    episodes: views.map((view) => ({
      date: view.date,
      topic: { id: view.topicId, labels: view.topicLabels },
      source: view.source,
      generatedAt: view.generatedAt,
      papers: view.papers,
      notes: view.notes,
      languages: Object.fromEntries(languages.map((lang) => {
        const audio = view.audio[lang];
        return [lang, audio ? {
          status: "ok",
          voice: audio.voice,
          bytes: audio.bytes,
          durationSeconds: audio.durationSeconds,
          audioPath: audio.path,
          audioUrl: joinUrl(baseUrl, audio.path),
          scriptPath: audio.scriptPath,
        } : null];
      })),
    })),
  };
}

// ---- index.html -------------------------------------------------------------------
// The Pages site is this file's output. podcast-site/ is wiped on every
// deploy, so the library UI is inlined here. RSS, episodes.json, and the
// relative audio paths stay on the same contract as before.
// Engine names that are just "edge" (retired third-party TTS) are omitted;
// irodori / voicestudio / qwen still show as quiet metadata when the episode
// recorded them.

function waveBars(seed, count = 22) {
  let hash = 2166136261;
  const text = String(seed);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 2246822507);
    hash ^= hash >>> 13;
    hash >>>= 0;
    const noise = (hash % 1000) / 1000;
    const env = Math.sin(((i + 0.5) / count) * Math.PI);
    bars.push(Math.round(14 + env * (24 + noise * 62)));
  }
  return bars;
}

function waveHtml(seed, count) {
  return waveBars(seed, count).map((height) => `<span style="--h:${height}"></span>`).join("");
}

function formatClock(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const total = Math.round(value);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function enginesFromNotes(notes) {
  const map = {};
  const text = (Array.isArray(notes) ? notes : []).join("\n");
  const match = text.match(/TTS engines:\s*([^\n]+)/i);
  if (!match) return map;
  for (const part of match[1].split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const lang = part.slice(0, eq).trim();
    const engine = part.slice(eq + 1).trim();
    if (!lang || !engine || /edge/i.test(engine)) continue;
    map[lang] = engine;
  }
  return map;
}

function synopsisHtml(view) {
  const paper = view.papers.find((item) => typeof item?.excerpt === "string" && item.excerpt.trim());
  if (paper) {
    let text = paper.excerpt.replace(/\s+/g, " ").trim();
    const max = 200;
    if (text.length > max) {
      const slice = text.slice(0, max);
      const stop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("。"));
      text = `${(stop > 90 ? slice.slice(0, stop + 1) : slice).trim()}…`;
    }
    return `<p class="synopsis"><span class="kicker">抄録より</span>${escapeHtml(text)}</p>`;
  }
  const titles = view.papers.map((item) => String(item?.title ?? "").trim()).filter(Boolean).slice(0, 2);
  if (!titles.length) return "";
  return `<p class="synopsis"><span class="kicker">この回</span>${escapeHtml(titles.join(" / "))}</p>`;
}

function paperListHtml(view) {
  if (view.papers.length === 0) {
    return `<p class="papers-empty">${escapeHtml("この回の収録論文データはありません / No paper metadata.")}</p>`;
  }
  const items = view.papers.map((paper) => {
    const title = String(paper?.title ?? "").trim();
    const url = typeof paper?.url === "string" && paper.url ? paper.url : paper?.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : null;
    const authors = Array.isArray(paper?.authors) ? paper.authors.map((name) => String(name).trim()).filter(Boolean) : [];
    const author = authors.length === 0 ? "" : authors.length > 2 ? `${authors[0]} ほか` : authors.join(", ");
    const meta = [
      paper?.arxivId ? `arXiv:${escapeHtml(paper.arxivId)}` : "",
      paper?.published ? escapeHtml(paper.published) : "",
      typeof paper?.primaryCategory === "string" && paper.primaryCategory ? escapeHtml(paper.primaryCategory) : "",
      author ? escapeHtml(author) : "",
    ].filter(Boolean).join(" · ");
    const titleHtml = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
      : escapeHtml(title);
    const pdf = typeof paper?.pdfUrl === "string" && paper.pdfUrl
      ? ` <a class="pdf" href="${escapeHtml(paper.pdfUrl)}" target="_blank" rel="noopener">PDF</a>`
      : "";
    return `<li>${titleHtml}${pdf}${meta ? `<span class="meta">${meta}</span>` : ""}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

function langBlockHtml(view, lang, config, engines) {
  if (!view.audio[lang]) return ""; // unavailable language: render nothing at all
  const audio = view.audio[lang];
  const clock = formatClock(audio.durationSeconds);
  const details = [formatBytes(audio.bytes), clock || (formatDuration(audio.durationSeconds) ? `${formatDuration(audio.durationSeconds)}s` : "")]
    .filter(Boolean).join(" · ");
  const engine = engines[lang] || "";
  const voice = typeof audio.voice === "string" && audio.voice.trim() && !/edge|neural/i.test(audio.voice) ? audio.voice.trim() : "";
  const voiceLine = [engine, voice].filter(Boolean).join(" · ");
  return [
    `      <div class="lang-block" data-lang="${escapeHtml(lang)}">`,
    `        <p class="lang-label">${escapeHtml(langLabel(config, lang))}</p>`,
    `        <audio controls preload="none" src="${escapeHtml(audio.path)}"></audio>`,
    `        <p class="dl-row">`,
    `          <a class="btn" href="${escapeHtml(audio.path)}" download="${escapeHtml(audioFileName(config, view.date, lang))}">${escapeHtml(LANG_DEFAULTS.download[lang] ?? "Download (MP3)")}</a>`,
    audio.scriptPath ? `          <a class="link" href="${escapeHtml(audio.scriptPath)}">${escapeHtml(LANG_DEFAULTS.transcript[lang] ?? "Transcript")}</a>` : null,
    details ? `          <span class="dl-meta">${escapeHtml(details)}</span>` : null,
    `        </p>`,
    voiceLine ? `        <p class="voice-line"><span>音声</span> ${escapeHtml(voiceLine)}</p>` : null,
    `      </div>`,
  ].filter((line) => line !== null).join("\n");
}

function durationSpans(view, languages) {
  return languages.map((lang) => {
    const clock = formatClock(view.audio[lang]?.durationSeconds);
    if (!clock) return "";
    return `<span class="dur" data-lang="${escapeHtml(lang)}">${escapeHtml(clock)}</span>`;
  }).join("");
}

function episodeArticleHtml(entry, config, languages, index) {
  const view = episodeView(entry, config, languages);
  const latest = index === 0;
  // The site test requires the exact attribute class="episode latest".
  const classes = latest ? "episode latest" : "episode";
  const engines = enginesFromNotes(view.notes);
  const no = String(index + 1).padStart(2, "0");
  const topicSpans = languages
    .map((lang) => `<span class="topic-label" lang="${escapeHtml(lang)}" data-lang="${escapeHtml(lang)}">${escapeHtml(view.topicLabels[lang])}</span>`)
    .join("");
  const blocks = languages.map((lang) => langBlockHtml(view, lang, config, engines)).join("\n");
  const badge = view.source === "curated" ? "curated" : view.source === "arxiv" ? "arXiv" : escapeHtml(view.source || "—");
  const paperCount = view.papers.length;
  return [
    `  <article class="${classes}" id="ep-${escapeHtml(view.date)}">`,
    `    <div class="card-shell">`,
    `    <div class="cover" aria-hidden="true"><div class="cover-shift"><div class="wave">${waveHtml(view.date, 22)}</div><span class="cover-no">${no}</span></div></div>`,
    `    <header class="ep-head">`,
    `      <p class="cat"><span>No. ${no}</span><time datetime="${escapeHtml(view.date)}">${escapeHtml(view.date)}</time></p>`,
    `      <h2 class="topic">${topicSpans}</h2>`,
    `      <p class="when"><span class="badge">${badge}</span><span class="count">${paperCount}本</span>${durationSpans(view, languages)}</p>`,
    `      <p class="missing">この言語の音声はありません</p>`,
    `      <p class="card-actions">`,
    `        <button type="button" class="solid play-card" data-play aria-pressed="false">聴く</button>`,
    `        <button type="button" class="ghost open-card" aria-expanded="${latest ? "true" : "false"}" aria-controls="folio-${escapeHtml(view.date)}">詳細</button>`,
    `      </p>`,
    `    </header>`,
    `    <div class="folio" id="folio-${escapeHtml(view.date)}"${latest ? "" : " inert"}>`,
    `      <div class="folio-inner">`,
    `        ${synopsisHtml(view)}`,
    blocks,
    `        <details class="papers">`,
    `          <summary>${escapeHtml("収録論文")}</summary>`,
    `          ${paperListHtml(view)}`,
    `        </details>`,
    `      </div>`,
    `    </div>`,
    `    </div>`,
    `  </article>`,
  ].join("\n");
}

function monthHeading(month) {
  const [year, mon] = month.split("-");
  return `${year}年${Number(mon)}月`;
}

function shelfHtml(episodeEntries, config, languages) {
  const groups = [];
  episodeEntries.forEach((entry, index) => {
    const month = String(entry.episodeObject.date).slice(0, 7);
    let group = groups.find((item) => item.month === month);
    if (!group) {
      group = { month, items: [] };
      groups.push(group);
    }
    group.items.push(episodeArticleHtml(entry, config, languages, index));
  });
  const months = groups.map((group) => group.month);
  const timeline = groups.map((group) => {
    const mon = Number(group.month.slice(5));
    const dup = months.filter((item) => item.slice(5) === group.month.slice(5)).length > 1;
    const label = dup ? `${group.month.slice(0, 4)}.${group.month.slice(5)}` : `${mon}月`;
    return `<a href="#m-${escapeHtml(group.month)}">${escapeHtml(label)}</a>`;
  }).join("");
  const sections = groups.map((group) => [
    `<section class="month" id="m-${escapeHtml(group.month)}">`,
    `<h3 class="month-label"><span>${escapeHtml(monthHeading(group.month))}</span><span>${group.items.length}冊</span></h3>`,
    `<div class="grid">`,
    group.items.join("\n"),
    `</div>`,
    `</section>`,
  ].join("\n")).join("\n");
  return `<div class="library"><nav class="timeline" aria-label="月">${timeline}</nav><div class="months">${sections}</div></div>`;
}

function libraryCss() {
  return `
:root{color-scheme:dark;--bg:#0c0b09;--ink:#f3efe6;--muted:#c4baab;--faint:#b7ad9f;--line:rgba(243,239,230,.1);--brass:#e6c48a;--brass-ink:#1a140c;--sans:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Segoe UI",sans-serif;--serif:"Iowan Old Style",Palatino,"Palatino Linotype","Yu Mincho","YuMincho","Hiragino Mincho ProN","Hiragino Mincho Pro",serif}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{background:var(--bg);-webkit-text-size-adjust:100%}
body{margin:0;background:radial-gradient(900px 480px at 80% -10%,rgba(230,196,138,.08),transparent 55%),var(--bg);color:var(--ink);font:17px/1.6 var(--serif);-webkit-font-smoothing:antialiased;padding-bottom:132px}
button,input,a{font-family:var(--sans)}
button{font:inherit;font-family:var(--sans);color:inherit;background:none;border:0;padding:0;cursor:pointer}
::selection{background:rgba(230,196,138,.35);color:#fff}
:focus{outline:none}
:focus-visible{outline:2px solid var(--brass);outline-offset:3px}
.skip{position:absolute;left:12px;top:-48px;z-index:80;background:var(--brass);color:var(--brass-ink);padding:8px 12px;border-radius:999px;text-decoration:none}
.skip:focus{top:12px}
.wrap{width:min(1120px,calc(100% - 40px));margin:0 auto}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.tools{position:sticky;top:0;z-index:30;background:rgba(12,11,9,.72);border-bottom:1px solid var(--line);backdrop-filter:blur(18px) saturate(1.2);-webkit-backdrop-filter:blur(18px) saturate(1.2)}
.tools-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px}
.brand{color:var(--ink);text-decoration:none;letter-spacing:.18em;font-size:12px;white-space:nowrap}
.tabs{display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto;justify-content:flex-end;-webkit-overflow-scrolling:touch}
.tab{flex:0 0 auto;min-height:40px;padding:0 12px;border-radius:999px;color:var(--muted);border:1px solid transparent}
.tab:hover{color:var(--ink)}
.tab.is-active{background:var(--brass);color:var(--brass-ink);font-weight:600}
.hero{position:relative;min-height:calc(100vh - 88px);min-height:calc(100dvh - 88px);display:flex;align-items:flex-end;overflow:hidden;padding-bottom:28px}
.hero .wrap{position:relative;z-index:1;width:min(1120px,calc(100% - 48px));padding-bottom:108px}
.eyebrow{margin:0 0 14px;font-family:var(--sans);font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--brass)}
h1{margin:0;font-weight:500;font-size:clamp(56px,12vw,120px);letter-spacing:-.045em;line-height:1.05}
.lede{margin:18px 0 0;max-width:16em;font-size:clamp(26px,4vw,40px);line-height:1.3;letter-spacing:-.03em;font-weight:500}
.sub,.sub-alt,.lede-en{margin:12px 0 0;max-width:38em;color:var(--muted)}
.lede-en,.sub-alt{font-size:14px;color:var(--faint)}
.hero-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}
.chip{font-family:var(--sans);font-size:12px;letter-spacing:.04em;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 10px}
.solid,.ghost{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:999px;text-decoration:none;cursor:pointer;font-family:var(--sans);font-weight:600;letter-spacing:.01em}
.solid{background:var(--brass);color:var(--brass-ink)}
.ghost{border:1px solid rgba(243,239,230,.18);color:var(--ink);font-weight:500}
.hero-wave{position:absolute;left:0;right:0;bottom:0;height:26vh;display:flex;align-items:flex-end;gap:clamp(4px,1vw,10px);padding:0 1.5vw;pointer-events:none;opacity:.7;transform:translate3d(0,calc(var(--scrub,0) * -42px),0) scaleY(calc(1 + var(--scrub,0) * .08));transform-origin:bottom center;mask-image:linear-gradient(to top,#000 30%,transparent);-webkit-mask-image:linear-gradient(to top,#000 30%,transparent)}
.hero-wave span{flex:1 1 0;height:calc(var(--h) * 1.15px);border-radius:99px 99px 0 0;background:linear-gradient(to top,rgba(230,196,138,0),rgba(230,196,138,.8))}
.hero::before{content:"";position:absolute;width:480px;height:480px;right:-140px;top:-160px;background:radial-gradient(circle,rgba(230,196,138,.16),transparent 68%);pointer-events:none;transform:translate3d(0,calc(var(--scrub,0) * 36px),0)}
#shelf, .month, article.episode{scroll-margin-top:96px}
.shelf-head{margin:36px 0 22px}
.shelf-head h2{margin:0;font-size:clamp(32px,5vw,56px);font-weight:500;letter-spacing:-.03em}
.shelf-head p{margin:8px 0 0;color:var(--muted)}
.library{display:grid;gap:18px}
.timeline{display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.timeline a{color:var(--muted);text-decoration:none;font-family:var(--sans);font-size:13px;letter-spacing:.08em;min-height:44px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid var(--line);border-radius:999px;white-space:nowrap}
.timeline a:hover{color:var(--brass);border-color:rgba(230,196,138,.45)}
.month:target .month-label{color:var(--brass)}
.month+.month{margin-top:34px}
.month-label{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 14px;font-family:var(--sans);font-size:13px;font-weight:500;letter-spacing:.14em;color:var(--muted)}
.grid{display:grid;gap:16px;align-items:start}
.card-shell{position:relative;min-width:0;padding:18px 18px 16px;border-radius:22px;border:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015));box-shadow:0 16px 40px rgba(0,0,0,.2)}
.card-shell::after{content:"";position:absolute;left:18px;right:18px;top:0;height:1px;background:transparent}
article.latest .card-shell::after,article.is-current .card-shell::after{background:rgba(230,196,138,.7)}
article.is-playing .card-shell{border-color:rgba(230,196,138,.45)}
.cover{position:relative;height:108px;margin-bottom:16px;border-radius:16px;overflow:hidden;background:radial-gradient(120px 80px at 28% 40%,rgba(230,196,138,.16),transparent 70%),rgba(255,255,255,.02)}
.cover-shift{position:absolute;inset:0;transform:translate3d(calc(var(--px,0) * -12px),calc(var(--py,0) * -10px),0)}
.wave{position:absolute;inset:20px 78px 20px 16px;display:flex;align-items:center;gap:4px}
.wave span{display:block;flex:1 1 0;height:calc(var(--h) * 1%);min-height:8px;border-radius:99px;background:rgba(243,239,230,.88);transform-origin:center center}
.cover-no{position:absolute;right:10px;bottom:-12px;font-size:72px;line-height:1;color:rgba(243,239,230,.07);font-variant-numeric:tabular-nums;pointer-events:none}
.cat{display:flex;justify-content:space-between;gap:12px;margin:0 0 8px;color:var(--muted);font-family:var(--sans);font-size:12px;letter-spacing:.12em;font-variant-numeric:tabular-nums}
.topic{margin:0;font-size:clamp(22px,2.2vw,30px);font-weight:500;letter-spacing:-.02em;line-height:1.3;overflow-wrap:anywhere}
.when{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;margin:10px 0 0;color:var(--muted);font-family:var(--sans);font-size:13px}
.when .dur::before{content:"·";margin-right:10px;color:#6f675c}
.badge{border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:11px}
.missing{display:none;margin:8px 0 0;color:var(--muted);font-family:var(--sans);font-size:13px}
article.is-unavailable .missing{display:block}
article.is-unavailable .play-card{opacity:.45}
.card-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}
.folio{display:grid;grid-template-rows:1fr}
.folio-inner{overflow:hidden;min-height:0;padding-top:14px}
.kicker{display:block;margin-bottom:6px;font-family:var(--sans);font-size:11px;letter-spacing:.14em;color:var(--brass)}
.synopsis{margin:0 0 14px;max-width:68ch;font-size:15px;line-height:1.75}
.lang-label{margin:0 0 6px;font-family:var(--sans);font-size:12px;letter-spacing:.08em;color:var(--muted)}
.lang-block{margin-top:12px}
.dl-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0 0}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border-radius:999px;border:1px solid var(--line);color:var(--ink);text-decoration:none;font-size:13px}
.link{color:var(--brass);font-size:13px}
.dl-meta,.voice-line{font-family:var(--sans);font-size:12px;color:var(--faint)}
.voice-line{margin:8px 0 0}
.voice-line span{margin-right:8px;letter-spacing:.12em}
details.papers{margin-top:16px;border-top:1px solid var(--line);padding-top:10px}
details.papers summary{cursor:pointer;color:var(--muted);font-family:var(--sans);font-size:13px}
details.papers ul{list-style:none;margin:12px 0 0;padding:0}
details.papers li{margin:12px 0;font-size:15px;line-height:1.5}
details.papers a{color:var(--ink);text-decoration:none;border-bottom:1px solid rgba(230,196,138,.35)}
details.papers a:hover{color:var(--brass)}
details.papers .pdf{margin-left:8px;font-family:var(--sans);font-size:12px;letter-spacing:.06em}
details.papers .meta{display:block;margin-top:3px;color:var(--faint);font-family:var(--sans);font-size:12px}
.papers-empty{color:var(--muted);font-size:13px}
p.empty{border:1px dashed var(--line);border-radius:22px;padding:48px 20px;text-align:center;color:var(--muted)}
p.empty .lmuted{display:block;margin-top:8px;font-size:13px;color:var(--faint)}
footer{margin-top:72px;color:var(--muted);font-family:var(--sans);font-size:13px;line-height:1.85}
footer a{color:var(--ink)}
.feeds{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;margin:10px 0}
.feeds a{color:var(--muted);text-decoration:none;border-bottom:1px solid rgba(230,196,138,.35)}
.feeds .dot{color:#6f675c}
.foot-links{display:flex;gap:16px}
.dock{position:fixed;left:50%;bottom:max(12px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(920px,calc(100% - 24px));z-index:40;display:grid;grid-template-columns:auto minmax(0,1fr) minmax(180px,1.4fr);gap:12px 16px;align-items:center;padding:10px 12px;border-radius:22px;background:rgba(22,19,16,.72);border:1px solid rgba(243,239,230,.12);box-shadow:0 20px 60px rgba(0,0,0,.38);backdrop-filter:blur(22px) saturate(1.25);-webkit-backdrop-filter:blur(22px) saturate(1.25)}
#dock-play{width:52px;height:52px;min-height:52px;padding:0;border-radius:50%;display:grid;place-items:center;background:var(--brass);color:var(--brass-ink)}
#dock-play svg{display:block}
#dock-play .icon-pause{display:none}
#dock-play.is-on .icon-play{display:none}
#dock-play.is-on .icon-pause{display:block}
.dock-meta{min-width:0}
#dock-title,#dock-sub{margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--sans)}
#dock-title{font-size:15px;font-weight:600}
#dock-sub{margin-top:2px;color:var(--muted);font-size:12px}
.dock-transport{display:flex;align-items:center;gap:8px;min-width:0}
.step{min-width:44px;min-height:36px;padding:0 8px;border-radius:999px;border:1px solid rgba(243,239,230,.16);color:var(--ink);font-family:var(--sans);font-size:12px;font-variant-numeric:tabular-nums}
#dock-now,#dock-dur{font-family:var(--sans);font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
#dock-range{flex:1 1 auto;width:auto;min-width:48px;height:28px;margin:0;background:transparent;-webkit-appearance:none;appearance:none;cursor:pointer}
#dock-range::-webkit-slider-runnable-track{height:2px;border-radius:99px;background:linear-gradient(to right,var(--brass) var(--p,0%),rgba(243,239,230,.22) var(--p,0%))}
#dock-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-6px;border:0;border-radius:50%;background:var(--brass)}
#dock-range::-moz-range-track{height:2px;border:0;border-radius:99px;background:linear-gradient(to right,var(--brass) var(--p,0%),rgba(243,239,230,.22) var(--p,0%))}
#dock-range::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:var(--brass)}
#player{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.eq{display:flex;align-items:flex-end;gap:3px;height:16px}
.eq span{display:block;width:2px;height:40%;background:var(--brass);border-radius:99px;transform-origin:bottom}
html:not(.js) .topic-label+.topic-label::before{content:" · ";color:#6f675c}
html.js .lang-block audio{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
html.js .folio{grid-template-rows:0fr;opacity:0}
html.js .episode.is-open .folio{grid-template-rows:1fr;opacity:1}
html.js .episode:not(.is-open) .folio{pointer-events:none}
html.js article.episode.will-rise{opacity:0;transform:translateY(22px)}
html.js article.episode.will-rise.is-in{opacity:1;transform:none}
@media (min-width:860px){.grid{grid-template-columns:1fr 1fr;gap:18px}}
@media (min-width:980px){
  .library{grid-template-columns:120px minmax(0,1fr);column-gap:36px;align-items:start}
  .timeline{position:sticky;top:88px;flex-direction:column;align-items:flex-start;overflow:visible}
  .timeline a{border:0;padding:8px 0;border-radius:0}
}
@media (max-width:720px){
  .wrap,.hero .wrap{width:min(1120px,calc(100% - 28px))}
  .tools-inner{flex-wrap:wrap;padding:8px 0}
  .tabs{width:100%;justify-content:flex-start}
  .tab{min-height:44px}
  .hero .wrap{padding-bottom:188px}
  body{padding-bottom:188px}
  .dock{width:calc(100% - 16px);grid-template-columns:auto minmax(0,1fr);padding:10px;border-radius:18px}
  .dock-transport{grid-column:1 / -1}
  .eq{display:none}
}
@media (hover:hover) and (pointer:fine){
  article.episode:hover .wave span{transform:scaleY(1)}
  article.episode:hover .card-shell{box-shadow:0 24px 50px rgba(0,0,0,.32)}
}
@media (prefers-reduced-motion:no-preference){
  .cover-shift{transition:transform .45s cubic-bezier(.22,1,.36,1)}
  .wave span{transition:transform .55s cubic-bezier(.22,1,.36,1)}
  .wave span:nth-child(3n){transition-delay:40ms}
  .wave span:nth-child(3n+1){transition-delay:90ms}
  .wave span:nth-child(3n+2){transition-delay:140ms}
  html.js .folio{transition:grid-template-rows .45s cubic-bezier(.22,1,.36,1),opacity .3s ease}
  html.js article.episode.will-rise.is-in{transition:opacity .7s ease,transform .7s cubic-bezier(.22,1,.36,1)}
  .grid article.will-rise.is-in:nth-child(2){transition-delay:.05s}
  .grid article.will-rise.is-in:nth-child(3){transition-delay:.1s}
  .grid article.will-rise.is-in:nth-child(4){transition-delay:.15s}
  html.js article.is-playing .wave span{animation:breathe 1.15s ease-in-out infinite alternate;background:var(--brass)}
  html.js article.is-playing .wave span:nth-child(2n){animation-duration:1.45s}
  html.js article.is-playing .wave span:nth-child(3n){animation-delay:.12s}
  html.js article.is-playing .wave span:nth-child(5n){animation-duration:.9s}
  .dock.is-playing .eq span{animation:eq 0.9s ease-in-out infinite alternate}
  .dock.is-playing .eq span:nth-child(2){animation-delay:.12s;height:70%}
  .dock.is-playing .eq span:nth-child(3){animation-delay:.04s;height:100%}
  .dock.is-playing .eq span:nth-child(4){animation-delay:.18s;height:55%}
  .solid:active,.ghost:active,.tab:active,#dock-play:active,.step:active{transform:translateY(1px) scale(.98)}
  @media (hover:hover) and (pointer:fine){
    html.js article.episode.is-in:hover .card-shell,html.js article.episode:not(.will-rise):hover .card-shell{transform:translateY(-8px);transition:transform .45s cubic-bezier(.22,1,.36,1),box-shadow .45s ease}
  }
}
@keyframes breathe{from{transform:scaleY(.35)}to{transform:scaleY(1)}}
@keyframes eq{from{transform:scaleY(.4)}to{transform:scaleY(1)}}
@media (prefers-reduced-motion:reduce){
  html.js article.episode.will-rise{opacity:1!important;transform:none!important}
  .hero-wave,.hero::before,.cover-shift,.card-shell,.wave span,.eq span{animation:none!important;transition:none!important;transform:none!important}
  html.js .folio{transition:none}
}
@media (prefers-reduced-transparency:reduce){
  .tools,.dock{background:#16130f;backdrop-filter:none;-webkit-backdrop-filter:none}
}
@media (forced-colors:active){
  .solid,#dock-play,.tab.is-active{background:ButtonFace;color:ButtonText;forced-color-adjust:none}
  .wave span,.hero-wave span,.eq span{background:CanvasText}
}
@media (max-width:560px){
  .card-shell{padding:16px 14px 14px}
}
`;
}

function libraryScript() {
  return `(function () {
  var root = document.documentElement;
  var latestCard = document.querySelector("article.latest");
  if (latestCard) {
    latestCard.classList.add("is-open");
    var latestFolio = latestCard.querySelector(".folio");
    if (latestFolio) latestFolio.removeAttribute("inert");
    var latestOpener = latestCard.querySelector(".open-card");
    if (latestOpener) latestOpener.setAttribute("aria-expanded", "true");
  }
  var reduce = root.getAttribute("data-reduce") === "1";
  var tabs = [].slice.call(document.querySelectorAll(".tab[data-lang-tab]"));
  var currentLang = tabs[0] ? tabs[0].getAttribute("data-lang-tab") : "ja";
  var playingLang = null;
  var currentArticle = null;
  var player = document.getElementById("player");
  var playBtn = document.getElementById("dock-play");
  var titleEl = document.getElementById("dock-title");
  var subEl = document.getElementById("dock-sub");
  var nowEl = document.getElementById("dock-now");
  var durEl = document.getElementById("dock-dur");
  var range = document.getElementById("dock-range");
  var statusEl = document.getElementById("dock-status");
  var dock = document.getElementById("dock");
  var scrubbing = false;
  var painting = false;

  function nodes() {
    return [].slice.call(document.querySelectorAll("[data-lang]"));
  }
  function labelFor(lang) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute("data-lang-tab") === lang) return (tabs[i].textContent || "").replace(/\\s+/g, " ").trim();
    }
    return lang || "";
  }
  function apply(lang) {
    currentLang = lang;
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute("data-lang-tab") === lang;
      tabs[i].classList.toggle("is-active", on);
      tabs[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    nodes().forEach(function (el) {
      var active = el.getAttribute("data-lang") === lang;
      el.classList.toggle("is-active", active);
      el.hidden = !active;
    });
    try { sessionStorage.setItem("oto-lang", lang); } catch (err) {}
  }
  function srcFor(article, lang) {
    if (!article) return "";
    var block = article.querySelector('.lang-block[data-lang="' + lang + '"] audio');
    return block ? (block.getAttribute("src") || "") : "";
  }
  function refreshAvailability() {
    var cards = document.querySelectorAll("article.episode");
    for (var i = 0; i < cards.length; i++) {
      var ok = !!srcFor(cards[i], currentLang);
      cards[i].classList.toggle("is-unavailable", !ok);
      var btn = cards[i].querySelector("[data-play]");
      if (btn) btn.disabled = !ok;
    }
  }
  function visibleTopic(article) {
    var labels = article.querySelectorAll(".topic-label");
    for (var i = 0; i < labels.length; i++) {
      if (!labels[i].hidden) return labels[i].textContent || "";
    }
    return labels[0] ? labels[0].textContent || "" : "";
  }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function paintCards() {
    var buttons = document.querySelectorAll("[data-play]");
    for (var i = 0; i < buttons.length; i++) {
      var article = buttons[i].closest("article");
      var on = !!(article && article.classList.contains("is-playing"));
      buttons[i].textContent = on ? "停止" : "聴く";
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  function markCurrent() {
    var cards = document.querySelectorAll("article.episode");
    var playing = player && !player.paused && !player.ended;
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("is-current", cards[i] === currentArticle);
      cards[i].classList.toggle("is-playing", cards[i] === currentArticle && playing);
    }
    if (dock) dock.classList.toggle("is-playing", !!playing);
    if (playBtn) {
      playBtn.classList.toggle("is-on", !!playing);
      playBtn.setAttribute("aria-label", playing ? "一時停止" : "再生");
    }
    paintCards();
  }
  function setDock(article) {
    if (!article || !titleEl) return;
    titleEl.textContent = visibleTopic(article) || "音の図書館";
    var time = article.querySelector("time");
    var date = time ? time.getAttribute("datetime") || "" : "";
    if (subEl) subEl.textContent = [date, labelFor(playingLang || currentLang)].filter(Boolean).join(" · ");
    markCurrent();
  }
  function paintTimes() {
    if (!player) return;
    painting = true;
    var dur = player.duration;
    var cur = player.currentTime || 0;
    if (nowEl) nowEl.textContent = fmt(cur);
    if (durEl) durEl.textContent = isFinite(dur) ? fmt(Math.round(dur)) : "0:00";
    if (range) {
      if (!scrubbing && isFinite(dur) && dur > 0) range.value = String(Math.round((cur / dur) * 1000));
      var p = isFinite(dur) && dur > 0 ? (cur / dur) * 100 : 0;
      range.style.setProperty("--p", p.toFixed(2) + "%");
      range.setAttribute("aria-valuenow", range.value);
      range.setAttribute("aria-valuetext", fmt(cur));
    }
    markCurrent();
    painting = false;
  }
  function seekTo(at) {
    if (typeof at !== "number" || !isFinite(at) || !player) return;
    var dur = player.duration;
    var next = isFinite(dur) ? Math.min(Math.max(0, at), Math.max(0, dur - 0.05)) : Math.max(0, at);
    try { player.currentTime = next; } catch (err) {}
  }
  function publishSession() {
    if (!player || !("mediaSession" in navigator) || !currentArticle) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (titleEl && titleEl.textContent) || "音の図書館",
        artist: "Phantomresearch Daily",
        album: (subEl && subEl.textContent) || "音の図書館"
      });
      navigator.mediaSession.playbackState = player.paused ? "paused" : "playing";
    } catch (err) {}
  }
  function playSrc(src, article, at, shouldPlay, lang) {
    if (!src || !player) return;
    currentArticle = article;
    playingLang = lang || currentLang;
    var same = player.getAttribute("data-src") === src && player.readyState > 0;
    player.setAttribute("data-src", src);
    setDock(article);
    var started = false;
    var applyTime = function () {
      if (started) return;
      started = true;
      if (typeof at === "number") seekTo(at);
      if (shouldPlay === false) player.pause();
      paintTimes();
      publishSession();
    };
    if (!same) player.addEventListener("loadedmetadata", applyTime, { once: true });
    if (!same) player.src = src;
    if (shouldPlay !== false) {
      var pending = player.play();
      if (pending && pending.catch) pending.catch(function () {
        if (statusEl) statusEl.textContent = "再生できませんでした。";
      });
    }
    if (same || typeof at !== "number") applyTime();
  }
  function toggleArticle(article, lang) {
    var use = lang || currentLang;
    var src = srcFor(article, use);
    if (!src) return;
    if (currentArticle === article && player && player.getAttribute("data-src") === src && !player.paused) {
      player.pause();
      return;
    }
    var resume = currentArticle === article && player && player.getAttribute("data-src") === src ? player.currentTime : undefined;
    playSrc(src, article, resume, true, use);
  }
  function setOpen(card, open) {
    if (!card) return;
    card.classList.toggle("is-open", !!open);
    var opener = card.querySelector(".open-card");
    if (opener) opener.setAttribute("aria-expanded", open ? "true" : "false");
    var folio = card.querySelector(".folio");
    if (folio) {
      if (open) folio.removeAttribute("inert");
      else folio.setAttribute("inert", "");
    }
  }
  function anchorCard() {
    var cards = document.querySelectorAll("article.episode");
    var best = null;
    var bestDist = Infinity;
    var mid = window.innerHeight * 0.4;
    for (var i = 0; i < cards.length; i++) {
      var rect = cards[i].getBoundingClientRect();
      if (rect.bottom < 80 || rect.top > window.innerHeight) continue;
      var dist = Math.abs(rect.top - mid);
      if (dist < bestDist) { bestDist = dist; best = cards[i]; }
    }
    return best;
  }
  function switchLang(lang) {
    if (!lang || lang === currentLang) return;
    var anchor = anchorCard();
    var anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
    var time = player && player.getAttribute("data-src") ? (player.currentTime || 0) : 0;
    var wasPlaying = !!(player && player.getAttribute("data-src") && !player.paused);
    var article = currentArticle;
    apply(lang);
    refreshAvailability();
    if (anchor && anchorTop !== null) {
      var delta = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 1) window.scrollBy(0, delta);
    }
    if (!player || !article || !player.getAttribute("data-src")) return;
    var src = srcFor(article, lang);
    if (!src || src === player.getAttribute("data-src")) {
      setDock(article);
      return;
    }
    playSrc(src, article, time, wasPlaying, lang);
  }
  function firstPlayable() {
    var cards = document.querySelectorAll("article.episode");
    for (var i = 0; i < cards.length; i++) if (srcFor(cards[i], currentLang)) return cards[i];
    return null;
  }

  var saved = "";
  try { saved = sessionStorage.getItem("oto-lang") || ""; } catch (err) {}
  var initial = "";
  for (var t = 0; t < tabs.length; t++) {
    if (tabs[t].getAttribute("data-lang-tab") === saved) initial = saved;
  }
  if (!initial && tabs[0]) initial = tabs[0].getAttribute("data-lang-tab");
  if (initial) apply(initial);
  refreshAvailability();
  [].slice.call(document.querySelectorAll(".lang-block audio")).forEach(function (audio) {
    audio.setAttribute("aria-hidden", "true");
    audio.tabIndex = -1;
  });
  for (var b = 0; b < tabs.length; b++) {
    tabs[b].addEventListener("click", function () { switchLang(this.getAttribute("data-lang-tab")); });
  }
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var play = target.closest("[data-play]");
    if (play) {
      var played = play.closest("article");
      if (played) toggleArticle(played);
      return;
    }
    var opener = target.closest(".open-card");
    if (opener) {
      var card = opener.closest("article");
      setOpen(card, !(card && card.classList.contains("is-open")));
      return;
    }
    if (target.closest("a, button, summary, audio, input")) return;
    var surface = target.closest(".ep-head, .cover");
    if (surface) setOpen(surface.closest("article"), !surface.closest("article").classList.contains("is-open"));
  });
  var listen = document.getElementById("listen");
  if (listen) listen.addEventListener("click", function () {
    var card = firstPlayable();
    if (!card) return;
    setOpen(card, true);
    toggleArticle(card);
    card.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  });
  if (player) {
    player.addEventListener("timeupdate", paintTimes);
    player.addEventListener("durationchange", paintTimes);
    player.addEventListener("play", function () {
      paintTimes();
      if (statusEl) statusEl.textContent = "再生中。" + ((titleEl && titleEl.textContent) || "");
      publishSession();
    });
    player.addEventListener("pause", function () {
      paintTimes();
      if (statusEl && player.ended) return;
      if (statusEl) statusEl.textContent = "一時停止";
      publishSession();
    });
    player.addEventListener("waiting", function () { if (dock) dock.classList.add("is-busy"); });
    player.addEventListener("playing", function () { if (dock) dock.classList.remove("is-busy"); });
    player.addEventListener("ended", function () {
      paintTimes();
      var cards = [].slice.call(document.querySelectorAll("article.episode"));
      var start = cards.indexOf(currentArticle);
      var use = playingLang || currentLang;
      for (var i = start + 1; i < cards.length; i++) {
        if (!srcFor(cards[i], use)) continue;
        toggleArticle(cards[i], use);
        if (!reduce) cards[i].scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    });
    if (playBtn) playBtn.addEventListener("click", function () {
      if (!player.getAttribute("data-src")) {
        var card = firstPlayable();
        if (card) toggleArticle(card);
        return;
      }
      if (player.paused) {
        var again = player.play();
        if (again && again.catch) again.catch(function () {
          if (statusEl) statusEl.textContent = "再生できませんでした。";
        });
      } else player.pause();
    });
    var back = document.getElementById("dock-back");
    var fwd = document.getElementById("dock-fwd");
    if (back) back.addEventListener("click", function () {
      if (!player.getAttribute("data-src")) return;
      player.currentTime = Math.max(0, (player.currentTime || 0) - 15);
    });
    if (fwd) fwd.addEventListener("click", function () {
      if (!player.getAttribute("data-src")) return;
      var dur = isFinite(player.duration) ? player.duration : (player.currentTime || 0) + 15;
      player.currentTime = Math.min(dur, (player.currentTime || 0) + 15);
    });
    if (range) {
      range.addEventListener("pointerdown", function () { scrubbing = true; });
      window.addEventListener("pointerup", function () { scrubbing = false; });
      range.addEventListener("change", function () { scrubbing = false; });
      range.addEventListener("input", function () {
        if (painting) return;
        if (!isFinite(player.duration) || !player.duration) return;
        player.currentTime = (Number(range.value) / 1000) * player.duration;
        paintTimes();
      });
    }
    if ("mediaSession" in navigator && navigator.mediaSession.setActionHandler) {
      try {
        navigator.mediaSession.setActionHandler("play", function () { if (playBtn) playBtn.click(); });
        navigator.mediaSession.setActionHandler("pause", function () { player.pause(); });
        navigator.mediaSession.setActionHandler("seekbackward", function () { if (back) back.click(); });
        navigator.mediaSession.setActionHandler("seekforward", function () { if (fwd) fwd.click(); });
      } catch (err) {}
    }
  }
  document.addEventListener("keydown", function (event) {
    var key = event.key;
    if (key === "Escape") {
      var openCards = document.querySelectorAll("article.is-open");
      for (var i = 0; i < openCards.length; i++) setOpen(openCards[i], false);
      return;
    }
    if (key !== " " && event.code !== "Space") return;
    var tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "button" || tag === "a" || tag === "summary") return;
    if (!player) return;
    event.preventDefault();
    if (playBtn) playBtn.click();
  });
  if (!reduce) {
    var cards = document.querySelectorAll("article.episode");
    for (var c = 0; c < cards.length; c++) {
      (function (card) {
        card.addEventListener("pointermove", function (event) {
          if (event.pointerType && event.pointerType !== "mouse") return;
          var rect = card.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          card.style.setProperty("--px", ((event.clientX - rect.left) / rect.width - 0.5).toFixed(3));
          card.style.setProperty("--py", ((event.clientY - rect.top) / rect.height - 0.5).toFixed(3));
        });
        card.addEventListener("pointerleave", function () {
          card.style.setProperty("--px", "0");
          card.style.setProperty("--py", "0");
        });
      })(cards[c]);
    }
    var ticking = false;
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var hero = document.querySelector(".hero");
        var limit = hero && hero.offsetHeight ? hero.offsetHeight : window.innerHeight;
        var p = Math.max(0, Math.min(1, window.scrollY / limit));
        root.style.setProperty("--scrub", p.toFixed(4));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          entries[i].target.classList.add("is-in");
          io.unobserve(entries[i].target);
        }
      }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
      for (var n = 0; n < cards.length; n++) {
        cards[n].classList.add("will-rise");
        io.observe(cards[n]);
      }
    }
  }
  var hashId = (location.hash || "").replace(/^#/, "");
  if (hashId) {
    var hashed = document.getElementById(hashId);
    if (hashed && hashed.classList.contains("episode")) setOpen(hashed, true);
  }
})();`;
}

function secondSubtitle(config) {
  if (typeof config?.subtitle?.de === "string" && config.subtitle.de.trim()) return { lang: "de", text: config.subtitle.de.trim() };
  if (typeof config?.subtitle?.es === "string" && config.subtitle.es.trim()) return { lang: "es", text: config.subtitle.es.trim() };
  if (typeof config?.subtitle?.zh === "string" && config.subtitle.zh.trim()) return { lang: "zh", text: config.subtitle.zh.trim() };
  return { lang: "en", text: "" };
}

export function buildIndexHtml(episodeEntries, config, languages) {
  languages = (languages ?? (config?.languages ?? [])).filter(Boolean);
  const title = escapeHtml(config?.title ?? "Phantomresearch Daily");
  const subtitleJa = escapeHtml(config?.subtitle?.ja ?? "");
  const second = secondSubtitle(config);
  const subtitleSecond = escapeHtml(second.text);
  const views = episodeEntries.map((entry) => episodeView(entry, config, languages));
  const covered = languages.filter((lang) => views.some((view) => view.audio[lang]));
  const tabs = covered
    .map((lang) => `<button type="button" class="tab" data-lang-tab="${escapeHtml(lang)}">${escapeHtml(langLabel(config, lang))}</button>`)
    .join("");
  const feedRows = languages
    .map((lang) => `<a href="feed-${escapeHtml(lang)}.xml">${escapeHtml(LANG_DEFAULTS.rss[lang] ?? `RSS (${lang})`)}</a>`)
    .join(`<span class="dot">·</span>`);
  const navigation = covered.length > 0 ? `<nav class="tabs" aria-label="Language">${tabs}</nav>` : "";
  const description = escapeHtml(["毎日の arXiv を、六つの言語で聴く。", config?.subtitle?.ja].filter(Boolean).join(" "));
  const heroSeed = views[0]?.date || "library";
  const chips = [
    views.length ? `<span class="chip">${views.length} 冊</span>` : "",
    `<span class="chip">${languages.length} 言語</span>`,
    `<span class="chip">arXiv</span>`,
  ].filter(Boolean).join("");
  const listen = views.length ? `<button type="button" class="solid" id="listen">今日の回を聴く</button>` : "";
  const body = views.length === 0
    ? `<p class="empty" id="shelf" tabindex="-1">まだエピソードはありません。<span class="lmuted">No episodes yet — try <code>node scripts/podcast/daily.mjs</code>.</span></p>`
    : `<div class="shelf-head" id="shelf" tabindex="-1"><h2>書架</h2><p>新しい順に、一日一冊。</p></div>\n${shelfHtml(episodeEntries, config, languages)}`;
  const dock = views.length === 0 ? "" : `
<div class="dock" id="dock">
  <button type="button" id="dock-play" aria-label="再生">
    <svg class="icon-play" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5.2v13.6L19 12z"></path></svg>
    <svg class="icon-pause" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 5h4.2v14H6zm7.8 0H18v14h-4.2z"></path></svg>
  </button>
  <div class="dock-meta">
    <p id="dock-title">音の図書館</p>
    <p id="dock-sub">再生は、棚を歩いても続きます</p>
  </div>
  <div class="dock-transport">
    <button type="button" class="step" id="dock-back" aria-label="15秒戻る">−15</button>
    <span id="dock-now">0:00</span>
    <input id="dock-range" type="range" min="0" max="1000" value="0" step="1" aria-label="再生位置" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="0">
    <span id="dock-dur">0:00</span>
    <button type="button" class="step" id="dock-fwd" aria-label="15秒進む">+15</button>
    <span class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span>
  </div>
  <audio id="player" preload="none"></audio>
  <p class="sr" id="dock-status" aria-live="polite"></p>
</div>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0c0b09">
<meta name="description" content="${description}">
<title>${title} — 音の図書館</title>
<style>${libraryCss()}</style>
<script>document.documentElement.classList.add("js");try{if(matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.setAttribute("data-reduce","1")}catch(e){}</script>
</head>
<body>
<a class="skip" href="#shelf">書架へ</a>
<div class="tools"><div class="wrap tools-inner"><a class="brand" href="#top">音の図書館</a>${navigation}</div></div>
<header class="hero" id="top">
  <div class="wrap">
    <p class="eyebrow">${title}</p>
    <h1>音の図書館</h1>
    <p class="lede">毎日の arXiv を、<br>六つの言語で聴く。</p>
    <p class="sub">${subtitleJa}</p>
    ${subtitleSecond ? `<p class="sub-alt" lang="${escapeHtml(second.lang)}">${subtitleSecond}</p>` : ""}
    <p class="lede-en" lang="en">Daily arXiv briefs, shelved as sound.</p>
    <div class="hero-actions">${listen}<a class="ghost" href="#shelf">書架を歩く</a></div>
    <div class="chips">${chips}</div>
  </div>
  <div class="hero-wave" aria-hidden="true">${waveHtml(heroSeed, 40)}</div>
</header>
<main>
  <div class="wrap">
${body}
  </div>
</main>
<footer><div class="wrap">
  <p>出典は arXiv。各論文のライセンスに従います。音声はローカルで生成しています。</p>
  <nav class="feeds" aria-label="RSS">${feedRows}</nav>
  <p class="foot-links"><a href="episodes.json">episodes.json</a><a href="https://github.com/RyoSAKu610/researchphantom-daily">GitHub</a></p>
</div></footer>
${dock}
<script>${libraryScript()}</script>
</body>
</html>
`;
}

// ---- audio/transcript copying --------------------------------------------------------

async function copyIfPresent(src, dest) {
  try {
    await copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
}

// Copy every usable mp3 plus its transcript into podcast-site/episodes/<date>/
// so the output folder is self-contained. episode.json entries claiming audio
// whose file is missing on disk are demoted ("failed") so no page, feed or
// JSON entry ever references a dead URL. Each language is handled
// independently so one broken file cannot drop the other languages.
// Exported for tests (they exercise builders against the same post-copy state
// that buildSite produces).
export async function copyEpisodeAssets(entry, episodeRoot, languages, outDir, log = () => {}) {
  const { dirName, episodeObject, langEntries } = entry;
  const episodeDir = join(episodeRoot, dirName);
  const targetDir = join(outDir, "episodes", episodeObject.date);
  await mkdir(targetDir, { recursive: true });
  for (const lang of languages) {
    const langEntry = langEntries?.[lang];
    if (!langEntry) continue;
    // Transcript first: independent of the audio status.
    const scriptName = typeof langEntry.text === "string" && langEntry.text.trim() ? langEntry.text.trim() : `script-${lang}.txt`;
    if (await copyIfPresent(join(episodeDir, scriptName), join(targetDir, scriptName))) {
      langEntry.scriptFile = scriptName;
    }
    const claimed = langEntry.status === "ok" && typeof langEntry.audio === "string" && langEntry.audio.trim();
    if (!claimed) continue;
    const src = join(episodeDir, `${lang}.mp3`);
    try {
      const info = await stat(src);
      langEntry.observedBytes = info.size;
      await copyFile(src, join(targetDir, `${lang}.mp3`));
    } catch {
      log(`warning: ${episodeObject.date}: ${lang}.mp3 is listed in episode.json but missing on disk; the item is hidden`);
      langEntry.status = "failed";
      langEntry.audio = null;
      langEntry.error = "audio file missing on disk";
    }
  }
}

// ---- assembly ---------------------------------------------------------------------

export async function buildSite(options = {}) {
  const {
    projectRoot = fileURLToPath(new URL("../..", import.meta.url)),
    episodeRoot = null,
    outDir = null,
    config = null,
    baseUrl,
    env = process.env,
    log = () => {},
  } = options;
  const cfg = config ?? (await loadConfig());
  const languages = (Array.isArray(cfg.languages) ? cfg.languages : []).map((lang) => String(lang));
  const root = episodeRoot ?? join(projectRoot, cfg.episodeDir);
  const target = outDir ?? join(projectRoot, "podcast-site");
  // An explicit "" opts out of absolute URLs (relative/preview mode).
  const base = baseUrl === undefined ? pickBaseUrl(cfg, env) : resolveBaseUrl(baseUrl);

  await rm(target, { recursive: true, force: true });
  const episodeEntries = await loadEpisodes(root);
  for (const entry of episodeEntries) {
    await copyEpisodeAssets(entry, root, languages, target, log);
  }
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "index.html"), buildIndexHtml(episodeEntries, cfg, languages), "utf8");
  for (const lang of languages) {
    await writeFile(join(target, `feed-${lang}.xml`), buildFeedXml(lang, episodeEntries, cfg, base), "utf8");
  }
  await writeJsonAtomic(join(target, "episodes.json"), buildEpisodesJson(episodeEntries, cfg, base, languages));
  log(`site: ${episodeEntries.length} episode(s) in ${languages.join(",")} -> ${target}${base ? ` (${base})` : " (relative URLs)"}`);
  return {
    outDir: target,
    baseUrl: base,
    episodeCount: episodeEntries.length,
    languages,
    feeds: languages.map((lang) => `feed-${lang}.xml`),
  };
}

export async function main(env = process.env) {
  try {
    const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
    const config = await loadConfig();
    const override = String(env?.PODCAST_SITE_DIR ?? "").trim();
    await buildSite({
      projectRoot,
      config,
      outDir: override || join(projectRoot, "podcast-site"),
      env,
      log: (message) => console.log(message),
    });
    return 0;
  } catch (error) {
    console.error(`site.mjs: ${error?.stack ?? error}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`site.mjs: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
