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
//
// Lineup (2026-10): ja / zh / de / es / ru / it. English and Korean left the
// lineup; buildScript("en"/"ko") is deliberately an unsupported-language error.
// Their templates were removed, not translated — the six kept languages each
// get native, deterministic filler with no content claims.
import { parseISODate } from "./select.mjs";

// Language-order in the lineup drives labels/joins; excerpt defaults mirror
// config.json maxExcerptChars (CJK shorter, Latin/Cyrillic scripts longer).
const DEFAULT_MAX_EXCERPT = { ja: 700, zh: 700, de: 1100, es: 1100, ru: 1100, it: 1100 };
const DEFAULT_MAX_PAPERS = 8;
// en/ko buildScript calls must fail loudly (unsupported language).
const SUPPORTED = ["ja", "zh", "de", "es", "ru", "it"];
// Special plan factor meaning "use the whole cleaned abstract, no trimming".
const FULL_ABSTRACT_CAP = 1000000;

// Seconds per character estimates for the edge/voicestudio voices, used to
// size scripts toward the frozen duration window. Provisional values (not yet
// measured from long real runs): ja/zh from the historical qwen measurements,
// de/es/ru/it are first-cut guesses calibrated against typical neural TTS
// speaking rates of these languages; recalibrate after real synthesis runs.
const SECONDS_PER_CHAR = { ja: 0.1685, zh: 0.135, de: 0.095, es: 0.105, ru: 0.095, it: 0.098 };
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

// JOINT "" means "no space needed between clauses" (CJK), used only where the
// gluing language is the script language itself.
const JOINT = { ja: "", zh: "", de: " ", es: " ", ru: " ", it: " " };
// CJK keeps corner brackets; German uses the low-high „…" pair; Spanish,
// Russian and Italian use guillemets «…».
const TITLE_QUOTES = {
  ja: ["「", "」"],
  zh: ["「", "」"],
  de: ["\u201E", "\u201C"],
  es: ["«", "»"],
  ru: ["«", "»"],
  it: ["«", "»"],
};
const MONTHS_DE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MONTHS_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_IT = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const DEFAULT_LANGUAGE_LABELS = { ja: "日本語", zh: "中文", de: "Deutsch", es: "Español", ru: "Русский", it: "Italiano" };

function normalizeLang(lang) {
  const value = String(lang ?? "").trim().toLowerCase();
  if (!SUPPORTED.includes(value)) throw new Error(`unsupported language: ${lang}`);
  return value;
}

function formatDate(lang, parsed) {
  if (lang === "ja" || lang === "zh") return `${parsed.year}年${parsed.month}月${parsed.day}日`;
  if (lang === "de") return `${parsed.day}. ${MONTHS_DE[parsed.month - 1]} ${parsed.year}`;
  if (lang === "es") return `${parsed.day} de ${MONTHS_ES[parsed.month - 1]} de ${parsed.year}`;
  if (lang === "ru") return `${parsed.day} ${MONTHS_RU[parsed.month - 1]} ${parsed.year}`;
  return `${parsed.day} ${MONTHS_IT[parsed.month - 1]} ${parsed.year}`;
}

function countPhrase(lang, count) {
  const words = {
    ja: ["", "一本", "二本", "三本", "四本", "五本", "六本", "七本", "八本"],
    zh: ["", "一篇", "两篇", "三篇", "四篇", "五篇", "六篇", "七篇", "八篇"],
    de: ["", "ein Paper", "zwei Paper", "drei Paper", "vier Paper", "fünf Paper", "sechs Paper", "sieben Paper", "acht Paper"],
    es: ["", "un artículo", "dos artículos", "tres artículos", "cuatro artículos", "cinco artículos", "seis artículos", "siete artículos", "ocho artículos"],
    ru: ["", "одну статью", "две статьи", "три статьи", "четыре статьи", "пять статей", "шесть статей", "семь статей", "восемь статей"],
    it: ["", "un articolo", "due articoli", "tre articoli", "quattro articoli", "cinque articoli", "sei articoli", "sette articoli", "otto articoli"],
  };
  return words[lang][count] ?? (lang === "ja" ? `${count}本` : lang === "zh" ? `${count}篇` : String(count));
}

function orderPhrase(lang, index) {
  const words = {
    ja: ["一本目", "二本目", "三本目", "四本目", "五本目", "六本目", "七本目", "八本目"],
    zh: ["一", "二", "三", "四", "五", "六", "七", "八"],
    de: ["Der erste Beitrag", "Der zweite Beitrag", "Der dritte Beitrag", "Der vierte Beitrag", "Der fünfte Beitrag", "Der sechste Beitrag", "Der siebte Beitrag", "Der achte Beitrag"],
    es: ["El primer artículo", "El segundo artículo", "El tercer artículo", "El cuarto artículo", "El quinto artículo", "El sexto artículo", "El séptimo artículo", "El octavo artículo"],
    ru: ["Первая статья", "Вторая статья", "Третья статья", "Четвёртая статья", "Пятая статья", "Шестая статья", "Седьмая статья", "Восьмая статья"],
    it: ["Il primo articolo", "Il secondo articolo", "Il terzo articolo", "Il quarto articolo", "Il quinto articolo", "Il sesto articolo", "Il settimo articolo", "L'ottavo articolo"],
  };
  return words[lang][index] ?? (lang === "ja" ? `${index + 1}本目` : String(index + 1));
}

function authorLine(lang, authors) {
  const list = (Array.isArray(authors) ? authors : []).map((name) => String(name ?? "").trim()).filter(Boolean);
  if (list.length === 0) return null;
  const first = list.slice(0, 3);
  const more = list.length > first.length;
  if (lang === "ja") return `著者は${first.join("、")}${more ? "ほか" : ""}です。`;
  if (lang === "zh") return `作者是${first.join("、")}${more ? "等" : ""}。`;
  if (lang === "de") return `Die Autorinnen und Autoren sind ${first.join(", ")}${more ? " et al" : ""}.`;
  if (lang === "es") return `Los autores son ${first.join(", ")}${more ? ", et al" : ""}.`;
  if (lang === "ru") return `Авторы: ${first.join(", ")}${more ? " и др" : ""}.`;
  return `Gli autori sono ${first.join(", ")}${more ? ", et al" : ""}.`;
}

function languageList(lang, labels) {
  const values = SUPPORTED.map((key) => labels[key] ?? DEFAULT_LANGUAGE_LABELS[key]);
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
  if (lang === "zh") {
    const base = `你好，这里是 Phantomresearch Daily。今天是${dateText}，主题是「${topicLabel}」。`;
    if (paperCount === 0) return `${base}今天没有找到可以介绍的论文。`;
    const cue = curated ? "引用编辑部日文摘要。" : "引用原文英文摘要开头。";
    return `${base}下面详细介绍${countPhrase(lang, paperCount)}论文，不对结果作断言。${cue}`;
  }
  if (lang === "de") {
    const base = `Hallo, hier ist Phantomresearch Daily. Es ist der ${dateText}. Das heutige Thema ist ${topicLabel}.`;
    if (paperCount === 0) return `${base} Für das heutige Briefing standen keine Papers zur Verfügung.`;
    const cue = curated ? "Zitate stammen aus unseren redaktionellen japanischen Zusammenfassungen." : "Zitate sind die Anfänge der jeweiligen englischen Original-Abstracts.";
    return `${base} Wir gehen ${countPhrase(lang, paperCount)} in Ruhe durch, ohne Aussagen über die Ergebnisse. ${cue}`;
  }
  if (lang === "es") {
    const base = `Hola, esto es Phantomresearch Daily. Hoy es ${dateText}. El tema de hoy es ${topicLabel}.`;
    if (paperCount === 0) return `${base} Hoy no hubo artículos disponibles para el resumen.`;
    const cue = curated ? "Las citas provienen de nuestros resúmenes japoneses editados." : "Las citas son el inicio de cada resumen original en inglés.";
    return `${base} Repasaremos ${countPhrase(lang, paperCount)} con calma, sin afirmar nada sobre los resultados. ${cue}`;
  }
  if (lang === "ru") {
    const base = `Здравствуйте, это Phantomresearch Daily. Сегодня ${dateText}. Тема выпуска — «${topicLabel}».`;
    if (paperCount === 0) return `${base} Сегодня статьи для краткого обзора не нашлись.`;
    const cue = curated ? "Цитаты взяты из наших редакционных японских пересказов." : "Цитаты — это начало каждого оригинального английского абстракта.";
    return `${base} Мы спокойно разберём ${countPhrase(lang, paperCount)}, не делая заявлений о результатах. ${cue}`;
  }
  const base = `Ciao, questo è Phantomresearch Daily. Oggi è ${dateText}. Il tema di oggi è ${topicLabel}.`;
  if (paperCount === 0) return `${base} Oggi non ci sono articoli disponibili per il brief.`;
  const cue = curated ? "Le citazioni provengono dalle nostre sintesi giapponesi a cura della redazione." : "Le citazioni sono l'inizio di ogni abstract originale in inglese.";
  return `${base} Passeremo in rassegna ${countPhrase(lang, paperCount)} senza fretta, senza affermazioni sui risultati. ${cue}`;
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
  if (lang === "zh") {
    return templateFor([
      `围绕「${topicLabel}」的研究范围很广，今天按顺序逐篇介绍。建议先整体听一遍，再跟进感兴趣的论文。同样的内容也以六种语言发布。`,
      `今天的主题「${topicLabel}」由每日轮换规则决定。我们不对结果下判断，只做介绍并给出资料链接。`,
      `今天以「${topicLabel}」为线索整理了几篇论文。本节目只负责介绍，具体结论请以原论文为准。`,
    ], parsed, 0);
  }
  if (lang === "de") {
    return templateFor([
      `Die Forschung rund um ${topicLabel} ist breit gefächert; heute gehen wir die Auswahl der Reihe nach durch. Hören Sie zuerst grob mit und folgen Sie nur den Papers, die Sie interessieren. Derselbe Brief erscheint in sechs Sprachen.`,
      `Das heutige Thema ${topicLabel} wird von der täglichen Rotationsregel bestimmt. Wir bewerten die Ergebnisse nicht; jedes Paper wird nur vorgestellt und verlinkt. Jeden Tag gibt es ein neues Thema.`,
      `Heute haben wir unter dem Blickwinkel ${topicLabel} einige Papers versammelt. Diese Folge ist eine Einführung; konkrete Schlussfolgerungen stehen in den Originalpapern.`,
    ], parsed, 0);
  }
  if (lang === "es") {
    return templateFor([
      `La investigación en torno a ${topicLabel} abarca un amplio espectro; hoy repasamos la selección en orden. Escuche primero la vista general y siga solo los artículos que le interesen. El mismo resumen se publica en seis idiomas.`,
      `El tema de hoy, ${topicLabel}, lo decide la regla de rotación diaria. No juzgamos los resultados: solo presentamos cada artículo y damos su enlace. Cada día hay un tema nuevo.`,
      `Hoy hemos reunido varios artículos bajo el enfoque de ${topicLabel}. Esta entrega es solo una presentación; las conclusiones están en los artículos originales.`,
    ], parsed, 0);
  }
  if (lang === "ru") {
    return templateFor([
      `Исследования вокруг темы «${topicLabel}» очень широки; сегодня мы разбираем подборку по порядку. Сначала послушайте обзор, а затем вернитесь к статьям, которые вас заинтересовали. Тот же выпуск выходит на шести языках.`,
      `Тема дня — «${topicLabel}» — определяется правилом ежедневной ротации. Мы не оцениваем результаты: только представляем статьи и даём ссылки. Каждый день — новая тема.`,
      `Сегодня под углом «${topicLabel}» собраны несколько статей. Этот выпуск только знакомит; конкретные выводы — в оригинальных статьях.`,
    ], parsed, 0);
  }
  return templateFor([
    `La ricerca intorno a ${topicLabel} è molto ampia; oggi esaminiamo la selezione in ordine. Ascoltate prima il quadro generale e seguite solo gli articoli che vi interessano. Lo stesso brief esce in sei lingue.`,
    `Il tema di oggi, ${topicLabel}, è scelto dalla regola di rotazione giornaliera. Non giudichiamo i risultati: presentiamo ogni articolo e forniamo il link. Ogni giorno un tema nuovo.`,
    `Oggi, con il filo di ${topicLabel}, abbiamo raccolto alcuni articoli. Questa puntata serve solo a presentare; le conclusioni sono negli articoli originali.`,
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
  if (lang === "zh") {
    return templateFor([
      "这篇论文采用的新方法细节与评测是否可靠，需要到原论文中确认，本节目不做判断。",
      "仅凭摘要无法判断结果有多强，评测的前提和实验范围请看正文与图表。",
      "术语定义和方法局限，读作者本人的表述最可靠，感兴趣的听众可以打开原文对照。",
      "我们刻意不在节目里给这项研究定位，作者的原文和图示说得比摘要更清楚。",
    ], parsed, index);
  }
  if (lang === "de") {
    return templateFor([
      "Details des Verfahrens und die Tragfähigkeit der Evaluierung prüfen Sie am besten im Originalpaper; hier treffen wir keine Aussagen über die Ergebnisse.",
      "Ein Abstract verrät nicht, wie stark die Ergebnisse sind; sehen Sie sich direkt die Bewertungsgrundlagen und den Gültigkeitsbereich der Experimente an.",
      "Begriffsdefinitionen und Grenzen der Methode liest man am zuverlässigsten in den Worten der Autoren selbst. Interessiert Sie das, öffnen Sie das Preprint, bevor es weitergeht.",
      "Wir vermeiden es bewusst, die Einordnung dieser Arbeit zu beurteilen; der eigene Text und die Figuren der Autoren sagen es besser.",
    ], parsed, index);
  }
  if (lang === "es") {
    return templateFor([
      "Los detalles del método y la validez de su evaluación conviene comprobarlos en el artículo original; aquí no afirmamos nada sobre los resultados.",
      "Un resumen no permite medir la solidez de los resultados; revise directamente el diseño de evaluación y sus limitaciones.",
      "Términos y alcance se comprueban mejor con las palabras de los autores. Si le interesa, abra la versión preprint antes de continuar.",
      "Evitamos deliberadamente situar este trabajo en el campo; el texto y las figuras de los autores lo dicen mejor.",
    ], parsed, index);
  }
  if (lang === "ru") {
    return templateFor([
      "Детали метода и корректность оценки лучше проверять в первоисточнике; здесь мы ничего не утверждаем о результатах.",
      "По аннотации нельзя судить о силе результатов: посмотрите напрямую условия оценки и пределы экспериментов.",
      "Определения терминов и ограничения метода надёжнее читать в словах самих авторов. Если интересно, откройте препринт, прежде чем идти дальше.",
      "Мы сознательно не даём оценку месту этой работы в области; текст и рисунки авторов говорят об этом лучше.",
    ], parsed, index);
  }
  return templateFor([
    "I dettagli del metodo e la validità della sua valutazione vanno verificati nell'articolo originale; qui non affermiamo nulla sui risultati.",
    "Da un abstract non si capisce quanto siano solidi i risultati: guardate direttamente le premesse della valutazione e l'ambito degli esperimenti.",
    "Definizioni di termini e limiti del metodo si verificano meglio con le parole degli autori. Se vi interessa, aprite il preprint prima di proseguire.",
    "Evitiamo di proposito di giudicare la posizione di questo lavoro nel campo; testo e figure degli autori lo dicono meglio.",
  ], parsed, index);
}

function paperTitleLine(lang, index, title) {
  const quote = TITLE_QUOTES[lang];
  if (lang === "ja") return `${orderPhrase(lang, index)}、「${title}」。`;
  if (lang === "zh") return `第${orderPhrase(lang, index)}篇论文：「${title}」。`;
  return `${orderPhrase(lang, index)}: ${quote[0]}${title}${quote[1]}.`;
}

// Fixed outro, now with a spoken recap of the paper titles and a teaser for
// the next day's (different) topic. ids is the arXiv id list.
function outroLines(lang, topicLabel, labels, ids, hasPapers, paperTitles, dateText) {
  const list = languageList(lang, labels);
  const recapJoin = JOINT[lang] === "" ? "、" : ", ";
  const idList = ids.join(recapJoin);
  const idsLine = ids.length > 0;
  const quote = TITLE_QUOTES[lang];
  const titles = (paperTitles ?? []).map((title) => `${quote[0]}${title}${quote[1]}`);
  const recap = titles.join(recapJoin);
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
  if (lang === "de") {
    return [
      `Das war das heutige Thema: ${topicLabel}.`,
      ...(hasPapers && titles.length > 0 ? [`${titles.length === 1 ? "Das heutige Paper war" : "Die heutigen Papers waren"} ${recap}.`] : []),
      "Die morgige Folge bringt wieder ein anderes Thema; hören Sie hinein, um zu sehen, welches Feld gewählt wird.",
      `Jeden Tag ein neues Thema; derselbe Brief ist in ${list} verfügbar. Frühere Folgen stehen auf der Website.`,
      ...(hasPapers ? ["Bitte lesen Sie die Originalpapers für Details."] : []),
      "Quellen: arXiv, jeweils unter der Lizenz der Papers. Die Sprecherzählung wurde lokal erzeugt.",
      ...(idsLine ? [`Paper-IDs: ${idList}.`] : []),
      `Das war die Folge vom ${dateText}. Danke fürs Zuhören, bis morgen.`,
    ];
  }
  if (lang === "es") {
    return [
      `Ese ha sido el tema de hoy: ${topicLabel}.`,
      ...(hasPapers && titles.length > 0 ? [`${titles.length === 1 ? "El artículo de hoy fue" : "Los artículos de hoy fueron"} ${recap}.`] : []),
      "La entrega de mañana cubre otro tema; sintonice para ver qué campo se elige.",
      `Un tema nuevo cada día; el mismo resumen está disponible en ${list}. Los episodios anteriores están en el sitio.`,
      ...(hasPapers ? ["Lea los artículos originales para más detalles."] : []),
      "Fuentes: arXiv, según la licencia de cada artículo. Esta narración se generó localmente.",
      ...(idsLine ? [`IDs de los artículos: ${idList}.`] : []),
      `Este fue el episodio del ${dateText}. Gracias por escuchar; hasta mañana.`,
    ];
  }
  if (lang === "ru") {
    return [
      `Сегодняшняя тема была такой: «${topicLabel}».`,
      ...(hasPapers && titles.length > 0 ? [`${titles.length === 1 ? "Сегодняшней статьёй была" : "Сегодняшние статьи:"} ${recap}.`] : []),
      "Завтрашний выпуск посвящён другой теме; загляните, какое поле выберут.",
      `Каждый день новая тема; тот же обзор доступен на ${list}. Прошлые выпуски — на сайте.`,
      ...(hasPapers ? ["Подробности читайте в оригинальных статьях."] : []),
      "Источники: arXiv, на условиях лицензии каждой статьи. Озвучка создана локально.",
      ...(idsLine ? [`ID статей: ${idList}.`] : []),
      `Это был выпуск за ${dateText}. Спасибо, что слушали; до завтра.`,
    ];
  }
  return [
    `Era questo il tema di oggi: ${topicLabel}.`,
    ...(hasPapers && titles.length > 0 ? [`${titles.length === 1 ? "L'articolo di oggi era" : "Gli articoli di oggi erano"} ${recap}.`] : []),
    "La puntata di domani riguarderà un altro tema; restate sintonizzati per vedere quale campo verrà scelto.",
    `Ogni giorno un tema nuovo; lo stesso brief è disponibile in ${list}. Le puntate passate sono sul sito.`,
    ...(hasPapers ? ["Per i dettagli, leggete gli articoli originali."] : []),
    "Fonti: arXiv, secondo la licenza di ogni articolo. Questa narrazione è stata generata localmente.",
    ...(idsLine ? [`ID degli articoli: ${idList}.`] : []),
    `Questa era la puntata del ${dateText}. Grazie per l'ascolto, a domani.`,
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
