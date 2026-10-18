// Builds the spoken script for one language. Templates are fixed sentences
// written in this file; only paper titles, author names and short abstract
// quotes come from arXiv data (quoted in their original language).
//
// The TTS pacing constants (SECONDS_PER_CHAR) estimate the spoken length and
// the plan ladder moves the script in BOTH directions: when the estimate is
// below DURATION_MIN_SECONDS it adds content (more papers, longer excerpts,
// commentary/overview segments), when it is above DURATION_MAX_SECONDS it
// shrinks quotes and paper count. The aim is [min, max) with the estimate as
// close as possible to DURATION_TARGET_SECONDS (5-20 minute episodes, ~11 min
// target).
import { parseISODate } from "./select.mjs";

const DEFAULT_MAX_EXCERPT = { ja: 700, en: 1100, zh: 700, ko: 700 };
const DEFAULT_MAX_PAPERS = 8;
const SUPPORTED = ["ja", "en", "zh", "ko"];
// Special plan factor meaning "use the whole cleaned abstract, no trimming".
const FULL_ABSTRACT_CAP = 1000000;

// Seconds per character with the local Qwen3-TTS voices, measured from real
// synthesize.py runs (ja 0.168, en 0.082, zh 0.134, ko 0.168 s/char).
const SECONDS_PER_CHAR = { ja: 0.1685, en: 0.082, zh: 0.135, ko: 0.1685 };
// Frozen episode-length contract, mirrored by config.json "duration":
// every episode must be >= 5 minutes and < 20 minutes, target ~11 minutes.
export const DURATION_MIN_SECONDS = 300;
export const DURATION_MAX_SECONDS = 1200;
export const DURATION_TARGET_SECONDS = 660;

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
    ja: ["", "一本", "二本", "三本", "四本", "五本", "六本", "七本", "八本"],
    en: ["", "one", "two", "three", "four", "five", "six", "seven", "eight"],
    zh: ["", "一篇", "两篇", "三篇", "四篇", "五篇", "六篇", "七篇", "八篇"],
    ko: ["", "한 편", "두 편", "세 편", "네 편", "다섯 편", "여섯 편", "일곱 편", "여덟 편"],
  };
  return words[lang][count] ?? (lang === "ja" ? `${count}本` : lang === "zh" ? `${count}篇` : lang === "ko" ? `${count}편` : String(count));
}

function orderPhrase(lang, index) {
  const words = {
    ja: ["一本目", "二本目", "三本目", "四本目", "五本目", "六本目", "七本目", "八本目"],
    en: ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"],
    zh: ["一", "二", "三", "四", "五", "六", "七", "八"],
    ko: ["첫 번째", "두 번째", "세 번째", "네 번째", "다섯 번째", "여섯 번째", "일곱 번째", "여덟 번째"],
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

// Deterministic template pick: rotates with the calendar day and the paper
// index, so scripts stay stable for a given date without any content claims.
function templateFor(variants, parsed, index) {
  const day = parsed ? parsed.day : 0;
  const slice = ((day + Math.max(0, Math.floor(index))) % variants.length + variants.length) % variants.length;
  return variants[slice];
}

// ---- fixed templates per language -------------------------------------------

function introLine(lang, dateText, topicLabel, paperCount, curated) {
  if (lang === "ja") {
    const base = `こんにちは、Phantomresearch Dailyです。${dateText}、今日のテーマは「${topicLabel}」です。`;
    if (paperCount === 0) return `${base}今日は紹介できる論文が見つかりませんでした。`;
    const cue = curated ? "編集部の日本語要約から引用します。" : "原文の英語抄録から冒頭を引用します。";
    return `${base}論文を${countPhrase(lang, paperCount)}、ゆっくり紹介します。結果は断定せず、${cue}`;
  }
  if (lang === "en") {
    const base = `Hello, this is Phantomresearch Daily. It is ${dateText}. Today's topic is ${topicLabel}.`;
    if (paperCount === 0) return `${base} No papers were available for today's brief.`;
    const cue = curated ? "Quotes come from our edited Japanese summaries." : "Quotes are the opening of each original English abstract.";
    return `${base} We will walk through ${countPhrase(lang, paperCount)} papers, without claims about results. ${cue}`;
  }
  if (lang === "zh") {
    const base = `你好，这里是 Phantomresearch Daily。今天是${dateText}，主题是「${topicLabel}」。`;
    if (paperCount === 0) return `${base}今天没有找到可以介绍的论文。`;
    const cue = curated ? "引用编辑部日文摘要。" : "引用原文英文摘要开头。";
    return `${base}下面详细介绍${countPhrase(lang, paperCount)}论文，不对结果作断言。${cue}`;
  }
  const base = `안녕하세요, Phantomresearch Daily입니다. ${dateText} 방송입니다. 오늘의 주제는 "${topicLabel}"입니다.`;
  if (paperCount === 0) return `${base} 오늘은 소개할 논문을 찾지 못했습니다.`;
  const cue = curated ? "편집부 일본어 요약에서 인용합니다." : "원문 초록 도입부를 인용합니다.";
  return `${base} 논문 ${countPhrase(lang, paperCount)}편을 차례로 소개합니다. 결과를 단정하지 않고, ${cue}`;
}

// Fixed topic overview right after the intro: pure filler-free framing that
// says nothing about the paper contents, only how the episode is organized.
function topicOverviewLine(lang, topicLabel, parsed) {
  if (lang === "ja") {
    return templateFor([
      `「${topicLabel}」をめぐる研究は幅が広く、今日は選ばれた順に条件を付けて追いかけます。気になる論文だけ原書に飛ばず、まず全体を聞き流していただくのがおすすめです。`,
      `今日のテーマ「${topicLabel}」は、日替わりの選題ルールで決まっています。披露する順に聞いていただき、気になった本を原論文で裏取りするのが確実です。`,
      `「${topicLabel}」という切り口で、今日も論文を集めました。内容の評価はせず、紹介と資料の提示に絞った回です。`,
    ], parsed, 0);
  }
  if (lang === "en") {
    return templateFor([
      `Research around ${topicLabel} covers a wide range, and today we go through the picks one by one. Listen for the overall picture, then follow the papers that catch your interest. The same brief goes out in four languages.`,
      `The topic ${topicLabel} is chosen by our daily rotation rule. We will not grade the results; each paper is simply introduced and linked. Every day brings a new topic.`,
      `Today's collection is framed by ${topicLabel}. Treat this episode as a starting point: the original papers remain the only source of claims.` ,
    ], parsed, 0);
  }
  if (lang === "zh") {
    return templateFor([
      `围绕「${topicLabel}」的研究范围很广，今天按顺序逐篇介绍。建议先整体听一遍，再跟进感兴趣的论文。同样的内容也以四种语言发布。`,
      `今天的主题「${topicLabel}」由每日轮换规则决定。我们不对结果下判断，只做介绍并给出资料链接。`,
      `今天以「${topicLabel}」为线索整理了几篇论文。本节目只负责介绍，具体结论请以原论文为准。`,
    ], parsed, 0);
  }
  return templateFor([
    `"${topicLabel}"을 둘러싼 연구는 폭이 넓어, 오늘은 고른 순서대로 하나씩 살펴봅니다. 전체를 먼저 들으시고, 마음에 드는 논문만 원문으로 따라가 보세요. 같은 내용은 네 언어로도 전달합니다.`,
    `오늘의 주제 "${topicLabel}"는 매일 바뀌는 순환 규칙으로 정해졌습니다. 결과를 평가하지 않고 소개와 자료 링크만 다룹니다.`,
    `"${topicLabel}"이라는 주제로 오늘도 논문을 모았습니다. 이 방송은 소개에 그치고, 구체적인 결론은 원문에서 확인하세요.`,
  ], parsed, 0);
}

// Fixed per-paper commentary: two or three sentences of neutral framing with
// no claims about the paper's contents, rotated deterministically by date.
function commentaryLine(lang, parsed, index) {
  if (lang === "ja") {
    return templateFor([
      "この研究は分野の中でも新しいアプローチにとどまり、手法の詳細や性能評価の妥当性は原論文で確認してください。ここから先の判断はしないのが方針です。",
      "抄録からは結果の強さを測れません。評価の前提や実験の範囲は本文と図表で確かめてみてください。",
      "用語の定義や手法の限界も、著者自身の言葉で読むのが一番確実です。次の論文に移る前に、気になる原書を開いてみてください。",
      "この論文の位置づけを断定するのは避けて、みなさんの目で原論文を確かめてもらえたら幸いです。引用に含まれていない部分にも情報があります。",
    ], parsed, index);
  }
  if (lang === "en") {
    return templateFor([
      "The method details and the validity of its evaluation are worth checking in the original paper; we make no claims about the results here.",
      "An abstract cannot tell you how strong the results are, so look at the evaluation setup and the limitations section directly.",
      "Terms and scope are easier to verify in the paper's own words. If it interests you, open the preprint before moving on.",
      "We deliberately avoid judging where this work sits in the field; the authors' own text and figures say it better.",
    ], parsed, index);
  }
  if (lang === "zh") {
    return templateFor([
      "这篇论文采用的新方法细节与评测是否可靠，需要到原论文中确认，本节目不做判断。",
      "仅凭摘要无法判断结果有多强，评测的前提和实验范围请看正文与图表。",
      "术语定义和方法局限，读作者本人的表述最可靠，感兴趣的听众可以打开原文对照。",
      "我们刻意不在节目里给这项研究定位，作者的原文和图示说得比摘要更清楚。",
    ], parsed, index);
  }
  return templateFor([
    "이 연구의 방법 세부사항과 평가의 신뢰성은 원문에서 확인하시고, 이 방송은 결과에 대해 판단하지 않습니다.",
    "초록만으로 결과의 강도는 알 수 없습니다. 평가 전제와 실험 범위는 본문과 그림을 직접 보세요.",
    "용어 정의와 방법의 한계는 저자의 표현 그대로 읽는 게 가장 정확합니다. 관심 있으면 원문을 열어 보세요.",
    "이 연구의 위상을 단정하지는 않습니다. 저자의 원문과 그림이 요약보다 정확합니다.",
  ], parsed, index);
}

function paperTitleLine(lang, index, title) {
  const quote = TITLE_QUOTES[lang];
  if (lang === "ja") return `${orderPhrase(lang, index)}、「${title}」。`;
  if (lang === "en") return `${orderPhrase(lang, index)} paper: ${quote[0]}${title}${quote[1]}.`;
  if (lang === "zh") return `第${orderPhrase(lang, index)}篇论文：「${title}」。`;
  return `${orderPhrase(lang, index)} 논문: ${quote[0]}${title}${quote[1]}.`;
}

// Fixed outro, now with a spoken recap of the paper titles and a teaser for
// the next day's (different) topic. ids is the arXiv id list.
function outroLines(lang, topicLabel, labels, ids, hasPapers, paperTitles, dateText) {
  const list = languageList(lang, labels);
  const idList = ids.join(lang === "en" || lang === "ko" ? ", " : "、");
  const idsLine = ids.length > 0;
  const quote = TITLE_QUOTES[lang];
  const titles = (paperTitles ?? []).map((title) => `${quote[0]}${title}${quote[1]}`);
  const recap = titles.join(lang === "en" || lang === "ko" ? ", " : "、");
  if (lang === "ja") {
    return [
      `今日は「${topicLabel}」でした。`,
      ...(hasPapers && titles.length > 0 ? [`今日の論文は${countPhrase(lang, titles.length)}、${recap}でした。`] : []),
      "明日の回はまた別のテーマです。どんな分野が選ばれるかは、あした聞いてみてください。",
      `毎日テーマが変わります。${list}でも配信しています。過去の回はサイトへ。`,
      ...(hasPapers ? ["詳細は各原論文でどうぞ。"] : []),
      "出典はarXiv、各論文のライセンスに従います。音声はローカル生成です。",
      ...(idsLine ? [`論文IDは${idList}です。`] : []),
      `今日は${dateText}の回でした。それでは、また明日。`,
    ];
  }
  if (lang === "en") {
    return [
      `That is today's topic, ${topicLabel}.`,
      ...(hasPapers && titles.length > 0 ? [`Today's ${titles.length === 1 ? "paper was" : "papers were"} ${recap}.`] : []),
      "Tomorrow's episode covers a different topic; tune in to see which field gets picked.",
      `A new topic every day; the same brief is available in ${list}. Past episodes are on the site.`,
      ...(hasPapers ? ["Please read the original papers for details."] : []),
      "Sources: arXiv, used under each paper's license. This narration was generated locally.",
      ...(idsLine ? [`Paper IDs: ${idList}.`] : []),
      `This was the ${dateText} episode. Thanks for listening, and see you tomorrow.`,
    ];
  }
  if (lang === "zh") {
    return [
      `今天的话题是「${topicLabel}」。`,
      ...(hasPapers && titles.length > 0 ? [`今天的${titles.length === 1 ? "论文是" : "论文分别是"}${recap}。`] : []),
      "明天的节目会带来另一个主题，欢迎到时收听。",
      `每天更换主题，同一内容有${list}版本，过往节目在网站上。`,
      ...(hasPapers ? ["详情请参阅各原论文。"] : []),
      "来源：arXiv，依各论文的许可使用。本音频由本地生成。",
      ...(idsLine ? [`论文编号：${idList}。`] : []),
      `以上就是${dateText}这一期，感谢收听，明天见。`,
    ];
  }
  return [
    `오늘은 "${topicLabel}"이었습니다.`,
    ...(hasPapers && titles.length > 0 ? [`오늘의 논문 ${countPhrase(lang, titles.length)}은 ${recap}였습니다.`] : []),
    "내일 에피소드는 다른 주제를 준비했습니다. 어떤 분야가 선택될지 내일 확인해 보세요.",
    `주제는 매일 바뀝니다. ${list} 버전도 있고, 지난 방송은 사이트에.`,
    ...(hasPapers ? ["자세한 내용은 원문에서."] : []),
    "출처: arXiv, 라이선스는 각 논문을 따릅니다. 로컬에서 생성했습니다.",
    ...(idsLine ? [`논문 번호: ${idList}.`] : []),
    `${dateText} 방송이었습니다. 감사합니다. 내일 만나요.`,
  ];
}

// ---- main builder ------------------------------------------------------------

function renderAttempt(language, attempt) {
  const { parsed, topicLabel, curated, papers, labels, joint, cap, dateText } = attempt;
  const segments = [];
  segments.push({
    label: "intro",
    text: introLine(language, dateText, topicLabel, papers.length, curated),
  });
  segments.push({
    label: "topic-overview",
    text: topicOverviewLine(language, topicLabel, parsed),
  });

  const ids = [];
  const titles = [];
  papers.forEach((paper, index) => {
    const title = paper.title.replace(/\s+/g, " ").trim();
    titles.push(title);
    const parts = [paperTitleLine(language, index, title)];
    const author = authorLine(language, paper.authors);
    if (author) parts.push(author);
    const excerpt = trimExcerpt(paper.abstract ?? paper.excerpt ?? "", cap);
    if (excerpt) parts.push(excerpt);
    segments.push({ label: `paper-${index + 1}`, text: parts.join(joint) });
    segments.push({ label: `commentary-paper${index + 1}`, text: commentaryLine(language, parsed, index) });
    if (typeof paper.arxivId === "string" && paper.arxivId.trim()) ids.push(paper.arxivId.trim());
  });

  segments.push({
    label: "outro",
    text: outroLines(language, topicLabel, labels, ids, papers.length > 0, titles, dateText).join(joint),
  });
  return { text: segments.map((segment) => segment.text).join("\n"), segments };
}

// Plan ladder BOTH ways: for each paper count (walking down from the pool)
// try excerpt caps from full size down to 25%, then one growth plan that uses
// the entire abstract of every available paper. Plans are all evaluated and
// the one whose estimate lands inside [min, max) closest to the target wins.
function candidatePlans(maxCount) {
  const factors = [1, 0.75, 0.56, 0.42, 0.32, 0.25];
  const plans = [];
  for (let papers = maxCount; papers >= 1; papers -= 1) {
    for (const factor of factors) {
      plans.push({ papers, factor });
    }
  }
  // Undersized pools / very short abstracts: last resort, quote everything.
  plans.push({ papers: maxCount, factor: FULL_ABSTRACT_CAP });
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
  const limit = Math.max(40, Math.floor(Number(maxExcerptChars)) || DEFAULT_MAX_EXCERPT[language] || 1100);
  const count = Math.max(1, Math.floor(Number(maxPapers)) || DEFAULT_MAX_PAPERS);
  const pool = (Array.isArray(papers) ? papers : []).filter((paper) => paper && typeof paper.title === "string" && paper.title.trim()).slice(0, count);
  return { parsed, curated, topicLabel, labels, limit, pool, joint: JOINT[language], dateText: formatDate(language, parsed) };
}

function evaluatePlans(language, context) {
  const plans = context.pool.length === 0 ? [{ papers: 0, factor: 1 }] : candidatePlans(context.pool.length);
  return plans.map((plan) => {
    const cap = plan.factor === FULL_ABSTRACT_CAP ? FULL_ABSTRACT_CAP : Math.max(40, Math.floor(context.limit * plan.factor));
    const attempt = renderAttempt(language, {
      parsed: context.parsed,
      topicLabel: context.topicLabel,
      curated: context.curated,
      labels: context.labels,
      joint: context.joint,
      dateText: context.dateText,
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

// Pick the plan whose estimate is inside [min, max) and closest to the target.
// When nothing reaches min (tiny pool / no abstracts), take the largest
// fitting estimate and mark the episode a "short day" instead of deadlocking;
// when everything overshoots max, fall back to the smallest estimate
// (the shrinking direction always has the final say).
function choosePlan(rows) {
  const fitting = rows.filter((row) => row.estimate < DURATION_MAX_SECONDS);
  if (fitting.length === 0) {
    return rows.reduce((acc, row) => (row.estimate < acc.estimate ? row : acc), rows[0]);
  }
  const inside = fitting.filter((row) => row.estimate >= DURATION_MIN_SECONDS);
  const pool = inside.length > 0 ? inside : fitting;
  return pool.reduce((acc, row) =>
    Math.abs(row.estimate - DURATION_TARGET_SECONDS) < Math.abs(acc.estimate - DURATION_TARGET_SECONDS) ? row : acc, pool[0]);
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
    fits: row.estimate >= DURATION_MIN_SECONDS && row.estimate < DURATION_MAX_SECONDS,
  }));
}

const round10 = (value) => Math.round(value * 10) / 10;

export function buildScript(lang, options = {}) {
  const language = normalizeLang(lang);
  const rows = evaluatePlans(language, prepareContext(language, options));
  const chosen = choosePlan(rows);
  return {
    text: chosen.attempt.text,
    segments: chosen.attempt.segments,
    papersUsed: chosen.papers,
    excerptLimit: chosen.cap,
    estimatedSeconds: round10(chosen.estimate),
    plannedSeconds: Math.round(chosen.estimate),
    minSeconds: DURATION_MIN_SECONDS,
    maxSeconds: DURATION_MAX_SECONDS,
    targetSeconds: DURATION_TARGET_SECONDS,
    met: chosen.estimate >= DURATION_MIN_SECONDS && chosen.estimate < DURATION_MAX_SECONDS,
  };
}
