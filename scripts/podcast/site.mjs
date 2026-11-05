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
// No dependencies beyond Node builtins. index.html inlines site/library.css
// and site/library.js (the "音の図書館" UI); its only external request is
// Google Fonts, which degrades to local system fonts when unavailable.
// Base URL contract (pickBaseUrl): absolute URLs are used in RSS enclosures
// and episodes.json; index.html always writes relative paths so a local
// preview straight off the filesystem simply works.
import { readFileSync } from "node:fs";
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
//
// "音の図書館" (The Sound Library): every episode is a book on a shelf. The
// page is fully server-rendered (hero, shelf of spines, feeds and a plain
// archive of every episode with native <audio> players), so it works without
// JavaScript. library.js then upgrades it: an interactive sound-field hero,
// a reading-room dialog per book, a searchable card catalog of every paper
// and a persistent mini player. All episode data the script needs is
// embedded as JSON, so the page makes no extra requests besides audio,
// transcripts (on demand) and web fonts.

const LIB_CSS = readFileSync(new URL("./site/library.css", import.meta.url), "utf8");
const LIB_JS = readFileSync(new URL("./site/library.js", import.meta.url), "utf8");
const FONTS_URL = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=IBM+Plex+Mono:wght@400;500&family=Shippori+Mincho:wght@500;700&display=swap";

// Cloth colours for the book spines (top, bottom of the gradient).
const SPINE_CLOTH = [
  ["#6b2424", "#3a1010"], // oxblood
  ["#24452f", "#0f2117"], // forest
  ["#22325a", "#0d162b"], // navy
  ["#7a5418", "#3e2808"], // ochre
  ["#4f2647", "#230e20"], // plum
  ["#1d4a4c", "#0b2324"], // teal
  ["#3b404b", "#191c22"], // slate
  ["#5d3b27", "#2b190e"], // umber
  ["#5c1a36", "#2a0816"], // wine
  ["#4a5222", "#22260c"], // moss
  ["#2e2c60", "#12112c"], // indigo
  ["#7a3519", "#3a1408"], // rust
];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// FNV-1a: deterministic per-topic variation (colour, height) without Math.random.
function hash32(value) {
  let h = 0x811c9dc5;
  for (const ch of String(value)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Visual length of a label on a vertical spine: CJK glyphs stand upright and
// take a full em, sideways Latin/Cyrillic letters roughly 0.58em.
export function spineLength(label) {
  let len = 0;
  for (const ch of String(label ?? "")) {
    len += /[　-鿿豈-﫿＀-￯]/.test(ch) ? 1 : ch === " " ? 0.3 : 0.58;
  }
  return Math.max(1, Math.round(len * 10) / 10);
}

// Font size (px) that fits a spine label: one vertical column when it fits
// at a readable size, otherwise two columns. library.js mirrors this when
// the visitor switches languages.
export function spineFontSize(label, height, width) {
  const len = spineLength(label);
  const avail = height - 118;
  const one = avail / len;
  const size = one >= 12.5
    ? Math.min(19, one)
    : Math.min(16, avail / Math.ceil(len / 2), (width - 10) / 2 / 1.18);
  return Math.max(10, Math.floor(size * 10) / 10);
}

function totalSeconds(view) {
  return Object.values(view.audio).reduce((sum, audio) => sum + (Number(audio?.durationSeconds) || 0), 0);
}

function clock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

// Book identity for every episode: number (oldest = 1), cloth, spine size.
export function bookLayout(views) {
  const books = [];
  let previous = -1;
  for (const [index, view] of views.entries()) {
    const h = hash32(view.topicId || view.date);
    let cloth = h % SPINE_CLOTH.length;
    if (cloth === previous) cloth = (cloth + 5) % SPINE_CLOTH.length; // no twin neighbours
    previous = cloth;
    const minutes = totalSeconds(view) / 60;
    books.push({
      no: views.length - index,
      cloth: SPINE_CLOTH[cloth],
      height: 238 + ((h >>> 8) % 56) + Math.min(8, view.papers.length),
      width: Math.round(44 + Math.min(20, minutes / 3.2)),
      lean: (h >>> 16) % 9 === 0 ? ((h >>> 20) % 2 ? "lean-l" : "lean-r") : "",
    });
  }
  return books;
}

function weekday(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? "" : WEEKDAYS[parsed.getUTCDay()];
}

// JSON for library.js. `<` is escaped so the payload can never close the
// surrounding <script> element.
export function libraryData(views, books, config, languages, covered) {
  const data = {
    title: config?.title ?? "Phantomresearch Daily",
    languages: covered,
    allLanguages: languages,
    labels: Object.fromEntries(languages.map((lang) => [lang, langLabel(config, lang)])),
    episodes: views.map((view, index) => ({
      no: books[index].no,
      date: view.date,
      day: weekday(view.date),
      topicId: view.topicId,
      labels: view.topicLabels,
      cloth: books[index].cloth,
      papers: view.papers.map((paper) => ({
        id: paper?.arxivId ?? "",
        title: String(paper?.title ?? "").trim(),
        authors: Array.isArray(paper?.authors) ? paper.authors : [],
        cat: paper?.primaryCategory ?? "",
        published: paper?.published ?? "",
        url: typeof paper?.url === "string" && paper.url ? paper.url : paper?.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : "",
        // Abstracts are fetched lazily from episodes.json (keeps the page light).
        ex: String(paper?.excerpt ?? "").trim() ? 1 : 0,
      })),
      notes: view.notes,
      audio: Object.fromEntries(covered.filter((lang) => view.audio[lang]).map((lang) => {
        const audio = view.audio[lang];
        return [lang, {
          path: audio.path,
          dur: audio.durationSeconds,
          bytes: audio.bytes,
          script: audio.scriptPath,
          file: audioFileName(config, view.date, lang),
        }];
      })),
    })),
  };
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function paperListHtml(view) {
  if (view.papers.length === 0) {
    return `<p class="papers-empty">${escapeHtml("この回の収録論文データはありません / No paper metadata.")}</p>`;
  }
  const items = view.papers.map((paper) => {
    const title = String(paper?.title ?? "").trim();
    const url = typeof paper?.url === "string" && paper.url ? paper.url : paper?.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : null;
    const meta = [
      paper?.arxivId ? `arXiv:${escapeHtml(paper.arxivId)}` : "",
      paper?.published ? escapeHtml(paper.published) : "",
    ].filter(Boolean).join(" · ");
    const titleHtml = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
      : escapeHtml(title);
    return `<li>${titleHtml}${meta ? `<span class="meta">${meta}</span>` : ""}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

function langBlockHtml(view, lang, config) {
  if (!view.audio[lang]) return ""; // unavailable language: render nothing at all
  const audio = view.audio[lang];
  const details = [formatBytes(audio.bytes), audio.durationSeconds ? clock(audio.durationSeconds) : ""]
    .filter(Boolean).join(" · ");
  return [
    `      <div class="lang-block" data-lang="${escapeHtml(lang)}">`,
    `        <p class="lang-label">${escapeHtml(langLabel(config, lang))}</p>`,
    `        <audio controls preload="none" src="${escapeHtml(audio.path)}"></audio>`,
    `        <p class="dl-row">`,
    `          <a class="btn" href="${escapeHtml(audio.path)}" download="${escapeHtml(audioFileName(config, view.date, lang))}">${escapeHtml(LANG_DEFAULTS.download[lang] ?? "Download (MP3)")}</a>`,
    audio.scriptPath ? `          <a class="link" href="${escapeHtml(audio.scriptPath)}">${escapeHtml(LANG_DEFAULTS.transcript[lang] ?? "Transcript")}</a>` : null,
    details ? `          <span class="dl-meta">${escapeHtml(details)}</span>` : null,
    `        </p>`,
    `      </div>`,
  ].filter((line) => line !== null).join("\n");
}

function episodeArticleHtml(view, config, languages, latest) {
  const topicSpans = languages
    .map((lang) => `<span class="topic-label" data-lang="${escapeHtml(lang)}">${escapeHtml(view.topicLabels[lang])}</span>`)
    .join("");
  const blocks = languages.map((lang) => langBlockHtml(view, lang, config)).join("\n");
  const badge = view.source === "curated" ? "curated" : view.source === "arxiv" ? "arXiv" : escapeHtml(view.source || "—");
  return [
    `  <article class="episode${latest ? " latest" : ""}" id="ep-${escapeHtml(view.date)}">`,
    "    <header class=\"ep-head\">",
    `      <h3 class="topic">${topicSpans}</h3>`,
    `      <p class="when"><time datetime="${escapeHtml(view.date)}">${escapeHtml(view.date)}</time> <span class="badge">${badge}</span></p>`,
    "    </header>",
    blocks,
    `    <details class="papers"${latest ? " open" : ""}>`,
    `      <summary>${escapeHtml("収録論文")}</summary>`,
    `      ${paperListHtml(view)}`,
    "    </details>",
    "  </article>",
  ].join("\n");
}

function spineHtml(view, book, lang, latest) {
  const label = view.topicLabels[lang] ?? view.topicId;
  const [c1, c2] = book.cloth;
  const style = `--c1:${c1};--c2:${c2};--h:${book.height};--w:${book.width};--fs:${spineFontSize(label, book.height, book.width)}`;
  const aria = `No.${book.no} ${view.date} ${label}`;
  return [
    `      <a class="spine${book.lean ? ` ${book.lean}` : ""}${latest ? " is-new" : ""}" href="#ep-${escapeHtml(view.date)}" data-i="${book.no}" style="${style}" aria-label="${escapeHtml(aria)}">`,
    `        <i class="band t"></i><i class="band t2"></i><i class="band b"></i><i class="band b2"></i>`,
    `        <span class="spine-no">${book.no}</span>`,
    `        <span class="spine-title">${escapeHtml(label)}</span>`,
    `        <span class="spine-date">${escapeHtml(view.date.slice(5).replace("-", "."))}</span>`,
    `      </a>`,
  ].join("\n");
}

function shelfHtml(views, books, lang) {
  const parts = [];
  let month = "";
  for (const [index, view] of views.entries()) {
    const key = view.date.slice(0, 7);
    if (key !== month) {
      month = key;
      const [year, mm] = key.split("-");
      parts.push(`      <div class="bookend" aria-hidden="true"><i></i><b>${escapeHtml(String(Number(mm)))}</b><span>${escapeHtml(`${MONTHS[Number(mm) - 1] ?? ""} ${year}`)}</span></div>`);
    }
    parts.push(spineHtml(view, books[index], lang, index === 0));
  }
  return parts.join("\n");
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 4.6v14.8a1 1 0 0 0 1.52.85l12.1-7.4a1 1 0 0 0 0-1.7L9.02 3.75A1 1 0 0 0 7.5 4.6z"/></svg>',
  rss: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/><circle cx="5.5" cy="18.5" r="1.5" fill="currentColor" stroke="none"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  arrowL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  arrowR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  books: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h4v16H4zM10 4h4v16h-4zM16.2 4.6l3.8 1 -3.6 14.8-3.8-1z"/></svg>',
};
const BRAND_MARK = '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7e8c2"/><stop offset=".55" stop-color="#c9a061"/><stop offset="1" stop-color="#f0d9a6"/></linearGradient></defs><rect x="5" y="6" width="5" height="20" rx="1" fill="url(#bm)"/><rect x="12" y="4" width="5" height="22" rx="1" fill="url(#bm)" opacity=".75"/><path d="M20 8.5c3 2 4.5 4.6 4.5 7.5s-1.5 5.5-4.5 7.5" fill="none" stroke="url(#bm)" stroke-width="2" stroke-linecap="round"/><path d="M20 12.5c1.4 1 2 2.2 2 3.5s-.6 2.5-2 3.5" fill="none" stroke="url(#bm)" stroke-width="2" stroke-linecap="round" opacity=".6"/></svg>';
const FAVICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0c0a08"/><rect x="7" y="7" width="5" height="18" rx="1" fill="#e3c583"/><rect x="14" y="5" width="5" height="20" rx="1" fill="#c9a061"/><path d="M22 10c2.2 1.6 3.3 3.6 3.3 6s-1.1 4.4-3.3 6" fill="none" stroke="#e3c583" stroke-width="2" stroke-linecap="round"/></svg>');

function statementHtml(languageCount) {
  // Words light up one by one as the visitor scrolls (library.js).
  const words = [
    ["毎朝6:30、"], ["arXivに"], ["届いたばかりの"], ["論文を、"], [`${languageCount}つの声で。`],
    ["読むかわりに、"], ["聴く。"], ["ここは、"], ["音の", "gold"], ["図書館", "gold"], ["です。"],
  ];
  return words.map(([word, cls]) => `<span class="w${cls ? ` ${cls}` : ""}">${escapeHtml(word)}</span>`).join("");
}

export function buildIndexHtml(episodeEntries, config, languages) {
  languages = (languages ?? (config?.languages ?? [])).filter(Boolean);
  const titleText = config?.title ?? "Phantomresearch Daily";
  const title = escapeHtml(titleText);
  const subtitleJa = escapeHtml(config?.subtitle?.ja ?? "");
  const views = episodeEntries.map((entry) => episodeView(entry, config, languages));
  const books = bookLayout(views);

  // A language tab exists only when at least one episode ships that language.
  const covered = languages.filter((lang) => views.some((view) => view.audio[lang]));
  const uiLang = covered.includes("ja") ? "ja" : covered[0] ?? languages[0] ?? "ja";
  const tabs = covered
    .map((lang) => `<button type="button" class="tab${lang === uiLang ? " is-active" : ""}" data-lang-tab="${escapeHtml(lang)}" aria-pressed="${lang === uiLang}" title="${escapeHtml(langLabel(config, lang))}">${escapeHtml(lang.toUpperCase())}</button>`)
    .join("");
  const navigation = covered.length > 0 ? `<nav class="tabs" aria-label="Language">${tabs}</nav>` : "";

  // Library-wide numbers for the stats band.
  const paperIds = new Set();
  for (const view of views) for (const paper of view.papers) paperIds.add(paper?.arxivId || paper?.title);
  const hours = views.reduce((sum, view) => sum + totalSeconds(view), 0) / 3600;

  const latest = views[0] ?? null;
  const latestBook = books[0] ?? null;
  const latestLabel = latest ? latest.topicLabels[uiLang] ?? latest.topicId : "";
  const latestAudio = latest ? latest.audio[uiLang] ?? covered.map((lang) => latest.audio[lang]).find(Boolean) : null;
  const latestVoices = latest ? covered.filter((lang) => latest.audio[lang]).length : 0;
  const altLabels = latest ? covered.filter((lang) => lang !== uiLang).map((lang) => latest.topicLabels[lang]).filter(Boolean) : [];

  const hero = latest ? `
  <section class="hero" id="today" aria-label="今日の一冊">
    <canvas class="hero-canvas" aria-hidden="true"></canvas>
    <div class="hero-inner">
      <p class="eyebrow rise"><span>No.${latestBook.no}</span><i class="sep"></i><time datetime="${escapeHtml(latest.date)}">${escapeHtml(latest.date.replaceAll("-", "."))} ${escapeHtml(weekday(latest.date))}</time><i class="sep"></i><span>Today's volume</span></p>
      <p class="hero-kicker rise d1">今日の一冊</p>
      <h1 class="hero-title rise d2"><span class="foil" data-hero-title>${escapeHtml(latestLabel)}</span></h1>
      <p class="hero-alt rise d3" data-hero-alt aria-hidden="true"><span>${escapeHtml(altLabels[0] ?? "")}</span></p>
      <div class="hero-row rise d4">
        <button type="button" class="play-xl js-only" data-hero-play aria-label="今日の回を再生">
          <svg class="ring" viewBox="0 0 88 88" aria-hidden="true"><circle class="track" cx="44" cy="44" r="42"/><circle class="bar" cx="44" cy="44" r="42"/></svg>
          <span class="ico" data-ico>${ICONS.play}</span>
        </button>
        <div class="hero-meta">
          <strong>${latestAudio?.durationSeconds ? `${Math.round(latestAudio.durationSeconds / 60)} min` : "—"} · ${latest.papers.length} papers · ${latestVoices} voices</strong>
          <span>${title} — ${subtitleJa}</span>
          <span class="resume" data-hero-resume hidden></span>
        </div>
        <div class="hero-links">
          <a class="pill js-only" href="#ep-${escapeHtml(latest.date)}" data-open-book="${latestBook.no}">${ICONS.books}本をひらく</a>
          <a class="pill no-js-only" href="#ep-${escapeHtml(latest.date)}">${ICONS.books}今日の回へ</a>
          <a class="pill" href="#stacks">書架をみる</a>
        </div>
      </div>
    </div>
    <span class="scroll-cue" aria-hidden="true"></span>
  </section>` : `
  <section class="hero" id="today" aria-label="${title}">
    <canvas class="hero-canvas" aria-hidden="true"></canvas>
    <div class="hero-inner">
      <p class="eyebrow rise"><span>The sound library</span></p>
      <h1 class="hero-title rise d2"><span class="foil">${title}</span></h1>
      <p class="hero-alt rise d3">${subtitleJa}</p>
    </div>
  </section>`;

  const stats = [
    [views.length, 0, "", "所蔵エピソード", "Volumes"],
    [paperIds.size, 0, "", "収録論文", "Papers"],
    [Math.round(hours * 10) / 10, 1, "h", "音声の総量", "Hours of audio"],
    [covered.length, 0, "", "ナレーションの言語", "Voices"],
  ].map(([n, dec, unit, ja, en]) => `<div class="stat"><div class="stat-n"><span data-count="${n}" data-dec="${dec}">${dec ? Number(n).toFixed(dec) : n}</span>${unit ? `<sup>${unit}</sup>` : ""}</div><div class="stat-l">${ja}<span>${en}</span></div></div>`).join("");

  const shelf = views.length === 0
    ? `  <p class="empty">まだエピソードはありません。<span class="lmuted">No episodes yet — try <code>node scripts/podcast/daily.mjs</code>.</span></p>`
    : `  <div class="shelf-outer" data-reveal>
    <div class="shelf" data-shelf>
${shelfHtml(views, books, uiLang)}
      <div class="bookend" aria-hidden="true"><i></i><b>No.1</b><span>The first volume</span></div>
    </div>
    <div class="shelf-board"></div><div class="shelf-glow"></div>
  </div>
  <div class="wrap shelf-hint js-only"><span>← 新しい巻</span><span class="shelf-progress"><i data-shelf-thumb></i></span><span>古い巻 →</span></div>`;

  const feedCards = languages.map((lang) => `<div class="feed"><div class="feed-name">${escapeHtml(langLabel(config, lang))}<small>feed-${escapeHtml(lang)}.xml</small></div><div class="feed-actions"><button type="button" class="js-only" data-copy="feed-${escapeHtml(lang)}.xml" aria-label="${escapeHtml(`${langLabel(config, lang)} の RSS URL をコピー`)}">${ICONS.copy}</button><a href="feed-${escapeHtml(lang)}.xml" aria-label="${escapeHtml(LANG_DEFAULTS.rss[lang] ?? `RSS (${lang})`)}">${ICONS.rss}</a></div></div>`).join("\n      ");

  const articles = views.map((view, index) => episodeArticleHtml(view, config, languages, index === 0)).join("\n");

  return `<!doctype html>
<html lang="ja" data-lang="${escapeHtml(uiLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${subtitleJa}">
<meta name="theme-color" content="#0c0a08">
<meta property="og:title" content="${title} — 音の図書館">
<meta property="og:description" content="${subtitleJa}">
<meta property="og:type" content="website">
<title>${title} — 音の図書館</title>
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS_URL}">
${covered.map((lang) => `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(channelTitle(config, lang))}" href="feed-${escapeHtml(lang)}.xml">`).join("\n")}
<script>document.documentElement.classList.add("js")</script>
<style>
${LIB_CSS}</style>
</head>
<body>
<header class="nav" data-nav>
  <div class="wrap">
    <a class="brand" href="#today" aria-label="${title}">${BRAND_MARK}<span class="brand-name">Phantom<em>research</em> Daily</span></a>
    <nav class="nav-links" aria-label="Sections"><a href="#today">今日</a><a href="#stacks">書架</a><a class="js-only" href="#catalog">目録</a><a href="#subscribe">購読</a></nav>
    ${navigation}
  </div>
</header>
<main>
${hero}

  <section class="statement" aria-label="About">
    <div class="statement-sticky"><div class="wrap"><p data-statement>${statementHtml(covered.length || languages.length)}</p></div></div>
  </section>

  <section class="wrap" aria-label="Library in numbers"><div class="stats" data-reveal>${stats}</div></section>

  <section class="section" id="stacks" aria-labelledby="stacks-title">
    <div class="wrap sec-head" data-reveal>
      <div><p class="sec-no">01 — The stacks</p><h2 class="sec-title" id="stacks-title">書架<small>Every morning, a new volume.</small></h2></div>
      <div class="stacks-tools js-only"><button type="button" class="icon-btn" data-shelf-prev aria-label="新しい巻へ">${ICONS.arrowL}</button><button type="button" class="icon-btn" data-shelf-next aria-label="古い巻へ">${ICONS.arrowR}</button></div>
    </div>
${shelf}
  </section>

  <section class="section wrap js-only" id="catalog" aria-labelledby="catalog-title">
    <div class="sec-head" data-reveal>
      <div><p class="sec-no">02 — Card catalog</p><h2 class="sec-title" id="catalog-title">目録<small>Search every paper we have read aloud.</small></h2></div>
      <p class="sec-lede">収録したすべての論文をカードにしました。タイトル・著者・分野・テーマで探せます。カードを選ぶと、その論文が収められた巻がひらきます。</p>
    </div>
    <div class="catalog-bar">
      <label class="search">${ICONS.search}<input type="search" data-search placeholder="論文・著者・分野・テーマを検索" autocomplete="off" aria-label="論文を検索"><kbd>/</kbd></label>
    </div>
    <div class="chips" data-chips></div>
    <p class="catalog-count" data-count-label></p>
    <div class="cards" data-cards></div>
    <div class="more"><button type="button" class="pill" data-more hidden>さらに表示</button></div>
  </section>

  <section class="section wrap" id="subscribe" aria-labelledby="subscribe-title">
    <div class="sec-head" data-reveal>
      <div><p class="sec-no">03 — Subscribe</p><h2 class="sec-title" id="subscribe-title">購読<small>Take the library with you.</small></h2></div>
      <p class="sec-lede">お使いのポッドキャストアプリに RSS を登録すると、毎朝の新しい巻が自動で届きます。言語ごとに別のフィードです。</p>
    </div>
    <div class="feeds-grid" data-reveal="2">
      ${feedCards}
    </div>
  </section>

  <section class="archive wrap" id="archive" aria-label="Archive">
    <h2 class="sec-title">全エピソード<small>Episodes</small></h2>
${articles}
  </section>
</main>

<footer class="foot">
  <div class="wrap foot-grid">
    <div><div class="foot-mark">Phantom<em>research</em><br>Daily</div><p>${subtitleJa}<br>arXiv の新着論文から毎朝テーマを選び、各言語の短いブリーフとしてお届けする、音の図書館です。</p></div>
    <div><h4>Colophon</h4><p>出典: arXiv（各論文のライセンスに従います）・音声はローカル生成です。台本は抄録のみをもとにした要約で、内容の評価は行いません。</p></div>
    <div><h4>Data</h4><p>機械可読一覧: <a href="episodes.json">episodes.json</a><br>RSS: ${languages.map((lang) => `<a href="feed-${escapeHtml(lang)}.xml">${escapeHtml(lang)}</a>`).join(" · ")}</p><p class="kbd-hint js-only"><kbd>Space</kbd>再生/停止 <kbd>←</kbd><kbd>→</kbd>15秒 <kbd>/</kbd>検索</p></div>
  </div>
</footer>

<div class="room" id="room" role="dialog" aria-modal="true" aria-label="閲覧室" hidden>
  <div class="room-scrim" data-close></div>
  <div class="book" data-book></div>
</div>

<div class="player" data-player aria-label="プレーヤー" role="region">
  <button type="button" class="pl-book" data-pl-open aria-label="この巻をひらく"></button>
  <div class="pl-mid">
    <div class="pl-line"><span class="pl-lang" data-pl-lang></span><span class="pl-title" data-pl-title></span><span class="pl-time" data-pl-time>0:00</span></div>
    <canvas class="pl-wave" data-pl-wave aria-label="再生位置" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></canvas>
  </div>
  <div class="pl-ctrls">
    <button type="button" class="pl-btn skip" data-pl-back aria-label="15秒戻る"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/><text x="12" y="15.4" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">15</text></svg></button>
    <button type="button" class="pl-btn main" data-pl-toggle aria-label="再生">${ICONS.play}</button>
    <button type="button" class="pl-btn skip" data-pl-fwd aria-label="30秒進む"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/><text x="12" y="15.4" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">30</text></svg></button>
    <button type="button" class="pl-btn pl-rate" data-pl-rate aria-label="再生速度">1×</button>
    <button type="button" class="pl-btn pl-x" data-pl-close aria-label="プレーヤーを閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>
</div>
<div class="toast" data-toast role="status" aria-live="polite"></div>

<script type="application/json" id="library-data">${libraryData(views, books, config, languages, covered)}</script>
<script>
${LIB_JS}</script>
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
