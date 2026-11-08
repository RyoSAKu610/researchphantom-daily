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
// No dependencies beyond Node builtins. The library UI (音の図書館) lives in
// site-ui/ and is inlined into index.html, so the page has zero external
// requests and the deploy output set stays index + feeds + JSON.
// Base URL contract (pickBaseUrl): absolute URLs are used in RSS enclosures
// and episodes.json; index.html always writes relative paths so a local
// preview straight off the filesystem simply works.
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./daily.mjs";
import { isValidISODate, readJson, writeJsonAtomic } from "./select.mjs";
import { renderLibraryPage } from "./site-ui/render.mjs";

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
// deploy, so the library UI (scripts/podcast/site-ui) is inlined by
// renderLibraryPage. RSS, episodes.json and the relative audio paths stay
// on the same contract as before. Engine names that are just "edge"
// (retired third-party TTS) are omitted; irodori / voicestudio / qwen still
// show as quiet metadata when the episode recorded them.

const REPO_URL = "https://github.com/RyoSAKu610/researchphantom-daily";

function formatClock(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remain = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remain}` : `${minutes}:${remain}`;
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

function secondSubtitle(config) {
  if (typeof config?.subtitle?.de === "string" && config.subtitle.de.trim()) return { lang: "de", text: config.subtitle.de.trim() };
  if (typeof config?.subtitle?.es === "string" && config.subtitle.es.trim()) return { lang: "es", text: config.subtitle.es.trim() };
  if (typeof config?.subtitle?.zh === "string" && config.subtitle.zh.trim()) return { lang: "zh", text: config.subtitle.zh.trim() };
  return { lang: "en", text: "" };
}

function paperModel(paper) {
  const id = typeof paper?.arxivId === "string" && paper.arxivId.trim()
    ? paper.arxivId.trim()
    : typeof paper?.id === "string" ? paper.id.trim() : "";
  const title = String(paper?.title ?? "").trim();
  const url = typeof paper?.url === "string" && paper.url.trim()
    ? paper.url.trim()
    : id ? `https://arxiv.org/abs/${id}` : "";
  const pdf = typeof paper?.pdfUrl === "string" && paper.pdfUrl.trim()
    ? paper.pdfUrl.trim()
    : typeof paper?.pdf === "string" ? paper.pdf.trim() : "";
  const authors = Array.isArray(paper?.authors) ? paper.authors.map((name) => String(name).trim()).filter(Boolean) : [];
  const category = typeof paper?.primaryCategory === "string" && paper.primaryCategory.trim()
    ? paper.primaryCategory.trim()
    : typeof paper?.category === "string" ? paper.category.trim() : "";
  const published = typeof paper?.published === "string" ? paper.published.trim() : "";
  const abstract = typeof paper?.excerpt === "string" && paper.excerpt.trim()
    ? paper.excerpt.trim()
    : typeof paper?.abstract === "string" ? paper.abstract.trim() : "";
  return { id, title, url, pdf, authors, category, published, abstract };
}

function synopsisOf(papers) {
  const paper = papers.find((item) => item.abstract);
  if (paper) {
    let text = paper.abstract.replace(/\s+/g, " ").trim();
    const max = 200;
    if (text.length > max) {
      const slice = text.slice(0, max);
      const stop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("。"));
      text = `${(stop > 90 ? slice.slice(0, stop + 1) : slice).trim()}…`;
    }
    return text;
  }
  return papers.map((item) => item.title).filter(Boolean).slice(0, 2).join(" / ");
}

function voiceOf(audio, engine) {
  const parts = [];
  if (engine && !/edge|neural/i.test(engine)) parts.push(engine);
  const voice = typeof audio?.voice === "string" ? audio.voice.trim() : "";
  if (voice && !/edge|neural/i.test(voice)) parts.push(voice);
  return parts.join(" · ");
}

function libraryModel(episodeEntries, config, languages) {
  const views = episodeEntries.map((entry) => episodeView(entry, config, languages));
  const episodes = views.map((view, index) => {
    const papers = (Array.isArray(view.papers) ? view.papers : []).map(paperModel);
    const engines = enginesFromNotes(view.notes);
    const audio = {};
    for (const lang of languages) {
      const item = view.audio[lang];
      if (!item) continue;
      const duration = Number.isFinite(Number(item.durationSeconds)) ? Number(item.durationSeconds) : null;
      audio[lang] = {
        src: item.path,
        bytes: item.bytes,
        size: formatBytes(item.bytes),
        duration,
        clock: formatClock(duration),
        script: item.scriptPath || "",
        file: audioFileName(config, view.date, lang),
        voice: voiceOf(item, engines[lang]),
      };
    }
    return {
      date: view.date,
      no: index + 1,
      latest: index === 0,
      source: view.source || "",
      topicId: view.topicId,
      topic: view.topicLabels,
      papers,
      synopsis: synopsisOf(papers),
      audio,
    };
  });
  return {
    title: String(config?.title ?? "Phantomresearch Daily").trim() || "Phantomresearch Daily",
    subtitleJa: typeof config?.subtitle?.ja === "string" ? config.subtitle.ja.trim() : "",
    second: secondSubtitle(config),
    repoUrl: REPO_URL,
    languages: languages.map((lang) => ({
      code: lang,
      label: langLabel(config, lang),
      covered: episodes.some((episode) => episode.audio[lang]),
      rss: `feed-${lang}.xml`,
      rssLabel: LANG_DEFAULTS.rss[lang] ?? `RSS (${lang})`,
      downloadLabel: LANG_DEFAULTS.download[lang] ?? "Download (MP3)",
      transcriptLabel: LANG_DEFAULTS.transcript[lang] ?? "Transcript",
    })),
    episodes,
  };
}

export function buildIndexHtml(episodeEntries, config, languages) {
  languages = (languages ?? (config?.languages ?? [])).filter(Boolean);
  return renderLibraryPage(libraryModel(episodeEntries, config, languages));
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
