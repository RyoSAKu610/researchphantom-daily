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
// No dependencies beyond Node builtins. The generated HTML embeds all CSS and
// the tiny language switcher, so the page has zero external dependencies.
// Base URL contract (pickBaseUrl): absolute URLs are used in RSS enclosures
// and episodes.json; index.html always writes relative paths so a local
// preview straight off the filesystem simply works.
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./daily.mjs";
import { isValidISODate, readJson, writeJsonAtomic } from "./select.mjs";

const LANG_DEFAULTS = {
  labels: { ja: "日本語", en: "English", zh: "中文", ko: "한국어" },
  download: { ja: "ダウンロード（MP3）", en: "Download (MP3)", zh: "下载（MP3）", ko: "다운로드 (MP3)" },
  transcript: { ja: "スクリプト", en: "Transcript", zh: "文稿", ko: "대본" },
  rss: { ja: "RSS（日本語）", en: "RSS (English)", zh: "RSS（中文）", ko: "RSS (한국어)" },
  itemDescription: {
    ja: (label, count) => `テーマ「${label}」。論文${count}件。`,
    en: (label, count) => `Topic: ${label}. ${count} papers.`,
    zh: (label, count) => `主题「${label}」·论文${count}篇。`,
    ko: (label, count) => `주제 "${label}" · 논문 ${count}편.`,
  },
  channelSuffix: { ja: "（{label}）", en: " ({label})", zh: "（{label}）", ko: " ({label})" },
};

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
  const describer = LANG_DEFAULTS.itemDescription[lang] ?? LANG_DEFAULTS.itemDescription.en;
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
  const subtitle = config?.subtitle?.[lang] ?? config?.subtitle?.en ?? config?.title ?? "";
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
    `    <language>${escapeXml(lang)}</language>`,
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
  const details = [formatBytes(audio.bytes), formatDuration(audio.durationSeconds) ? `${formatDuration(audio.durationSeconds)}s` : ""]
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

function episodeArticleHtml(entry, config, languages, latest) {
  const view = episodeView(entry, config, languages);
  const topicSpans = languages
    .map((lang) => `<span class="topic-label" data-lang="${escapeHtml(lang)}">${escapeHtml(view.topicLabels[lang])}</span>`)
    .join("");
  const blocks = languages.map((lang) => langBlockHtml(view, lang, config)).join("\n");
  const badge = view.source === "curated" ? "curated" : view.source === "arxiv" ? "arXiv" : escapeHtml(view.source || "—");
  return [
    `  <article class="episode${latest ? " latest" : ""}" id="ep-${escapeHtml(view.date)}">`,
    "    <header class=\"ep-head\">",
    `      <h2 class="topic">${topicSpans}</h2>`,
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

export function buildIndexHtml(episodeEntries, config, languages) {
  languages = (languages ?? (config?.languages ?? [])).filter(Boolean);
  const title = escapeHtml(config?.title ?? "Phantomresearch Daily");
  const subtitleJa = escapeHtml(config?.subtitle?.ja ?? "");
  const subtitleEn = escapeHtml(config?.subtitle?.en ?? "");
  const views = episodeEntries.map((entry) => episodeView(entry, config, languages));

  // A language tab exists only when at least one episode ships that language.
  const covered = languages.filter((lang) => views.some((view) => view.audio[lang]));
  const tabs = covered
    .map((lang) => `<button type="button" class="tab" data-lang-tab="${escapeHtml(lang)}">${escapeHtml(langLabel(config, lang))}</button>`)
    .join("\n      ");
  const feedRows = languages
    .map((lang) => `<a href="feed-${escapeHtml(lang)}.xml">${escapeHtml(LANG_DEFAULTS.rss[lang] ?? `RSS (${lang})`)}</a>`)
    .join(`<span class="dot">·</span>`);
  const articles = views.map((view, index) => episodeArticleHtml(episodeEntries[index], config, languages, index === 0)).join("\n");
  const navigation = covered.length > 0 ? `<nav class="tabs" aria-label="Language">\n      ${tabs}\n    </nav>\n` : "";
  const body = views.length === 0
    ? `  <p class="empty">まだエピソードはありません。<span class="lmuted">No episodes yet — try <code>node scripts/podcast/daily.mjs</code>.</span></p>`
    : articles;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${subtitleJa}">
<title>${title}</title>
<style>
:root{--ink:#15100c;--line:rgba(227,197,131,.22);--cream:#f6efdf;--muted:#b8a98d;--gold:#e3c583;--dark:#1a1410;--radius:14px}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background-color:var(--ink);color:var(--cream);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Noto Sans SC","Noto Sans KR",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:32px 20px 56px}
header.hero{padding-bottom:24px;border-bottom:1px solid var(--line)}
.hero h1{margin:0;font-size:clamp(28px,6vw,40px);font-weight:800;letter-spacing:.01em;background:linear-gradient(115deg,#f5e5bd 0%,#e3c583 38%,#b58a45 72%,#ecd8a4 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .sub{margin:8px 0 0;color:var(--muted);font-size:14px}
.hero .sub-en{margin:2px 0 0;color:#8e8168;font-size:13px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.chip{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 10px;color:var(--muted)}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 4px}
.tab{cursor:pointer;font:inherit;font-size:13px;background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 14px}
.tab:hover{color:var(--cream);border-color:rgba(227,197,131,.45)}
.tab.is-active{background:linear-gradient(135deg,#f0d9a6 0%,#e3c583 45%,#c99b52 100%);color:var(--dark);border-color:transparent;font-weight:600}
.feeds{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 0;font-size:13px;color:var(--muted)}
.feeds a{color:var(--muted);text-decoration:none;border-bottom:1px solid var(--line);padding-bottom:1px}
.feeds a:hover{color:var(--gold)}
.feeds .dot{color:#5b4f3c}
h2.section{font-size:13px;font-weight:600;color:var(--muted);letter-spacing:.14em;text-transform:uppercase;margin:28px 0 8px}
article.episode{margin:18px 0;padding:20px 20px 16px;border:1px solid var(--line);border-radius:var(--radius);background:linear-gradient(160deg,rgba(255,255,255,.04),rgba(255,255,255,.015))}
article.episode.latest{border-color:rgba(227,197,131,.35)}
.ep-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
.ep-head .topic{margin:0;font-size:19px;font-weight:700}
.topic-label+.topic-label::before{content:"·";margin:0 6px 0 2px;color:#5b4f3c;font-weight:400}
.ep-head .when{margin:0;color:var(--muted);font-size:13px;display:flex;gap:10px;align-items:center}
.badge{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}
.lang-block{margin-top:18px}
.lang-label{margin:0 0 6px;font-size:12px;color:var(--muted);letter-spacing:.08em}
audio{display:block;width:100%;height:40px}
.dl-row{display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;margin:10px 0 0}
.btn{display:inline-block;text-decoration:none;background:linear-gradient(135deg,#f0d9a6 0%,#e3c583 45%,#c99b52 100%);color:var(--dark);font-size:13px;font-weight:600;border-radius:10px;padding:8px 16px;transition:transform .3s cubic-bezier(.22,1,.36,1)}
.btn:hover{transform:translateY(-1px)}
.link{font-size:13px;color:var(--muted)}
.dl-meta{font-size:12px;color:#8e8168}
details.papers{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}
details.papers summary{cursor:pointer;color:var(--muted);font-size:13px}
details.papers ul{list-style:none;margin:12px 0 0;padding:0}
details.papers li{margin:10px 0;font-size:14px}
details.papers a{color:var(--cream);text-decoration:none;border-bottom:1px solid var(--line)}
details.papers a:hover{color:var(--gold);border-color:var(--gold)}
details.papers .meta{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.papers-empty{color:var(--muted);font-size:13px;margin:10px 0 0}
p.empty{border:1px dashed var(--line);border-radius:var(--radius);padding:32px 20px;text-align:center;color:var(--muted)}
p.empty .lmuted{display:block;font-size:13px;color:#8e8168;margin-top:6px}
p.empty code{font-size:11px}
footer{max-width:760px;margin:0 auto;padding:0 20px 48px;color:var(--muted);font-size:12px;line-height:1.9}
footer a{color:var(--muted)}
@media (max-width:560px){
  main{padding:24px 14px 40px}
  footer{padding-left:14px;padding-right:14px}
  article.episode{padding:16px 14px 12px}
  .dl-row{gap:10px}
}
</style>
</head>
<body>
<main>
  <header class="hero">
    <h1>${title}</h1>
    <p class="sub">${subtitleJa}</p>
    <p class="sub-en">${subtitleEn}</p>
    <div class="chips"><span class="chip">毎日テーマが変わる</span><span class="chip">4 languages</span><span class="chip">ローカル生成音声</span></div>
    ${navigation}<nav class="feeds" aria-label="RSS feeds">${feedRows}</nav>
  </header>
  <h2 class="section">エピソード / Episodes</h2>
${body}
</main>
<footer>出典: arXiv（各論文のライセンスに従います）・音声はローカル生成です。機械可読一覧: <a href="episodes.json">episodes.json</a></footer>
<script>(function(){var html=document.documentElement;if(!html||!html.classList)return;html.classList.add("js");var tabs=[].slice.call(document.querySelectorAll(".tab[data-lang-tab]"));if(!tabs.length)return;function apply(lang){tabs.forEach(function(tab){tab.classList.toggle("is-active",tab.getAttribute("data-lang-tab")===lang)});[].slice.call(document.querySelectorAll("[data-lang]")).forEach(function(el){var active=el.getAttribute("data-lang")===lang;el.classList.toggle("is-active",active);el.hidden=!active;});if(!document.querySelector("[data-lang].is-active")){tabs[0]&&tabs[0].classList.add("is-active")}}for(var i=0;i<tabs.length;i++)tabs[i].addEventListener("click",function(){apply(this.getAttribute("data-lang-tab"))});apply(tabs[0].getAttribute("data-lang-tab"));})();</script>
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
