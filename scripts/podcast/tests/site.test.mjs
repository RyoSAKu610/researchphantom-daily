// Site builder tests: fixture episodes in a temp dir, no network, no real
// config.json. Covers episode scanning, RSS/XML shape + absolute enclosure
// URLs, episodes.json, index.html contract (per-language play/download,
// missing languages hidden), asset copying, relative-URL mode, empty
// input, dead-audio demotion and byte-identical rebuilds (idempotency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableLanguages,
  audioFileName,
  buildEpisodesJson,
  buildFeedXml,
  buildIndexHtml,
  buildSite,
  channelTitle,
  copyEpisodeAssets,
  escapeHtml,
  escapeXml,
  joinUrl,
  langLabel,
  loadEpisodes,
  pickBaseUrl,
  rfc822Date,
  resolveBaseUrl,
  slugify,
} from "../site.mjs";

const TOPIC = { id: "diffusion-models", labels: { ja: "拡散モデル「&」", zh: "扩散模型", de: "Diffusionsmodelle", es: "Modelos de difusión", ru: "Диффузионные модели", it: "Modelli di diffusione" } };
const PAPERS = [
  {
    arxivId: "2410.12345",
    title: "A Study & <Review>",
    authors: ["Alice Example"],
    primaryCategory: "cs.LG",
    published: "2026-10-15",
    url: "https://arxiv.org/abs/2410.12345",
    pdfUrl: "https://arxiv.org/pdf/2410.12345",
    excerpt: "short excerpt",
  },
];
const CONFIG = {
  title: "Phantomresearch Daily",
  subtitle: { ja: "毎日変わる研究テーマを、6言語で少しだけ。", de: "Ein anderes Forschungsthema jeden Tag, kurz, in sechs Sprachen." },
  languages: ["ja", "zh", "de", "es", "ru", "it"],
  languageLabels: { ja: "日本語", zh: "中文", de: "Deutsch", es: "Español", ru: "Русский", it: "Italiano" },
  episodeDir: "podcast/episodes",
  stateDir: "podcast/state",
};
const BASE_URL = "https://feed.example.com/pd";
const LANG_ENTRY = (lang, extra = {}) => ({
  label: CONFIG.languageLabels[lang],
  status: "ok",
  text: `script-${lang}.txt`,
  audio: `${lang}.mp3`,
  durationSeconds: 91.2,
  bytes: 2048,
  sha256: null,
  voice: "voice-" + lang,
  error: null,
  ...extra,
});

function makeEpisode(date, languages, papers = PAPERS) {
  return {
    version: 1,
    date,
    topic: TOPIC,
    source: "arxiv",
    generatedAt: `${date}T09:00:00+09:00`,
    papers,
    languages,
    notes: [],
  };
}

// Fixture: ep1 = ja/de/es/it ok with files, zh failed (no audio), ru claims ok
// but its mp3 is missing on disk; ep2 = ja ok only, others absent entirely.
async function makeFixture(root) {
  const episodeRoot = join(root, "episodes");
  const ep1 = join(episodeRoot, "2026-10-18");
  const ep2 = join(episodeRoot, "2026-10-17");
  await mkdir(ep1, { recursive: true });
  await mkdir(ep2, { recursive: true });
  await writeFile(join(ep1, "episode.json"), JSON.stringify(makeEpisode("2026-10-18", {
    ja: LANG_ENTRY("ja"),
    zh: { label: "中文", status: "failed", text: "script-zh.txt", audio: null, durationSeconds: null, bytes: null, sha256: null, voice: "serena", error: "synthesis failed" },
    de: LANG_ENTRY("de"),
    es: LANG_ENTRY("es"),
    ru: LANG_ENTRY("ru"),
    it: LANG_ENTRY("it"),
  })), "utf8");
  await writeFile(join(ep1, "ja.mp3"), Buffer.from("ja-audio-ep1"));
  await writeFile(join(ep1, "de.mp3"), Buffer.from("de-audio-ep1"));
  await writeFile(join(ep1, "es.mp3"), Buffer.from("es-audio-ep1"));
  await writeFile(join(ep1, "it.mp3"), Buffer.from("it-audio-ep1"));
  await writeFile(join(ep1, "script-ja.txt"), "ja transcript");
  // ru.mp3 intentionally absent; script-zh.txt intentionally absent.
  await writeFile(join(ep2, "episode.json"), JSON.stringify(makeEpisode("2026-10-17", { ja: { ...LANG_ENTRY("ja"), bytes: 4096 } })), "utf8");
  await writeFile(join(ep2, "ja.mp3"), Buffer.from("ja-audio-ep2"));
  // Not an episode at all: skipped silently.
  await mkdir(join(episodeRoot, "broken-dir"), { recursive: true });
  await writeFile(join(episodeRoot, "broken-dir", "episode.json"), "not json", "utf8");
  return { episodeRoot };
}

async function hashTree(dir) {
  const result = {};
  const walk = async (current, prefix = "") => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), rel);
        continue;
      }
      result[rel] = createHash("sha256").update(await readFile(join(current, entry.name))).digest("hex");
    }
  };
  await walk(dir);
  return result;
}

// ---- helpers --------------------------------------------------------------------

test("url helpers: resolveBaseUrl sanitizes, joinUrl joins or goes relative", () => {
  assert.equal(resolveBaseUrl("https://example.com/site//"), "https://example.com/site");
  assert.equal(resolveBaseUrl(" http://a.b "), "http://a.b");
  assert.equal(resolveBaseUrl("ftp://x"), "");
  assert.equal(resolveBaseUrl(""), "");
  assert.equal(resolveBaseUrl(null), "");
  assert.equal(joinUrl(BASE_URL, "episodes/2026-10-18/ja.mp3"), `${BASE_URL}/episodes/2026-10-18/ja.mp3`);
  assert.equal(joinUrl("", "episodes/x.mp3"), "episodes/x.mp3");
});

test("pickBaseUrl honors env override, site.baseUrl, then legacy siteBaseUrl", () => {
  assert.equal(pickBaseUrl({ site: { baseUrl: "https://a" } }, {}), "https://a");
  assert.equal(pickBaseUrl({ site: { baseUrl: "" } }, {}), "");
  // "site" present means authoritative even when empty (relative preview mode).
  assert.equal(pickBaseUrl({ site: {}, siteBaseUrl: "http://legacy" }, {}), "");
  assert.equal(pickBaseUrl({ siteBaseUrl: "http://legacy/" }, {}), "http://legacy");
  assert.equal(pickBaseUrl({ siteBaseUrl: "http://legacy" }, { PODCAST_SITE_BASE_URL: "https://env" }), "https://env");
  assert.equal(pickBaseUrl({}, { PODCAST_SITE_BASE_URL: "  " }), "");
  assert.equal(pickBaseUrl({ site: { baseUrl: "x" } }, { PODCAST_SITE_BASE_URL: "javascript:" }), "");
});

test("escaping covers entities used in titles and XML attributes", () => {
  assert.equal(escapeHtml('A & <B> "c" \'d\''), "A &amp; &lt;B&gt; &quot;c&quot; &#39;d&#39;");
  assert.equal(escapeXml("x&<"), "x&amp;&lt;");
  assert.equal(slugify("Phantomresearch Daily."), "phantomresearch-daily");
  assert.equal(slugify(""), "phantomresearch-daily");
  assert.equal(audioFileName(CONFIG, "2026-10-18", "ja"), "phantomresearch-daily-2026-10-18-ja.mp3");
  assert.equal(channelTitle(CONFIG, "ja"), "Phantomresearch Daily（日本語）");
  assert.equal(channelTitle(CONFIG, "de"), "Phantomresearch Daily (Deutsch)");
  assert.equal(langLabel({}, "it"), "Italiano");
  assert.match(rfc822Date("2026-10-18"), /GMT$/);
  assert.match(rfc822Date("2026-10-18", "2026-10-17T09:00:00+09:00"), /^Sat, 17 Oct 2026 00:00:00 GMT$/);
});

test("loadEpisodes sorts newest first and skips broken directories", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-site-scan-"));
  try {
    const { episodeRoot } = await makeFixture(tmp);
    const entries = await loadEpisodes(episodeRoot);
    assert.deepEqual(entries.map(({ episodeObject }) => episodeObject.date), ["2026-10-18", "2026-10-17"]);
    assert.deepEqual(await loadEpisodes(join(tmp, "missing")), []);
    const entry = entries[0];
    assert.deepEqual(availableLanguages(entry.langEntries, CONFIG.languages), ["ja", "de", "es", "ru", "it"]);
    assert.deepEqual(availableLanguages({}, CONFIG.languages), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("buildFeedXml: absolute enclosures, guid, language tag, per-language item filtering", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-site-feed-"));
  try {
    const { episodeRoot } = await makeFixture(tmp);
    const entries = await loadEpisodes(episodeRoot);
    // Same demotion phase buildSite runs: ru's claimed-but-missing mp3 fails.
    for (const entry of entries) await copyEpisodeAssets(entry, episodeRoot, CONFIG.languages, join(tmp, "copy0"), () => {});
    const jaFeed = buildFeedXml("ja", entries, CONFIG, BASE_URL);
    assert.ok(jaFeed.includes(`https://feed.example.com/pd/episodes/2026-10-18/ja.mp3`), jaFeed);
    assert.ok(jaFeed.includes('enclosure url="https://feed.example.com/pd/episodes/2026-10-18/ja.mp3"'));
    assert.ok(jaFeed.includes('length="2048"'));
    assert.ok(jaFeed.includes('isPermaLink="true">https://feed.example.com/pd/episodes/2026-10-18/ja.mp3'));
    assert.ok(jaFeed.includes("<language>ja</language>"));
    assert.ok(jaFeed.includes("Phantomresearch Daily（日本語）"));
    assert.ok(jaFeed.includes("<itunes:duration>91</itunes:duration>"));
    assert.ok(jaFeed.includes(`<atom:link rel="self" type="application/rss+xml" href="${BASE_URL}/feed-ja.xml"/>`));
    assert.ok(/<pubDate>(Sat|Sun|Mon|Tue|Wed|Thu|Fri), \d{2} ([A-Z][a-z]{2}) \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/.test(jaFeed.replace(/\s+/g, " ")));
    assert.equal(jaFeed.match(/<item>/g).length, 2, "ja feed: both episodes have ja audio");
    // Lineup languages map to their RSS channel language code (zh -> zh-CN).
    const zhFeed = buildFeedXml("zh", entries, CONFIG, BASE_URL);
    assert.ok(zhFeed.includes("<language>zh-CN</language>"), "zh channel tag is zh-CN");
    const deFeed = buildFeedXml("de", entries, CONFIG, BASE_URL);
    assert.ok(deFeed.includes("<language>de</language>"), "de channel tag");
    // ru mp3 missing on disk is demoted before feeds see it -> 0 items.
    const ruFeed = buildFeedXml("ru", entries, CONFIG, BASE_URL);
    assert.equal(ruFeed.match(/<item>/g), null, "ru feed with no usable audio has no items");
    assert.ok(ruFeed.includes("Phantomresearch Daily (Русский)"));
    const deItems = deFeed.match(/<item>/g);
    assert.equal(deItems && deItems.length, 1);
    assert.ok(deFeed.includes("/2026-10-18/de.mp3"));
    // xml escaping: topic label contains "&" and a quote.
    assert.ok(jaFeed.includes("拡散モデル「&amp;」"), "topic label escaped");
    // relative mode: guid isPermaLink=false with tag-like value, relative enclosure.
    const relFeed = buildFeedXml("de", entries, CONFIG, "");
    assert.ok(relFeed.includes('enclosure url="episodes/2026-10-18/de.mp3"'));
    assert.ok(relFeed.includes('isPermaLink="false">phantomresearch-daily-2026-10-18-de'));
    assert.ok(!relFeed.includes("atom:link"), "no self atom:link without a base URL");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("buildEpisodesJson lists all episodes with per-language audio (nulls for missing)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-site-json-"));
  try {
    const { episodeRoot } = await makeFixture(tmp);
    const entries = await loadEpisodes(episodeRoot);
    for (const entry of entries) await copyEpisodeAssets(entry, episodeRoot, CONFIG.languages, join(tmp, "copy1"), () => {});
    const json = buildEpisodesJson(entries, CONFIG, BASE_URL, CONFIG.languages);
    assert.equal(json.version, 1);
    assert.equal(json.episodeCount, 2);
    assert.equal(json.baseUrl, BASE_URL);
    assert.equal(json.generatedAt, "2026-10-18T09:00:00+09:00");
    assert.deepEqual(json.feeds, {
      ja: "feed-ja.xml",
      zh: "feed-zh.xml",
      de: "feed-de.xml",
      es: "feed-es.xml",
      ru: "feed-ru.xml",
      it: "feed-it.xml",
    });
    const [first, second] = json.episodes;
    assert.equal(first.date, "2026-10-18");
    assert.deepEqual(first.topic.labels.de, "Diffusionsmodelle");
    assert.deepEqual(first.papers, PAPERS);
    assert.equal(first.languages.ja.audioUrl, `${BASE_URL}/episodes/2026-10-18/ja.mp3`);
    assert.equal(first.languages.ja.audioPath, "episodes/2026-10-18/ja.mp3");
    assert.equal(first.languages.ja.scriptPath, "episodes/2026-10-18/script-ja.txt");
    assert.equal(first.languages.ja.durationSeconds, 91.2);
    assert.equal(first.languages.zh, null, "failed language is null in JSON");
    assert.equal(first.languages.ru, null, "ru.mp3 missing on disk is demoted to null");
    assert.equal(second.languages.ja.audioUrl, `${BASE_URL}/episodes/2026-10-17/ja.mp3`);
    assert.equal(second.languages.de, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("index.html: play + download per available language, unavailable languages hidden", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-site-html-"));
  try {
    const { episodeRoot } = await makeFixture(tmp);
    const entries = await loadEpisodes(episodeRoot);
    for (const entry of entries) await copyEpisodeAssets(entry, episodeRoot, CONFIG.languages, join(tmp, "copy2"), () => {});
    const html = buildIndexHtml(entries, CONFIG, CONFIG.languages);
    // ja (available): audio element + download link + transcript.
    assert.ok(html.includes('<audio controls preload="none" src="episodes/2026-10-18/ja.mp3">'));
    assert.ok(html.includes('href="episodes/2026-10-18/ja.mp3" download="phantomresearch-daily-2026-10-18-ja.mp3"'));
    assert.ok(html.includes('href="episodes/2026-10-18/script-ja.txt"'));
    assert.ok(html.includes("<div class=\"lang-block\" data-lang=\"ja\">"));
    assert.ok(html.includes(`<div class="lang-block" data-lang="de">`) || html.includes("data-lang=\"de\""), "de block present");
    // zh (no audio anywhere): no lang-block and no tab.
    assert.ok(!html.includes('<div class="lang-block" data-lang="zh"'), "zh block absent");
    assert.ok(!html.includes('data-lang-tab="zh"'), "zh tab absent");
    // ru claimed but file missing: hidden everywhere.
    assert.ok(!html.includes('<div class="lang-block" data-lang="ru"'), "ru block absent");
    assert.ok(!html.includes('data-lang-tab="ru"'), "ru tab absent");
    // Paper attribution: escaped title + arXiv source link.
    assert.ok(html.includes("A Study &amp; &lt;Review&gt;"), "paper title escaped");
    assert.ok(html.includes('href="https://arxiv.org/abs/2410.12345"'), "paper link present");
    // Recent-first + latest flag + attribution footer.
    assert.ok(html.indexOf("2026-10-18") < html.indexOf("2026-10-17"), "newest episode first");
    assert.ok(html.includes('class="episode latest"'), "latest episode flagged");
    assert.ok(html.includes('href="episodes.json"'), "episodes.json linked");
    assert.ok(html.includes("<audio"), "audio element rendered");
    assert.ok(html.includes('aria-label="Language"'), "language switch UI present");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("buildSite: full output set, asset copies, metadata lands in all six feeds", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-site-build-"));
  try {
    const { episodeRoot } = await makeFixture(tmp);
    const outDir = join(tmp, "site");
    const result = await buildSite({ episodeRoot, outDir, config: CONFIG, baseUrl: BASE_URL });
    assert.deepEqual(result, {
      outDir,
      baseUrl: BASE_URL,
      episodeCount: 2,
      languages: ["ja", "zh", "de", "es", "ru", "it"],
      feeds: ["feed-ja.xml", "feed-zh.xml", "feed-de.xml", "feed-es.xml", "feed-ru.xml", "feed-it.xml"],
    });
    const files = (await readdir(outDir)).sort();
    assert.deepEqual(files, ["episodes", "episodes.json", "feed-de.xml", "feed-es.xml", "feed-it.xml", "feed-ja.xml", "feed-ru.xml", "feed-zh.xml", "index.html"]);
    // Audio is copied verbatim; transcripts too; nothing for absent files.
    assert.equal(await readFile(join(outDir, "episodes/2026-10-18/ja.mp3"), "utf8"), "ja-audio-ep1");
    assert.equal(await readFile(join(outDir, "episodes/2026-10-18/de.mp3"), "utf8"), "de-audio-ep1");
    assert.equal(await readFile(join(outDir, "episodes/2026-10-18/es.mp3"), "utf8"), "es-audio-ep1");
    assert.equal(await readFile(join(outDir, "episodes/2026-10-18/script-ja.txt"), "utf8"), "ja transcript");
    assert.equal(await readFile(join(outDir, "episodes/2026-10-17/ja.mp3"), "utf8"), "ja-audio-ep2");
    assert.deepEqual((await readdir(join(outDir, "episodes", "2026-10-18"))).sort(), ["de.mp3", "es.mp3", "it.mp3", "ja.mp3", "script-ja.txt"], "no zh transcript / no ru.mp3 (missing sources)");
    assert.deepEqual(await readdir(join(outDir, "episodes", "2026-10-17")), ["ja.mp3"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("episodes.json exposes copied audio paths", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-site-json2-"));
  try {
    const { episodeRoot } = await makeFixture(tmp);
    const outDir = join(tmp, "site");
    await buildSite({ episodeRoot, outDir, config: CONFIG, baseUrl: BASE_URL });
    const json = JSON.parse(await readFile(join(outDir, "episodes.json"), "utf8"));
    assert.equal(json.episodeCount, 2);
    assert.equal(json.episodes[0].languages.ja.scriptPath, "episodes/2026-10-18/script-ja.txt");
    assert.equal(json.episodes[0].languages.ja.voice, "voice-ja");
    assert.ok(json.episodes[1].languages.ja.audioPath.startsWith("episodes/2026-10-17/"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("buildSite is idempotent: two runs produce byte-identical output", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-site-idem-"));
  try {
    const { episodeRoot } = await makeFixture(tmp);
    const outDir = join(tmp, "site");
    await buildSite({ episodeRoot, outDir, config: CONFIG, baseUrl: BASE_URL });
    const first = await hashTree(outDir);
    await buildSite({ episodeRoot, outDir, config: CONFIG, baseUrl: BASE_URL });
    const second = await hashTree(outDir);
    assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
    assert.deepEqual(second, first, "all output files identical across runs");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("buildSite with empty/missing episodes dir still emits valid shells", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-site-empty-"));
  try {
    const outDir = join(tmp, "site");
    const result = await buildSite({
      episodeRoot: join(tmp, "no-such-episodes"),
      outDir,
      config: CONFIG,
      baseUrl: BASE_URL,
    });
    assert.equal(result.episodeCount, 0);
    for (const file of ["index.html", "episodes.json", "feed-ja.xml", "feed-zh.xml", "feed-de.xml", "feed-es.xml", "feed-ru.xml", "feed-it.xml"]) {
      const content = await readFile(join(outDir, file), "utf8");
      assert.ok(content.trim().length > 0, `${file} exists and is non-empty`);
    }
    const ja = await readFile(join(outDir, "feed-ja.xml"), "utf8");
    assert.ok(ja.includes("<channel>") && !ja.includes("<item>"));
    assert.ok(!ja.includes("lastBuildDate"));
    const json = JSON.parse(await readFile(join(outDir, "episodes.json"), "utf8"));
    assert.deepEqual(json.episodes, []);
    assert.equal(json.generatedAt, null);
    const html = await readFile(join(outDir, "index.html"), "utf8");
    assert.ok(html.includes("まだエピソードはありません"), "friendly empty state");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("buildSite in relative mode uses relative enclosure URLs and episode.json keeps baseUrl null", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-site-rel-"));
  try {
    const { episodeRoot } = await makeFixture(tmp);
    const outDir = join(tmp, "site");
    const result = await buildSite({ episodeRoot, outDir, config: CONFIG, baseUrl: "" });
    assert.equal(result.baseUrl, "");
    const ja = await readFile(join(outDir, "feed-ja.xml"), "utf8");
    assert.ok(ja.includes('enclosure url="episodes/2026-10-18/ja.mp3"'), "relative enclosure");
    assert.ok(ja.includes('<link>index.html</link>'), "relative channel link");
    const json = JSON.parse(await readFile(join(outDir, "episodes.json"), "utf8"));
    assert.equal(json.baseUrl, null);
    assert.equal(json.episodes[0].languages.ja.audioUrl, "episodes/2026-10-18/ja.mp3");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
