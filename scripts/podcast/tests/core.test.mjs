// Core tests: pure logic only (no network, no TTS spawn).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { poolOrder, pickTopic, pickFallback, planCatchupDates, loadHistory, saveHistory, writeJsonAtomic, parseISODate } from "../select.mjs";
import { buildQueryUrl, fetchPapers, parseAtom } from "../arxiv.mjs";
import { buildScript, cleanAbstract, DURATION_MAX_SECONDS, DURATION_MIN_SECONDS, DURATION_TARGET_SECONDS, estimateSpokenSeconds, trimExcerpt } from "../script.mjs";
import { buildTtsEnv, engineForLang, engineVoiceFor, exitCodeFor, localIso, parseCliArgs, parseTtsEnv, resolvePython, resolveTtsPython, runTts, shouldSkip, verifyAudio, voiceFor } from "../daily.mjs";

const moduleDir = fileURLToPath(new URL("../", import.meta.url));
const readModuleJson = async (name) => JSON.parse(await readFile(join(moduleDir, name), "utf8"));
const iso = (year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query: search_query=all:"test"</title>
  <entry>
    <id>http://arxiv.org/abs/2410.12345v2</id>
    <updated>2024-10-17T00:00:00Z</updated>
    <published>2024-10-16T17:59:59Z</published>
    <title>  A   First   Paper Title  </title>
    <summary>We study  things.
      Multi-line
      abstract here.</summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Example</name></author>
    <arxiv:primary_category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <link href="http://arxiv.org/abs/2410.12345v2" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2410.67890v1</id>
    <published>2024-10-15T10:00:00Z</published>
    <title>Second &amp; Third: A Study</title>
    <summary>Abstract two.</summary>
    <author><name>Carol Example</name></author>
    <arxiv:primary_category term="cs.CL"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2410.99999v1</id>
    <published>2024-10-14T10:00:00Z</published>
    <title>Malformed Entry Without Summary</title>
    <author><name>Dan Example</name></author>
  </entry>
</feed>`;

test("config.json matches the frozen contract", async () => {
  const config = await readModuleJson("config.json");
  assert.deepEqual(config, {
    title: "Phantomresearch Daily",
    subtitle: {
      ja: "毎日変わる研究テーマを、6言語で。",
      zh: "每天不同的研究主题，用六种语言。",
      de: "Ein anderes Forschungsthema jeden Tag, in sechs Sprachen.",
      es: "Un tema de investigación distinto cada día, en seis idiomas.",
      ru: "Новая исследовательская тема каждый день, на шести языках.",
      it: "Un tema di ricerca diverso ogni giorno, in sei lingue.",
    },
    siteBaseUrl: "http://127.0.0.1:4173/podcast",
    site: { baseUrl: "https://ryosaku610.github.io/researchphantom-daily" },
    languages: ["ja", "zh", "de", "es", "ru", "it"],
    languageLabels: { ja: "日本語", zh: "中文", de: "Deutsch", es: "Español", ru: "Русский", it: "Italiano" },
    maxPapers: 8,
    maxExcerptChars: { ja: 700, zh: 700, de: 1100, es: 1100, ru: 1100, it: 1100 },
    duration: { minSeconds: 300, maxSeconds: 1200, targetSeconds: 660 },
    backfillDays: 3,
    episodeDir: "podcast/episodes",
    stateDir: "podcast/state",
  });
});

test("config lineup only contains the six supported languages", async () => {
  const config = await readModuleJson("config.json");
  for (const lang of config.languages) {
    assert.ok(config.languageLabels[lang], `missing label for ${lang}`);
    assert.ok(config.maxExcerptChars[lang], `missing maxExcerptChars for ${lang}`);
  }
  assert.ok(!config.languages.includes("en"), "en left the lineup");
  assert.ok(!config.languages.includes("ko"), "ko left the lineup");
});

test("episode-length contract is frozen at 5..20 minutes with an 11-minute target", async () => {
  assert.equal(DURATION_MIN_SECONDS, 300);
  assert.equal(DURATION_MAX_SECONDS, 1200);
  assert.equal(DURATION_TARGET_SECONDS, 660);
});

const LINEUP_LANGS = ["ja", "zh", "de", "es", "ru", "it"];

test("topics.json has >=21 valid, unique topics with all six lineup labels", async () => {
  const topics = await readModuleJson("topics.json");
  assert.ok(Array.isArray(topics));
  assert.ok(topics.length >= 21, `expected >=21 topics, got ${topics.length}`);
  const ids = new Set();
  for (const topic of topics) {
    assert.match(topic.id, /^[a-z0-9-]+$/, `bad id: ${topic.id}`);
    assert.ok(!ids.has(topic.id), `duplicate id: ${topic.id}`);
    ids.add(topic.id);
    assert.ok(topic.keyword.trim().length > 0, `empty keyword for ${topic.id}`);
    assert.match(topic.keyword, /^[\x20-\x7e]+$/, `keyword must be ASCII: ${topic.keyword}`);
    for (const lang of LINEUP_LANGS) {
      assert.equal(typeof topic.labels[lang], "string");
      assert.ok(topic.labels[lang].trim().length > 0, `empty ${lang} label for ${topic.id}`);
    }
  }
});

test("fallback.json is faithful, well-formed and >=6 entries", async () => {
  const entries = await readModuleJson("fallback.json");
  assert.ok(Array.isArray(entries));
  assert.ok(entries.length >= 6, `expected >=6 fallback entries, got ${entries.length}`);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(),
      ["arxivId", "authors", "excerpt", "pdfUrl", "primaryCategory", "published", "title", "url", "year"]);
    assert.match(entry.arxivId, /^\d{4}\.\d{4,5}$/);
    assert.ok(entry.title.trim().length > 0);
    assert.ok(Array.isArray(entry.authors) && entry.authors.length >= 3 && entry.authors.length <= 8);
    assert.ok(entry.authors.every((author) => typeof author === "string" && author.trim()));
    assert.equal(entry.url, `https://arxiv.org/abs/${entry.arxivId}`);
    assert.equal(entry.pdfUrl, `https://arxiv.org/pdf/${entry.arxivId}`);
    assert.match(entry.published, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.excerpt.trim().length > 0);
  }
});

test("topic rotation is deterministic, varied and never repeats back-to-back", async () => {
  const topics = await readModuleJson("topics.json");
  const history = [];
  const seen = new Set();
  let previous = null;
  for (let day = 0; day < 30; day += 1) {
    const date = iso(2026, 1, day + 1);
    const topic = pickTopic(date, topics, history);
    if (previous) assert.notEqual(topic.id, previous.id, `repeat on ${date}`);
    if (day < topics.length) {
      assert.ok(!seen.has(topic.id), `duplicate within first cycle: ${topic.id} on ${date}`);
    }
    seen.add(topic.id);
    previous = topic;
    history.push({ date, topicId: topic.id });
  }
  assert.equal(seen.size, topics.length, "all topics should appear within one cycle");
});

test("pickTopic is pure: same input gives same topic in any call order", async () => {
  const topics = await readModuleJson("topics.json");
  const history = [{ date: "2026-02-28", topicId: topics[0].id }];
  const first = pickTopic("2026-03-05", topics, history);
  const unrelated = pickTopic("2026-03-06", topics, history);
  const second = pickTopic("2026-03-05", topics, history);
  assert.deepEqual(first, second);
  assert.equal(unrelated.id, pickTopic("2026-03-06", topics, history).id);
  assert.notEqual(first.id, undefined);
  // Recent history advances the candidate (same-date entry blocks its topic).
  const pool = topics.slice(0, 3);
  const candidate = pickTopic("2026-01-02", pool, []);
  const advanced = pickTopic("2026-01-02", pool, [{ date: "2026-01-02", topicId: candidate.id }]);
  assert.notEqual(advanced.id, candidate.id);
});

test("poolOrder is stable and does not mutate the input order", async () => {
  const topics = await readModuleJson("topics.json");
  const before = topics.map((topic) => topic.id);
  const a = poolOrder(topics, 2026).map((topic) => topic.id);
  const b = poolOrder(topics, 2026).map((topic) => topic.id);
  const other = poolOrder(topics, 2027).map((topic) => topic.id);
  assert.deepEqual(a, b);
  assert.deepEqual(topics.map((topic) => topic.id), before);
  assert.equal(a.length, topics.length);
  assert.notDeepEqual(a, other);
});

test("pickFallback is deterministic and bounded", async () => {
  const entries = await readModuleJson("fallback.json");
  const a = pickFallback("2026-10-18", entries);
  const b = pickFallback("2026-10-18", entries);
  assert.deepEqual(a, b);
  assert.ok(entries.includes(a));
  assert.equal(pickFallback("2026-10-18", []), null);
});

test("parseAtom parses valid entries and skips malformed ones", () => {
  const papers = parseAtom(FIXTURE_XML);
  assert.equal(papers.length, 2);
  const [first, second] = papers;
  assert.equal(first.arxivId, "2410.12345");
  assert.equal(first.title, "A First Paper Title");
  assert.deepEqual(first.authors, ["Alice Example", "Bob Example"]);
  assert.equal(first.primaryCategory, "cs.LG");
  assert.equal(first.published, "2024-10-16");
  assert.equal(first.url, "https://arxiv.org/abs/2410.12345");
  assert.equal(first.pdfUrl, "https://arxiv.org/pdf/2410.12345");
  assert.equal(first.abstract, "We study things. Multi-line abstract here.");
  assert.equal(second.arxivId, "2410.67890");
  assert.equal(second.title, "Second & Third: A Study");
  assert.equal(second.primaryCategory, "cs.CL");
  assert.equal(parseAtom("").length, 0);
  assert.equal(parseAtom("not xml at all").length, 0);
});

test("buildQueryUrl encodes the keyword and request limits", () => {
  const url = buildQueryUrl("diffusion models", 5);
  assert.ok(url.startsWith("https://export.arxiv.org/api/query?"));
  assert.ok(url.includes(`search_query=${encodeURIComponent('all:"diffusion models"')}`));
  assert.ok(url.includes("sortBy=submittedDate"));
  assert.ok(url.includes("sortOrder=descending"));
  assert.ok(url.includes("max_results=5"));
});

test("fetchPapers retries once on failure and returns [] (no network here)", async () => {
  let calls = 0;
  const offline = await fetchPapers("diffusion models", {
    fetchImpl: async () => {
      calls += 1;
      throw new Error("simulated offline");
    },
    retryDelayMs: 1,
    sleep: async () => {},
  });
  assert.deepEqual(offline, []);
  assert.equal(calls, 2);

  const ok = await fetchPapers("anything", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => FIXTURE_XML }),
  });
  assert.equal(ok.length, 2);

  assert.deepEqual(await fetchPapers("   ", { fetchImpl: async () => ({ ok: true, text: async () => FIXTURE_XML }) }), []);
});

const TOPIC = { id: "diffusion-models", labels: { ja: "拡散モデル", zh: "扩散模型", de: "Diffusionsmodelle", es: "Modelos de difusión", ru: "Диффузионные модели", it: "Modelli di diffusione" } };
const LANGUAGE_LABELS = { ja: "日本語", zh: "中文", de: "Deutsch", es: "Español", ru: "Русский", it: "Italiano" };
const LIMITS = { ja: 220, zh: 180, de: 300, es: 300, ru: 300, it: 300 };
const LONG_ABSTRACT = "We introduce a method that does one thing. It **works** on $x^2$ data with `code` spans. " +
  "Second sentence with a lot of extra detail that keeps going for a while so the sample exceeds every limit. ".repeat(8);
const SAMPLE_PAPERS = [
  {
    arxivId: "2410.12345",
    title: "A Long Study of Things",
    authors: ["Alice Example", "Bob Example", "Carol Example", "Dan Example"],
    abstract: LONG_ABSTRACT,
  },
  { arxivId: "2410.67890", title: "Short Note", authors: ["Eve Example"], abstract: "A very short abstract about graphs." },
];

test("buildScript quotes titles, trims excerpts and keeps http out (all languages)", () => {
  for (const lang of LINEUP_LANGS) {
    const { text, segments, estimatedSeconds, papersUsed } = buildScript(lang, {
      date: "2026-10-18",
      topic: TOPIC,
      papers: SAMPLE_PAPERS,
      languageLabels: LANGUAGE_LABELS,
      source: "arxiv",
      maxExcerptChars: LIMITS[lang],
    });
    assert.ok(text.includes("A Long Study of Things"), `${lang}: missing title`);
    assert.ok(text.includes("Short Note"), `${lang}: dropped short paper unnecessarily`);
    assert.equal(papersUsed, 2);
    assert.ok(text.includes("2410.12345") && text.includes("2410.67890"), `${lang}: missing ids`);
    assert.ok(text.includes(TOPIC.labels[lang]), `${lang}: missing topic label`);
    assert.ok(!/https?:/i.test(text), `${lang}: spoken text must not contain URLs`);
    assert.ok(!text.includes("**") && !text.includes("$") && !text.includes("`"), `${lang}: markdown/math leaked`);
    assert.ok(estimatedSeconds > 0 && estimatedSeconds <= DURATION_MAX_SECONDS, `${lang}: estimated ${estimatedSeconds}s outside target`);
    assert.ok(text.includes("Alice Example") && !text.includes("Dan Example"), `${lang}: author line`);
    assert.ok(text.includes("et al.") || text.includes("ほか") || text.includes("等") || text.includes("и др"), `${lang}: et al. marker`);
    assert.deepEqual(
      segments.map((segment) => segment.label),
      ["intro", "topic-overview", "paper-1", "commentary-paper1", "paper-2", "commentary-paper2", "outro"],
    );
    if (lang === "de") assert.ok(text.includes("„"), "german opening quote");
    if (["es", "ru", "it"].includes(lang)) assert.ok(text.includes("«"), `${lang} guillemets`);
  }
});

test("buildScript grows or shrinks toward the 5-20 minute target and reports met", () => {
  const longPapers = [
    { arxivId: "2610.11111", title: "A First Very Long Research Paper Title About Systems", authors: ["A One", "B Two", "C Three", "D Four"], abstract: LONG_ABSTRACT },
    { arxivId: "2610.22222", title: "A Second Very Long Research Paper Title About Models", authors: ["E Five", "F Six", "G Seven", "H Eight"], abstract: LONG_ABSTRACT },
    { arxivId: "2610.33333", title: "A Third Very Long Research Paper Title About Agents", authors: ["I Nine", "J Ten", "K Eleven", "L Twelve"], abstract: LONG_ABSTRACT },
  ];
  for (const lang of LINEUP_LANGS) {
    const result = buildScript(lang, { date: "2026-10-18", topic: TOPIC, papers: longPapers, maxExcerptChars: LIMITS[lang] });
    assert.equal(result.met, true, `${lang}: met flag`);
    assert.ok(result.estimatedSeconds >= DURATION_MIN_SECONDS && result.estimatedSeconds < DURATION_MAX_SECONDS, `${lang}: estimated ${result.estimatedSeconds}s`);
    assert.ok(result.plannedSeconds >= DURATION_MIN_SECONDS && result.plannedSeconds < DURATION_MAX_SECONDS, `${lang}: planned ${result.plannedSeconds}s`);
    assert.ok(result.papersUsed >= 1 && result.papersUsed <= 3, `${lang}: papersUsed ${result.papersUsed}`);
    // intro + topic-overview + (paper + commentary) per paper + outro
    assert.equal(result.segments.length, result.papersUsed * 2 + 3, `${lang}: segment count`);
    for (let index = 0; index < result.papersUsed; index += 1) {
      assert.ok(result.text.includes(longPapers[index].title), `${lang}: missing title ${index}`);
      const excerpt = trimExcerpt(longPapers[index].abstract, result.excerptLimit);
      if (excerpt) assert.ok(result.text.includes(excerpt), `${lang}: excerpt ${index} not verbatim`);
      assert.ok(result.text.includes(`commentary-paper${index + 1}`) || result.segments.some((segment) => segment.label === `commentary-paper${index + 1}`), `${lang}: commentary label ${index}`);
    }
    if (result.papersUsed < 3) assert.ok(!result.text.includes(longPapers[result.papersUsed].title), `${lang}: unused paper leaked`);
  }
});

test("buildScript writes Japanese numbers as words and short papers all survive", () => {
  const shortPapers = ["Tiny A", "Tiny B", "Tiny C"].map((title, index) => ({
    arxivId: `2610.1000${index}`,
    title,
    authors: ["Solo Author"],
    abstract: "",
  }));
  const { text, papersUsed } = buildScript("ja", { date: "2026-10-18", topic: TOPIC, papers: shortPapers });
  assert.equal(papersUsed, 3);
  assert.ok(text.includes("三本"));
  assert.ok(text.includes("一本目") && text.includes("二本目") && text.includes("三本目"));
  assert.ok(!text.includes("3本"));
});

test("buildScript uses a different quote cue for curated entries and handles empty papers", () => {
  const curatedPaper = { arxivId: "1706.03762", title: "Attention Is All You Need", authors: ["A", "B", "C", "D"], abstract: "編集部の日本語要約です。二文目です。" };
  const jaCurated = buildScript("ja", { date: "2026-10-18", topic: TOPIC, papers: [curatedPaper], source: "curated" });
  assert.ok(jaCurated.text.includes("編集部"));
  const jaArxiv = buildScript("ja", { date: "2026-10-18", topic: TOPIC, papers: [curatedPaper], source: "arxiv" });
  assert.ok(jaArxiv.text.includes("原文"));
  const empty = buildScript("de", { date: "2026-10-18", topic: TOPIC, papers: [] });
  assert.ok(empty.text.includes("keine Papers"), empty.text);
  assert.equal(empty.segments.length, 3);  // intro + topic-overview + outro
  assert.throws(() => buildScript("fr", { date: "2026-10-18", topic: TOPIC, papers: [] }));
  // removed lineup languages must fail loudly instead of rendering English/Korean
  assert.throws(() => buildScript("en", { date: "2026-10-18", topic: TOPIC, papers: [] }), /unsupported language: en/);
  assert.throws(() => buildScript("ko", { date: "2026-10-18", topic: TOPIC, papers: [] }), /unsupported language: ko/);
  assert.throws(() => buildScript("ja", { date: "not-a-date", topic: TOPIC, papers: [] }));
});

test("buildScript countPhrase/orderPhrase extend to eight papers", () => {
  const eighth = Array.from({ length: 8 }, (_, index) => ({
    arxivId: `2610.2000${index}`,
    title: `Tiny Paper ${index + 1}`,
    authors: ["Solo Author"],
    abstract: "",
  }));
  const ja = buildScript("ja", { date: "2026-10-18", topic: TOPIC, papers: eighth });
  assert.equal(ja.papersUsed, 8);
  assert.ok(ja.text.includes("八本"));
  assert.ok(ja.text.includes("八本目") && ja.text.includes("七本目") && ja.text.includes("五本目"), ja.text);
  assert.ok(!ja.text.includes("8本"));
  const de = buildScript("de", { date: "2026-10-18", topic: TOPIC, papers: eighth });
  assert.ok(de.text.includes("acht Paper"), de.text);
  assert.ok(de.text.includes("Der achte Beitrag:"), de.text);
  const ru = buildScript("ru", { date: "2026-10-18", topic: TOPIC, papers: eighth });
  assert.ok(ru.text.includes("восемь статей"), ru.text);
  assert.ok(ru.text.includes("Восьмая статья:"), ru.text);
});

test("buildScript never deadlocks on tiny input: short day with met=false", () => {
  for (const lang of LINEUP_LANGS) {
    const result = buildScript(lang, {
      date: "2026-10-18",
      topic: TOPIC,
      papers: [{ arxivId: "2610.00001", title: "Tiny", authors: ["Solo"], abstract: "" }],
    });
    assert.equal(result.papersUsed, 1);
    assert.equal(result.met, false);
    assert.ok(result.estimatedSeconds < DURATION_MIN_SECONDS, `${lang}: short day ${result.estimatedSeconds}s`);
    assert.ok(result.text.includes("Tiny") && result.text.includes(result.segments.at(-1).text), `${lang}: full script still rendered`);
    assert.equal(result.segments.length, 5);  // intro + overview + paper + commentary + outro
  }
});

test("estimate boundaries: min/max and growth beyond min via full-abstract plan", () => {
  const rate = 0.1685;
  assert.ok(Math.abs(estimateSpokenSeconds("ja", "あ".repeat(Math.round(DURATION_MIN_SECONDS / rate))) - DURATION_MIN_SECONDS) < 1);
  const itRate = 0.098;
  assert.ok(estimateSpokenSeconds("it", "a".repeat(Math.ceil(DURATION_MIN_SECONDS / itRate))) >= DURATION_MIN_SECONDS);
  // Enough long abstracts must reach past min for a single-paper day too.
  const longSingleAbstract = "A long abstract sentence detailing methods and experiments that keeps going for many pages in the preprint. ".repeat(40);
  const single = buildScript("de", {
    date: "2026-10-18",
    topic: TOPIC,
    papers: [{ arxivId: "2610.00002", title: "One Long Paper", authors: ["A", "B", "C", "D"], abstract: longSingleAbstract }],
    maxExcerptChars: LIMITS.de,
  });
  assert.equal(single.met, true);
  assert.ok(single.estimatedSeconds >= DURATION_MIN_SECONDS, `${single.estimatedSeconds}s`);
});

test("estimateSpokenSeconds is monotonic in text length", () => {
  assert.equal(estimateSpokenSeconds("ja", ""), 0);
  assert.ok(estimateSpokenSeconds("ja", "あ".repeat(600)) > estimateSpokenSeconds("ja", "あ".repeat(300)));
  assert.ok(estimateSpokenSeconds("ja", "あ".repeat(600)) <= DURATION_MAX_SECONDS);
});

test("trimExcerpt cuts at the last sentence boundary and cleans markdown/math", () => {
  assert.equal(trimExcerpt("First sentence here. Second one too long for the limit.", 30), "First sentence here.");
  assert.equal(cleanAbstract("A **bold** claim about $x+y$ and `code`."), "A bold claim about and code.");
  assert.equal(trimExcerpt("", 100), "");
  assert.ok(trimExcerpt("x".repeat(200), 40).length <= 40);
  assert.equal(trimExcerpt("Short.", 300), "Short.");
});

test("trimExcerpt soft cuts: CJK comma boundary and trailing function words", () => {
  const cjk = `${"あ".repeat(25)}、${"い".repeat(60)}`;
  assert.equal(trimExcerpt(cjk, 40), `${"あ".repeat(25)}、`);
  const english = `We present a new approach to attribution for ${"continuation words keep going ".repeat(4)}`;
  const cut = trimExcerpt(english, 45);
  assert.ok(cut.endsWith("attribution"), cut);
  assert.ok(!cut.endsWith("for"), cut);
});

test("planCatchupDates covers empty history, gaps, caps and invalid input", () => {
  assert.deepEqual(planCatchupDates("2026-10-18", null, 3), ["2026-10-18"]);
  assert.deepEqual(planCatchupDates("2026-10-18", "not-a-date", 3), ["2026-10-18"]);
  assert.deepEqual(planCatchupDates("2026-10-18", "2026-10-18", 3), []);
  assert.deepEqual(planCatchupDates("2026-10-18", "2026-10-15", 3), ["2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.deepEqual(planCatchupDates("2026-10-18", "2026-10-15", 5), ["2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.deepEqual(planCatchupDates("2026-10-18", "2026-09-01", 2), ["2026-10-17", "2026-10-18"]);
  assert.deepEqual(planCatchupDates("2026-10-18", "2026-10-20", 3), []);
  assert.deepEqual(planCatchupDates("2026-01-02", "2025-12-31", 3), ["2026-01-01", "2026-01-02"]);
  assert.throws(() => planCatchupDates("2026-13-40", null, 3));
  assert.equal(parseISODate("2026-02-30"), null);
  assert.equal(parseISODate("2026-02-28")?.day, 28);
});

test("exitCodeFor matches the documented exit contract", () => {
  assert.equal(exitCodeFor(1, 0, 4), 0);
  assert.equal(exitCodeFor(1, 0, 0), 3);
  assert.equal(exitCodeFor(2, 2, 0), 0);
  assert.equal(exitCodeFor(2, 1, 1), 0);
  assert.equal(exitCodeFor(2, 1, 0), 3);
  assert.equal(exitCodeFor(0, 0, 0), 0);
});

test("shouldSkip detects generated episode dirs (temp fixture)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-skip-"));
  try {
    assert.equal(shouldSkip("2026-10-18", tmp), false);
    await mkdir(join(tmp, "2026-10-18"), { recursive: true });
    assert.equal(shouldSkip("2026-10-18", tmp), false);
    await writeFile(join(tmp, "2026-10-18", "episode.json"), "{}\n");
    assert.equal(shouldSkip("2026-10-18", tmp), true);
    assert.equal(shouldSkip("2026-10-19", tmp), false);
    assert.equal(shouldSkip("not-a-date", tmp), false);
    const direct = join(tmp, "direct");
    await mkdir(direct, { recursive: true });
    await writeFile(join(direct, "episode.json"), "{}\n");
    assert.equal(shouldSkip("2026-10-18", direct), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("history round-trip caps at 800 entries and survives bad files", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-history-"));
  try {
    const historyPath = join(tmp, "state", "history.json");
    assert.deepEqual(await loadHistory(historyPath), []);
    const entries = Array.from({ length: 810 }, (_, index) => ({ date: iso(2026, 1, 1 + (index % 28)), topicId: `t${index}` }));
    await saveHistory(historyPath, entries);
    const loaded = await loadHistory(historyPath);
    assert.equal(loaded.length, 800);
    assert.deepEqual(loaded[799], entries[809]);
    await writeFile(historyPath, "not json");
    assert.deepEqual(await loadHistory(historyPath), []);
    await writeJsonAtomic(join(tmp, "status.json"), { ok: true });
    assert.deepEqual(JSON.parse(await readFile(join(tmp, "status.json"), "utf8")), { ok: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("verifyAudio checks bytes/sha256 against metrics", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-audio-"));
  try {
    const out = join(tmp, "ja.mp3");
    const metrics = join(tmp, "ja.metrics.json");
    const payload = Buffer.from("fake mp3 bytes for verification");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(out, payload);
    assert.equal((await verifyAudio(out, metrics)).ok, true); // metrics missing -> still ok
    const missing = await verifyAudio(out, metrics);
    assert.equal(missing.note, "metrics json missing");
    await writeJsonAtomic(metrics, { durationSeconds: 12.3456, bytes: payload.length, sha256 });
    const verdict = await verifyAudio(out, metrics);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.bytes, payload.length);
    assert.equal(verdict.sha256, sha256);
    assert.equal(verdict.durationSeconds, 12.346);
    await writeJsonAtomic(metrics, { durationSeconds: 5, bytes: payload.length + 1, sha256 });
    assert.equal((await verifyAudio(out, metrics)).ok, false);
    await writeJsonAtomic(metrics, { durationSeconds: 5, bytes: payload.length, sha256: "0".repeat(64) });
    assert.equal((await verifyAudio(out, metrics)).ok, false);
    assert.equal((await verifyAudio(join(tmp, "nope.mp3"), metrics)).ok, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("voiceFor reads voices.json shapes and falls back to defaults", () => {
  assert.equal(voiceFor(null, "ja"), "ono_anna");
  assert.equal(voiceFor({}, "en"), "aiden");
  assert.equal(voiceFor({ languages: { zh: { speaker: "custom_zh" } } }, "zh"), "custom_zh");
  assert.equal(voiceFor({ ko: "custom_ko" }, "ko"), "custom_ko");
  assert.equal(voiceFor({ languages: {} }, "ko"), "sohee");
});

test("buildTtsEnv forces offline unless PODCAST_TTS_ONLINE=1", () => {
  assert.equal(buildTtsEnv({}).HF_HUB_OFFLINE, "1");
  assert.equal(buildTtsEnv({ PODCAST_TTS_ONLINE: "1" }).HF_HUB_OFFLINE, undefined);
});

test("parseTtsEnv defaults to qwen and validates engine names", () => {
  assert.deepEqual(parseTtsEnv({}), { engine: "qwen", map: {} });
  assert.deepEqual(parseTtsEnv({}), parseTtsEnv({ PODCAST_TTS_ENGINE: "" }));
  assert.deepEqual(parseTtsEnv({ PODCAST_TTS_ENGINE: "EDGE " }), { engine: "edge", map: {} });
  assert.deepEqual(parseTtsEnv({ PODCAST_TTS_ENGINE: "irodori" }), { engine: "irodori", map: {} });
  assert.deepEqual(parseTtsEnv({ PODCAST_TTS_ENGINE: "voicestudio" }), { engine: "voicestudio", map: {} });
  assert.throws(() => parseTtsEnv({ PODCAST_TTS_ENGINE: "qwen2" }), /PODCAST_TTS_ENGINE/);
  assert.throws(() => parseTtsEnv({ PODCAST_TTS_ENGINE: "Edge Lewd" }), /PODCAST_TTS_ENGINE/);
  assert.throws(
    () => parseTtsEnv({ PODCAST_TTS_ENGINE: "qwen2" }),
    /expected: qwen, edge, irodori, voicestudio/,
  );
});

test("parseTtsEnv parses per-language maps and rejects malformed ones", () => {
  assert.deepEqual(
    parseTtsEnv({ PODCAST_TTS_MAP: " ja:irodori , de:edge ,, zh: edge " }),
    { engine: "qwen", map: { ja: "irodori", de: "edge", zh: "edge" } });
  assert.deepEqual(
    parseTtsEnv({ PODCAST_TTS_MAP: "ja:irodori,zh:voicestudio,de:voicestudio,es:voicestudio,ru:voicestudio,it:voicestudio" }),
    { engine: "qwen", map: { ja: "irodori", zh: "voicestudio", de: "voicestudio", es: "voicestudio", ru: "voicestudio", it: "voicestudio" } });
  assert.deepEqual(parseTtsEnv({ PODCAST_TTS_ENGINE: "edge", PODCAST_TTS_MAP: "ru:qwen" }),
    { engine: "edge", map: { ru: "qwen" } });
  assert.throws(() => parseTtsEnv({ PODCAST_TTS_MAP: "ja" }), /PODCAST_TTS_MAP/);
  assert.throws(() => parseTtsEnv({ PODCAST_TTS_MAP: "ja:edge,de:bogus" }), /PODCAST_TTS_MAP/);
  assert.throws(() => parseTtsEnv({ PODCAST_TTS_MAP: ":edge" }), /PODCAST_TTS_MAP/);
});

test("engineForLang lets PODCAST_TTS_MAP override PODCAST_TTS_ENGINE per language", () => {
  const tts = parseTtsEnv({ PODCAST_TTS_ENGINE: "edge", PODCAST_TTS_MAP: "ja:irodori" });
  assert.equal(engineForLang(tts, "ja"), "irodori");
  assert.equal(engineForLang(tts, "de"), "edge");
  assert.equal(engineForLang(parseTtsEnv({}), "it"), "qwen");
  assert.equal(engineForLang(null, "ja"), "qwen");
});

test("resolveTtsPython picks the engine venv and honors PODCAST_PYTHON", () => {
  assert.equal(resolveTtsPython("qwen", {}), resolvePython({}));  // .venv-tts must win for qwen
  assert.match(resolveTtsPython("edge", {}), /\.venv-edge\/bin\/python$/);
  assert.equal(resolveTtsPython("irodori", {}), "python3");  // stdlib-only engine
  assert.equal(resolveTtsPython("voicestudio", {}), "python3");  // stdlib-only engine
  for (const engine of ["qwen", "edge", "irodori", "voicestudio"]) {
    assert.equal(resolveTtsPython(engine, { PODCAST_PYTHON: "/custom/python" }), "/custom/python");
  }
});

test("engineVoiceFor maps voices.json engine sections with safe fallbacks", async () => {
  const voices = await readModuleJson("voices.json");
  assert.equal(engineVoiceFor(voices, "qwen", "ja"), "ono_anna");
  assert.equal(engineVoiceFor(voices, "edge", "ja"), "ja-JP-NanamiNeural");
  assert.equal(engineVoiceFor(voices, "edge", "zh"), "zh-CN-XiaoxiaoNeural");
  assert.equal(engineVoiceFor(voices, "edge", "de"), "de-DE-KatjaNeural");
  assert.equal(engineVoiceFor(voices, "edge", "es"), "es-ES-ElviraNeural");
  assert.equal(engineVoiceFor(voices, "edge", "ru"), "ru-RU-SvetlanaNeural");
  assert.equal(engineVoiceFor(voices, "edge", "it"), "it-IT-ElsaNeural");
  assert.equal(engineVoiceFor(voices, "edge", "en"), "none");  // en left the lineup
  assert.equal(engineVoiceFor(voices, "edge", "ko"), "none");
  assert.ok(String(engineVoiceFor(voices, "irodori", "ja")).length > 0);
  assert.equal(engineVoiceFor(voices, "irodori", "de"), "none");
  assert.equal(engineVoiceFor(voices, "voicestudio", "zh"), "Phantom-ZH");
  assert.equal(engineVoiceFor(voices, "voicestudio", "de"), "Phantom-DE");
  assert.equal(engineVoiceFor(voices, "voicestudio", "es"), "Phantom-ES");
  assert.equal(engineVoiceFor(voices, "voicestudio", "ru"), "Phantom-RU");
  assert.equal(engineVoiceFor(voices, "voicestudio", "it"), "Phantom-IT");
  assert.equal(engineVoiceFor(voices, "voicestudio", "ja"), "none");  // ja stays on irodori
  assert.equal(engineVoiceFor(voices, "voicestudio", "en"), "none");  // en left the lineup
  assert.equal(engineVoiceFor(null, "edge", "de"), "de-DE-KatjaNeural");
  assert.equal(engineVoiceFor(null, "edge", "en"), "none");
  assert.equal(engineVoiceFor(null, "voicestudio", "it"), "none");
});

test("parseCliArgs validates flags and rejects unknown ones", () => {
  assert.deepEqual(parseCliArgs([]), { date: null, catchup: null, force: false, offline: false, noTts: false, noSite: false, verbose: false, help: false });
  const parsed = parseCliArgs(["--date", "2026-10-18", "--catchup", "2", "--force", "--no-site"]);
  assert.equal(parsed.date, "2026-10-18");
  assert.equal(parsed.catchup, 2);
  assert.equal(parsed.force, true);
  assert.equal(parsed.noSite, true);
  assert.equal(parseCliArgs(["--catchup"]).catchup, -1);
  assert.equal(parseCliArgs(["--catchup=4"]).catchup, 4);
  assert.equal(parseCliArgs(["--date=2026-10-18"]).date, "2026-10-18");
  assert.throws(() => parseCliArgs(["--date", "2026-1-1"]));
  assert.throws(() => parseCliArgs(["--catchup", "0"]));
  assert.throws(() => parseCliArgs(["--bogus"]));
});

test("localIso emits an ISO8601 timestamp with local offset", () => {
  const stamp = localIso(new Date(2026, 9, 18, 6, 30, 12));
  assert.match(stamp, /^2026-10-18T06:30:12[+-]\d{2}:\d{2}$/);
});


// In-process fake child process for runTts: no real TTS model is spawned.
function fakeChild(behavior = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    behavior.onKill?.();
    setImmediate(() => child.emit("close", null, "SIGKILL"));
    return true;
  };
  setImmediate(() => behavior.run?.(child));
  return child;
}

test("runTts calls synthesize.py with the frozen contract and verifies metrics", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-tts-"));
  try {
    const episodeDir = join(tmp, "2026-10-18");
    await mkdir(episodeDir, { recursive: true });
    const payload = Buffer.from("fake-mp3-payload-for-runTts");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    let captured = null;
    const result = await runTts("ja", {
      episodeDir,
      env: {},
      spawnImpl: (command, args, options) => {
        captured = { command, args, options };
        return fakeChild({
          run: (child) => {
            writeFileSync(join(episodeDir, "ja.mp3"), payload);
            writeFileSync(join(episodeDir, "ja.metrics.json"), JSON.stringify({ durationSeconds: 91.5, bytes: payload.length, sha256 }));
            child.emit("close", 0, null);
          },
        });
      },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.durationSeconds, 91.5);
    assert.equal(result.bytes, payload.length);
    assert.equal(result.sha256, sha256);
    assert.equal(result.voice, "ono_anna");
    assert.equal(captured.args[0], join(moduleDir, "synthesize.py"));
    assert.deepEqual(captured.args.slice(1), [
      "--text-file", join(episodeDir, "script-ja.txt"),
      "--language", "ja",
      "--out", join(episodeDir, "ja.mp3"),
      "--metrics", join(episodeDir, "ja.metrics.json"),
    ]);
    assert.equal(captured.options.cwd, fileURLToPath(new URL("../../..", import.meta.url)));
    assert.equal(captured.options.env.HF_HUB_OFFLINE, "1");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runTts selects the adapter script and interpreter per engine", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-engine-"));
  try {
    const episodeDir = join(tmp, "2026-10-18");
    await mkdir(episodeDir, { recursive: true });
    const payload = Buffer.from("fake-mp3");
    const sha256 = createHash("sha256").update(payload).digest("hex");

    const cases = [
      { engine: "edge", lang: "de", adapter: "synthesize_edge.py", voice: "de-DE-KatjaNeural" },
      { engine: "irodori", lang: "ja", adapter: "synthesize_irodori.py", voice: "kanade" },
      { engine: "voicestudio", lang: "it", adapter: "synthesize_voicestudio.py", voice: "Phantom-IT" },
    ];
    for (const { engine, lang, adapter, voice } of cases) {
      for (const name of [`${lang}.mp3`, `${lang}.metrics.json`]) await rm(join(episodeDir, name), { force: true });
      let captured = null;
      const result = await runTts(lang, {
        episodeDir,
        env: {},
        engine,
        voice,  // generateEpisode passes engineVoiceFor(voices, engine, lang); "kanade" is the irodori caption
        spawnImpl: (command, args, options) => {
          captured = { command, args, options };
          return fakeChild({
            run: (child) => {
              writeFileSync(join(episodeDir, `${lang}.mp3`), payload);
              writeFileSync(join(episodeDir, `${lang}.metrics.json`), JSON.stringify({ durationSeconds: 60, bytes: payload.length, sha256 }));
              child.emit("close", 0, null);
            },
          });
        },
      });
      assert.equal(captured.args[0], join(moduleDir, adapter), engine);
      assert.equal(captured.options.cwd, fileURLToPath(new URL("../../..", import.meta.url)));
      assert.equal(result.status, "ok");
      assert.equal(result.voice, voice);
      assert.equal(result.sha256, sha256);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runTts records spawn failure, non-zero exit and timeout per language", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "podcast-tts-fail-"));
  try {
    const episodeDir = join(tmp, "2026-10-18");
    await mkdir(episodeDir, { recursive: true });
    const spawnError = await runTts("de", {
      episodeDir,
      env: {},
      spawnImpl: () => fakeChild({ run: (child) => child.emit("error", new Error("boom")) }),
    });
    assert.equal(spawnError.status, "failed");
    assert.ok(spawnError.error.includes("boom") && spawnError.error.includes("Sprachsynthese"), spawnError.error);

    const exitFailure = await runTts("es", {
      episodeDir,
      env: {},
      spawnImpl: () => fakeChild({ run: (child) => child.emit("close", 3, null) }),
    });
    assert.equal(exitFailure.status, "failed");
    assert.ok(exitFailure.error.includes("Fallo en la síntesis"), exitFailure.error);

    const timeoutFailure = await runTts("ru", {
      episodeDir,
      env: {},
      timeoutMs: 30,
      spawnImpl: () => fakeChild({ run: () => {} }),
    });
    assert.equal(timeoutFailure.status, "failed");
    assert.ok(timeoutFailure.error.includes("timeout"), timeoutFailure.error);

    const syncThrow = await runTts("zh", {
      episodeDir,
      env: {},
      spawnImpl: () => {
        throw new Error("cannot spawn");
      },
    });
    assert.equal(syncThrow.status, "failed");
    assert.ok(syncThrow.error.includes("launch"), syncThrow.error);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
