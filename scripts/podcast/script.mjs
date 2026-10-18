// Builds the spoken script for one language. Templates are fixed sentences
// written in this file; only paper titles, author names and short abstract
// quotes come from arXiv data (quoted in their original language).
//
// The local TTS voice narrates calmly (~6 chars/s for ja), so the builder
// estimates the spoken length and trims the number of quoted papers / excerpt
// length to keep the brief inside the 60-110s target.
import { parseISODate } from "./select.mjs";

const DEFAULT_MAX_EXCERPT = { ja: 220, en: 300, zh: 180, ko: 200 };
const DEFAULT_MAX_PAPERS = 3;
const SUPPORTED = ["ja", "en", "zh", "ko"];

// Seconds per character with the local Qwen3-TTS voices, measured from real
// synthesize.py runs (ja 0.168, en 0.082, zh 0.134, ko 0.168 s/char).
const SECONDS_PER_CHAR = { ja: 0.1685, en: 0.082, zh: 0.135, ko: 0.1685 };
export const DURATION_MAX_SECONDS = 110;

export function estimateSpokenSeconds(lang, text) {
  const rate = SECONDS_PER_CHAR[lang] ?? 0.12;
  return (String(text ?? "").length || 0) * rate;
}

// ---- text hygiene -----------------------------------------------------------

export function cleanAbstract(raw) {
  if (raw === null || raw === undefined) return "";
  let text = String(raw);
  text = text.replace(/\$\$[\s\S]*?\$\$/g, " ");
  text = text.replace(/\$[^$\n]*\$/g, " ");
  text = text.replace(/\\\([\s\S]*?\\\)/g, " ");
  text = text.replace(/\\\[[\s\S]*?\\\]/g, " ");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/^\s*#+\s*/gm, "");
  return text.replace(/\s+/g, " ").trim();
}

function lastSentenceBoundary(window) {
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const char = window[index];
    if (char === "。" || char === "！" || char === "？") return index;
    if (char === "." || char === "!" || char === "?") {
      const next = window[index + 1];
      if (next === undefined || /\s/.test(next)) return index;
    }
  }
  return -1;
}

// Common English function words that make a hard cut sound unfinished; the
// fallback drops a trailing one so quotes end on a content word.
const TRAILING_STOP_WORDS = new Set([
  "for", "and", "of", "to", "the", "a", "an", "in", "with", "that", "have",
  "has", "is", "are", "was", "were", "by", "on", "as", "at", "or", "from",
  "this", "these", "those", "we", "it", "its", "their", "than", "which", "while",
]);

// Trim at the last sentence/period boundary inside the limit. When no sentence
// boundary exists, prefer the last soft CJK comma in the second half of the
// window, then a whitespace cut with a trailing function word removed.
export function trimExcerpt(raw, limit) {
  const clean = cleanAbstract(raw);
  if (!clean) return "";
  const max = Math.max(40, Math.floor(Number(limit)) || 300);
  if (clean.length <= max) return clean;
  const window = clean.slice(0, max);
  const boundary = lastSentenceBoundary(window);
  if (boundary >= 0) return window.slice(0, boundary + 1).trim();
  const comma = Math.max(window.lastIndexOf("、"), window.lastIndexOf("，"));
  if (comma >= Math.floor(window.length / 2)) return window.slice(0, comma + 1).trim();
  const words = window.replace(/\s+\S*$/, "").trim().split(" ");
  if (words.length > 3 && TRAILING_STOP_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(" ");
}

// ---- small formatting helpers ----------------------------------------------

const JOINT = { ja: "", en: " ", zh: "", ko: " " };
const TITLE_QUOTES = { ja: ["「", "」"], en: ["\"", "\""], zh: ["「", "」"], ko: ["\"", "\""] };
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DEFAULT_LANGUAGE_LABELS = { ja: "日本語", en: "English", zh: "中文", ko: "한국어" };

function normalizeLang(lang) {
  const value = String(lang ?? "").trim().toLowerCase();
  if (!SUPPORTED.includes(value)) throw new Error(`unsupported language: ${lang}`);
  return value;
}

function formatDate(lang, parsed) {
  if (lang === "en") return `${MONTHS_EN[parsed.month - 1]} ${parsed.day}, ${parsed.year}`;
  if (lang === "ko") return `${parsed.year}년 ${parsed.month}월 ${parsed.day}일`;
  return `${parsed.year}年${parsed.month}月${parsed.day}日`;
}

function countPhrase(lang, count) {
  const words = {
    ja: ["", "一本", "二本", "三本", "四本", "五本"],
    en: ["", "one", "two", "three", "four", "five"],
    zh: ["", "一篇", "两篇", "三篇", "四篇", "五篇"],
    ko: ["", "한 편", "두 편", "세 편", "네 편", "다섯 편"],
  };
  return words[lang][count] ?? (lang === "ja" ? `${count}本` : lang === "zh" ? `${count}篇` : lang === "ko" ? `${count}편` : String(count));
}

function orderPhrase(lang, index) {
  const words = {
    ja: ["一本目", "二本目", "三本目", "四本目"],
    en: ["First", "Second", "Third", "Fourth"],
    zh: ["一", "二", "三", "四"],
    ko: ["첫 번째", "두 번째", "세 번째", "네 번째"],
  };
  return words[lang][index] ?? (lang === "ja" ? `${index + 1}本目` : String(index + 1));
}

function authorLine(lang, authors) {
  const list = (Array.isArray(authors) ? authors : []).map((name) => String(name ?? "").trim()).filter(Boolean);
  if (list.length === 0) return null;
  const first = list.slice(0, 3);
  const more = list.length > first.length;
  if (lang === "ja") return `著者は${first.join("、")}${more ? "ほか" : ""}です。`;
  if (lang === "en") return `The authors are ${first.join(", ")}${more ? ", et al." : ""}.`;
  if (lang === "zh") return `作者是${first.join("、")}${more ? "等" : ""}。`;
  return `저자: ${first.join(", ")}${more ? " 외" : ""}.`;
}

function languageList(lang, labels) {
  const values = ["ja", "en", "zh", "ko"].map((key) => labels[key] ?? DEFAULT_LANGUAGE_LABELS[key]);
  return values.join(JOINT[lang] === "" ? "・" : ", ");
}

function nestedLabel(labels, lang) {
  const value = labels && typeof labels === "object" ? labels[lang] : null;
  return typeof value === "string" && value.trim() ? value.trim() : lang;
}

// ---- fixed templates per language -------------------------------------------

function introLine(lang, dateText, topicLabel, paperCount, curated) {
  if (lang === "ja") {
    const base = `こんにちは、Phantomresearch Dailyです。${dateText}、今日のテーマは「${topicLabel}」です。`;
    if (paperCount === 0) return `${base}今日は紹介できる論文が見つかりませんでした。`;
    const cue = curated ? "編集部の日本語要約から引用します。" : "原文の英語抄録から冒頭を引用します。";
    return `${base}論文を${countPhrase(lang, paperCount)}、短く紹介します。結果は断定せず、${cue}`;
  }
  if (lang === "en") {
    const base = `Hello, this is Phantomresearch Daily. It is ${dateText}. Today's topic is ${topicLabel}.`;
    if (paperCount === 0) return `${base} No papers were available for today's brief.`;
    const cue = curated ? "Quotes come from our edited Japanese summaries." : "Quotes are the opening of each original English abstract.";
    return `${base} We will look at ${countPhrase(lang, paperCount)} papers, briefly, without claims about results. ${cue}`;
  }
  if (lang === "zh") {
    const base = `你好，这里是 Phantomresearch Daily。今天是${dateText}，主题是「${topicLabel}」。`;
    if (paperCount === 0) return `${base}今天没有找到可以介绍的论文。`;
    const cue = curated ? "引用编辑部日文摘要。" : "引用原文英文摘要开头。";
    return `${base}下面简短介绍${countPhrase(lang, paperCount)}论文，不对结果作断言。${cue}`;
  }
  const base = `안녕하세요, Phantomresearch Daily입니다. ${dateText} 방송입니다. 오늘의 주제는 "${topicLabel}"입니다.`;
  if (paperCount === 0) return `${base} 오늘은 소개할 논문을 찾지 못했습니다.`;
  const cue = curated ? "편집부 일본어 요약에서 인용합니다." : "원문 초록 도입부를 인용합니다.";
  return `${base} 논문 ${countPhrase(lang, paperCount)}을 짧게 소개합니다. 결과를 단정하지 않고, ${cue}`;
}

function paperTitleLine(lang, index, title) {
  const quote = TITLE_QUOTES[lang];
  if (lang === "ja") return `${orderPhrase(lang, index)}、「${title}」。`;
  if (lang === "en") return `${orderPhrase(lang, index)} paper: ${quote[0]}${title}${quote[1]}.`;
  if (lang === "zh") return `第${orderPhrase(lang, index)}篇论文：「${title}」。`;
  return `${orderPhrase(lang, index)} 논문: ${quote[0]}${title}${quote[1]}.`;
}

function outroLines(lang, topicLabel, labels, ids, hasPapers) {
  const list = languageList(lang, labels);
  const idList = ids.join(lang === "en" || lang === "ko" ? ", " : "、");
  const idsLine = ids.length > 0;
  if (lang === "ja") {
    return [
      `今日は「${topicLabel}」でした。`,
      `毎日テーマが変わります。${list}でも配信しています。過去の回はサイトへ。`,
      ...(hasPapers ? ["詳細は各原論文でどうぞ。"] : []),
      "出典はarXiv、各論文のライセンスに従います。音声はローカル生成です。",
      ...(idsLine ? [`論文IDは${idList}です。`] : []),
    ];
  }
  if (lang === "en") {
    return [
      `That is today's topic, ${topicLabel}.`,
      `A new topic every day; the same brief is available in ${list}. Past episodes are on the site.`,
      ...(hasPapers ? ["Please read the original papers for details."] : []),
      "Sources: arXiv, used under each paper's license. This narration was generated locally.",
      ...(idsLine ? [`Paper IDs: ${idList}.`] : []),
    ];
  }
  if (lang === "zh") {
    return [
      `今天的话题是「${topicLabel}」。`,
      `每天更换主题，同一内容有${list}版本，过往节目在网站上。`,
      ...(hasPapers ? ["详情请参阅各原论文。"] : []),
      "来源：arXiv，依各论文的许可使用。本音频由本地生成。",
      ...(idsLine ? [`论文编号：${idList}。`] : []),
    ];
  }
  return [
    `오늘은 "${topicLabel}"이었습니다.`,
    `주제는 매일 바뀝니다. ${list} 버전도 있고, 지난 방송은 사이트에.`,
    ...(hasPapers ? ["자세한 내용은 원문에서."] : []),
    "출처: arXiv, 라이선스는 각 논문을 따릅니다. 로컬에서 생성했습니다.",
    ...(idsLine ? [`논문 번호: ${idList}.`] : []),
  ];
}

// ---- main builder ------------------------------------------------------------

function renderAttempt(language, attempt) {
  const { parsed, topicLabel, curated, papers, labels, joint, cap } = attempt;
  const segments = [];
  segments.push({
    label: "intro",
    text: introLine(language, formatDate(language, parsed), topicLabel, papers.length, curated),
  });

  const ids = [];
  papers.forEach((paper, index) => {
    const title = paper.title.replace(/\s+/g, " ").trim();
    const parts = [paperTitleLine(language, index, title)];
    const author = authorLine(language, paper.authors);
    if (author) parts.push(author);
    const excerpt = trimExcerpt(paper.abstract ?? paper.excerpt ?? "", cap);
    if (excerpt) parts.push(excerpt);
    segments.push({ label: `paper-${index + 1}`, text: parts.join(joint) });
    if (typeof paper.arxivId === "string" && paper.arxivId.trim()) ids.push(paper.arxivId.trim());
  });

  segments.push({ label: "outro", text: outroLines(language, topicLabel, labels, ids, papers.length > 0).join(joint) });
  return { text: segments.map((segment) => segment.text).join("\n"), segments };
}

// Try to keep as many papers as possible, shrinking excerpts first: for each
// paper count (descending) try excerpt caps from full size down to 25%.
function candidatePlans(maxCount) {
  const factors = [1, 0.75, 0.56, 0.42, 0.32, 0.25];
  const plans = [];
  for (let papers = maxCount; papers >= 1; papers -= 1) {
    for (const factor of factors) {
      plans.push({ papers, factor });
    }
  }
  return plans;
}

function prepareContext(language, options) {
  const {
    date,
    topic,
    papers = [],
    languageLabels = {},
    source = "arxiv",
    maxPapers = DEFAULT_MAX_PAPERS,
    maxExcerptChars,
  } = options;
  const parsed = parseISODate(date);
  if (!parsed) throw new Error(`invalid date: ${date}`);
  if (!topic || typeof topic !== "object") throw new Error("topic is required");
  const curated = source === "curated";
  const topicLabel = nestedLabel(topic.labels, language);
  const labels = { ...DEFAULT_LANGUAGE_LABELS, ...(languageLabels && typeof languageLabels === "object" ? languageLabels : {}) };
  const limit = Math.max(40, Math.floor(Number(maxExcerptChars)) || DEFAULT_MAX_EXCERPT[language] || 300);
  const count = Math.max(1, Math.floor(Number(maxPapers)) || DEFAULT_MAX_PAPERS);
  const pool = (Array.isArray(papers) ? papers : []).filter((paper) => paper && typeof paper.title === "string" && paper.title.trim()).slice(0, count);
  return { parsed, curated, topicLabel, labels, limit, pool, joint: JOINT[language] };
}

function evaluatePlans(language, context) {
  const plans = context.pool.length === 0 ? [{ papers: 0, factor: 1 }] : candidatePlans(context.pool.length);
  return plans.map((plan) => {
    const cap = Math.max(40, Math.floor(context.limit * plan.factor));
    const attempt = renderAttempt(language, {
      parsed: context.parsed,
      topicLabel: context.topicLabel,
      curated: context.curated,
      labels: context.labels,
      joint: context.joint,
      papers: context.pool.slice(0, plan.papers),
      cap,
    });
    return {
      papers: plan.papers,
      factor: plan.factor,
      cap,
      estimate: estimateSpokenSeconds(language, attempt.text),
      attempt,
    };
  });
}

// Diagnostics: the plan ladder buildScript walks, with sizes and estimates.
// Used by tests/probes to calibrate the pacing constants against real runs.
export function planEstimates(lang, options = {}) {
  const language = normalizeLang(lang);
  return evaluatePlans(language, prepareContext(language, options)).map((row) => ({
    papers: row.papers,
    factor: row.factor,
    cap: row.cap,
    chars: row.attempt.text.length,
    estimatedSeconds: Math.round(row.estimate * 10) / 10,
    fits: row.estimate <= DURATION_MAX_SECONDS,
  }));
}

export function buildScript(lang, options = {}) {
  const language = normalizeLang(lang);
  const rows = evaluatePlans(language, prepareContext(language, options));
  const chosen = rows.find((row) => row.estimate <= DURATION_MAX_SECONDS) ?? null;
  const best = rows.reduce((acc, row) => (row.estimate < acc.estimate ? row : acc), rows[0]);
  const result = chosen ?? best;
  return {
    text: result.attempt.text,
    segments: result.attempt.segments,
    papersUsed: result.papers,
    excerptLimit: result.cap,
    estimatedSeconds: Math.round(result.estimate * 10) / 10,
  };
}
