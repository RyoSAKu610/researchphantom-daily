// Server-rendered shell for the 音の図書館 library page. Everything here also
// works without JavaScript (native <audio>, download links, paper links);
// app.js upgrades it into the shelf, sheet and persistent player.
import { readFileSync } from "node:fs";
import { icon, iconSprite } from "./icons.mjs";
import { ATMOSPHERES, atmosphereCatalog, atmosphereCss } from "./atmospheres.mjs";

const STYLE = `${readFileSync(new URL("./app.css", import.meta.url), "utf8")}${atmosphereCss()}`;
const SCRIPT = readFileSync(new URL("./app.js", import.meta.url), "utf8");
if (/<\/style/i.test(STYLE) || /<\/script/i.test(SCRIPT)) {
  throw new Error("site-ui assets must not contain closing style/script tags");
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function dateLabel(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return Number.isFinite(day) ? `${m}月${d}日（${WEEKDAYS[day]}）` : String(date);
}

function monthLabel(month) {
  const [year, mon] = month.split("-");
  return `${year}年${Number(mon)}月`;
}

// ---- generative covers -------------------------------------------------------
// Deterministic per topic/date so rebuilds stay byte-identical. Monochrome ink
// on warm black with a single brass accent, in four families chosen by topic.

function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INK = "#f3efe6";
const ACCENT = "#e8c27a";
const r1 = (n) => Math.round(n * 10) / 10;

export function coverSvg(topicId, date) {
  const family = seeded(String(topicId || date))() * 4 | 0;
  const rnd = seeded(`${topicId}|${date}`);
  const W = 160;
  const H = 100;
  const parts = [`<rect width="${W}" height="${H}" fill="#15130f"/>`];
  const gx = r1(30 + rnd() * 100);
  const gy = r1(20 + rnd() * 60);
  parts.push(`<circle cx="${gx}" cy="${gy}" r="58" fill="${ACCENT}" opacity=".07"/>`);
  parts.push(`<circle cx="${gx}" cy="${gy}" r="30" fill="${ACCENT}" opacity=".06"/>`);
  if (family === 0) {
    const n = 30;
    const accentAt = 6 + (rnd() * (n - 12) | 0);
    for (let i = 0; i < n; i += 1) {
      const env = Math.sin(((i + 0.5) / n) * Math.PI);
      const h = r1(8 + env * (18 + rnd() * 46));
      const x = r1(14 + i * ((W - 28) / (n - 1)) - 1.4);
      const on = i >= accentAt && i < accentAt + 3;
      parts.push(`<rect x="${x}" y="${r1(H / 2 - h / 2)}" width="2.8" height="${h}" rx="1.4" fill="${on ? ACCENT : INK}" opacity="${on ? 1 : r1(0.35 + env * 0.5)}"/>`);
    }
  } else if (family === 1) {
    const cx = r1(30 + rnd() * 100);
    const cy = r1(25 + rnd() * 50);
    const accentRing = 2 + (rnd() * 5 | 0);
    for (let i = 1; i <= 11; i += 1) {
      const on = i === accentRing;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${i * 8}" fill="none" stroke="${on ? ACCENT : INK}" stroke-width="${on ? 1.6 : 1}" opacity="${on ? 1 : r1(0.62 - i * 0.045)}"/>`);
    }
  } else if (family === 2) {
    const fx = 0.6 + rnd() * 1.2;
    const fy = 0.6 + rnd() * 1.2;
    const ph = rnd() * 6;
    let best = { v: -1, x: 0, y: 0 };
    const dots = [];
    for (let row = 0; row < 9; row += 1) {
      for (let col = 0; col < 16; col += 1) {
        const v = (Math.sin(col * fx * 0.5 + ph) * Math.cos(row * fy * 0.6 - ph) + 1) / 2;
        const x = 10 + col * 9.3;
        const y = 10 + row * 10;
        if (v > best.v) best = { v, x, y };
        dots.push([x, y, v]);
      }
    }
    for (const [x, y, v] of dots) {
      const on = Math.abs(x - best.x) < 10 && Math.abs(y - best.y) < 11;
      parts.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(0.6 + v * 2.2)}" fill="${on ? ACCENT : INK}" opacity="${on ? 1 : r1(0.25 + v * 0.6)}"/>`);
    }
  } else {
    const lines = 9;
    const accentLine = 2 + (rnd() * (lines - 4) | 0);
    const freq = 1.5 + rnd() * 2.5;
    const phase = rnd() * Math.PI * 2;
    for (let j = 0; j < lines; j += 1) {
      const y0 = 14 + j * ((H - 28) / (lines - 1));
      const amp = 2 + Math.sin((j / (lines - 1)) * Math.PI) * (5 + rnd() * 6);
      let d = "";
      for (let x = 0; x <= W; x += 8) {
        const y = y0 + Math.sin((x / W) * Math.PI * freq + phase + j * 0.5) * amp;
        d += `${x === 0 ? "M" : "L"}${x} ${r1(y)}`;
      }
      const on = j === accentLine;
      parts.push(`<path d="${d}" fill="none" stroke="${on ? ACCENT : INK}" stroke-width="${on ? 1.6 : 1}" stroke-linecap="round" opacity="${on ? 1 : 0.5}"/>`);
    }
  }
  return `<svg class="cover-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}

// ---- no-JS fallback blocks (also the test contract) --------------------------

function paperListHtml(ep) {
  if (ep.papers.length === 0) {
    return `<p class="papers-empty">${esc("この回の収録論文データはありません / No paper metadata.")}</p>`;
  }
  const items = ep.papers.map((paper) => {
    const meta = [
      paper.id ? `arXiv:${esc(paper.id)}` : "",
      paper.published ? esc(paper.published) : "",
      paper.category ? esc(paper.category) : "",
    ].filter(Boolean).join(" · ");
    const titleHtml = paper.url
      ? `<a href="${esc(paper.url)}" target="_blank" rel="noopener">${esc(paper.title)}</a>`
      : esc(paper.title);
    const pdf = paper.pdf ? ` <a class="pdf" href="${esc(paper.pdf)}" target="_blank" rel="noopener">PDF</a>` : "";
    return `<li>${titleHtml}${pdf}${meta ? `<span class="meta">${meta}</span>` : ""}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

function langBlockHtml(ep, lang, model) {
  const audio = ep.audio[lang.code];
  if (!audio) return "";
  const details = [audio.size, audio.clock].filter(Boolean).join(" · ");
  return [
    `      <div class="lang-block" data-lang="${esc(lang.code)}">`,
    `        <p class="lang-label">${esc(lang.label)}</p>`,
    `        <audio controls preload="none" src="${esc(audio.src)}"></audio>`,
    `        <p class="dl-row">`,
    `          <a class="btn" href="${esc(audio.src)}" download="${esc(audio.file)}">${esc(lang.downloadLabel)}</a>`,
    audio.script ? `          <a class="link" href="${esc(audio.script)}">${esc(lang.transcriptLabel)}</a>` : null,
    details ? `          <span class="dl-meta">${esc(details)}</span>` : null,
    `        </p>`,
    audio.voice ? `        <p class="voice-line">音声 · ${esc(audio.voice)}</p>` : null,
    `      </div>`,
  ].filter((line) => line !== null).join("\n");
}

// ---- cards ---------------------------------------------------------------------

function topicSpans(ep, languages) {
  return languages
    .map((lang) => `<span class="topic-label" lang="${esc(lang.code)}" data-lang="${esc(lang.code)}">${esc(ep.topic[lang.code])}</span>`)
    .join("");
}

function playButton(ep, label, extra = "") {
  return `<button type="button" class="play-fab${extra ? ` ${extra}` : ""}" data-play aria-pressed="false" aria-label="${esc(label)}">${icon("play", "i-play")}${icon("pause", "i-pause")}<span class="spinner" aria-hidden="true"></span></button>`;
}

function cardHtml(ep, model) {
  const languages = model.languages;
  const no = String(ep.no).padStart(2, "0");
  const durations = languages
    .filter((lang) => ep.audio[lang.code])
    .map((lang) => `<span class="dur" data-lang="${esc(lang.code)}">${esc(ep.audio[lang.code].clock)}</span>`)
    .join("");
  const dots = languages
    .map((lang) => `<span class="ld${ep.audio[lang.code] ? "" : " is-off"}" title="${esc(lang.label)}${ep.audio[lang.code] ? "" : "（音声なし）"}">${esc(lang.code)}</span>`)
    .join("");
  const blocks = languages.map((lang) => langBlockHtml(ep, lang, model)).filter(Boolean).join("\n");
  return [
    `  <article class="${ep.latest ? "episode latest" : "episode"}" id="ep-${esc(ep.date)}" data-date="${esc(ep.date)}">`,
    `    <div class="cover">${coverSvg(ep.topicId, ep.date)}<span class="cover-no" aria-hidden="true">${no}</span>${playButton(ep, `再生: ${ep.topic.ja || ep.topicId}`)}<span class="cover-progress" aria-hidden="true"><i></i></span><span class="done-badge">${icon("check")}聴了</span></div>`,
    `    <div class="card-body">`,
    `      <p class="cat"><span>No. ${no}</span><time datetime="${esc(ep.date)}">${esc(dateLabel(ep.date))}</time></p>`,
    `      <h4 class="topic"><a class="open-card" href="#ep-${esc(ep.date)}">${topicSpans(ep, languages)}</a></h4>`,
    `      <p class="when"><span class="badge">${esc(ep.source === "arxiv" ? "arXiv" : ep.source || "—")}</span><span>論文 ${ep.papers.length}本</span>${durations}<span class="resume-note"></span></p>`,
    `      <p class="langs" aria-label="音声のある言語">${dots}</p>`,
    `      <p class="missing">この言語の音声はありません</p>`,
    `    </div>`,
    `    <div class="folio">`,
    ep.synopsis ? `      <p class="synopsis">${esc(ep.synopsis)}</p>` : "",
    blocks,
    `      <details class="papers">`,
    `        <summary>収録論文</summary>`,
    `        ${paperListHtml(ep)}`,
    `      </details>`,
    `    </div>`,
    `  </article>`,
  ].filter(Boolean).join("\n");
}

function shelfHtml(model) {
  const groups = [];
  for (const ep of model.episodes) {
    const month = ep.date.slice(0, 7);
    let group = groups.find((item) => item.month === month);
    if (!group) {
      group = { month, items: [] };
      groups.push(group);
    }
    group.items.push(cardHtml(ep, model));
  }
  const timeline = groups
    .map((group) => `<a href="#m-${esc(group.month)}" data-month="${esc(group.month)}">${esc(monthLabel(group.month))}<span>${group.items.length}</span></a>`)
    .join("");
  const sections = groups.map((group) => [
    `<section class="month" id="m-${esc(group.month)}" data-month="${esc(group.month)}" aria-labelledby="mh-${esc(group.month)}">`,
    `<h3 class="month-label" id="mh-${esc(group.month)}"><span>${esc(monthLabel(group.month))}</span><span class="month-count">${group.items.length}回</span></h3>`,
    `<div class="grid">`,
    group.items.join("\n"),
    `</div>`,
    `</section>`,
  ].join("\n")).join("\n");
  return `<div class="shelf"><nav class="timeline" aria-label="月で移動">${timeline}</nav><div class="months">${sections}</div></div>`;
}

// ---- page ------------------------------------------------------------------------

function toolbarHtml() {
  return `<div class="toolbar" role="search">
  <label class="search-field">${icon("search")}<span class="sr-only">エピソードを検索</span><input id="lib-q" type="search" placeholder="テーマ・論文・著者・arXiv ID" autocomplete="off" spellcheck="false"><kbd class="kbd-hint" aria-hidden="true">/</kbd></label>
  <div class="seg" role="group" aria-label="絞り込み">
    <button type="button" class="seg-btn is-active" data-filter="all" aria-pressed="true">すべて</button>
    <button type="button" class="seg-btn" data-filter="new" aria-pressed="false">未再生</button>
    <button type="button" class="seg-btn" data-filter="progress" aria-pressed="false">途中</button>
    <button type="button" class="seg-btn" data-filter="done" aria-pressed="false">聴了</button>
  </div>
  <div class="toolbar-end">
    <button type="button" class="ghost-btn" id="sort-btn" aria-pressed="false">${icon("sort")}<span>新しい順</span></button>
    <div class="seg seg-icons" role="group" aria-label="表示">
      <button type="button" class="seg-btn is-active" data-view="grid" aria-pressed="true" aria-label="グリッド表示" data-tip="グリッド">${icon("grid")}</button>
      <button type="button" class="seg-btn" data-view="list" aria-pressed="false" aria-label="リスト表示" data-tip="リスト">${icon("list")}</button>
    </div>
  </div>
  <p class="result-count" id="result-count" aria-live="polite"></p>
</div>`;
}

function dockHtml() {
  const menuItem = (value, label, checked) => `<button type="button" role="menuitemradio" aria-checked="${checked}" data-value="${value}">${icon("check", "i-check")}<span>${label}</span></button>`;
  return `<section class="dock" id="dock" aria-label="プレーヤー">
  <span class="dock-line" aria-hidden="true"><i></i></span>
  <button type="button" class="dock-art" data-action="expand" aria-label="プレーヤーを大きく表示"><span class="art"></span></button>
  <div class="dock-meta">
    <button type="button" class="dock-title" data-action="details" id="np-title">音の図書館</button>
    <p class="dock-sub" id="np-sub">エピソードを選んで再生</p>
  </div>
  <div class="dock-transport">
    <button type="button" class="icon-btn" data-action="prev" aria-label="新しいエピソードへ" data-tip="前の回">${icon("skip-back")}</button>
    <button type="button" class="icon-btn skip" data-action="back" aria-label="15秒戻る" data-tip="15秒戻る (J)">${icon("rotate-ccw")}<span class="skip-n" aria-hidden="true">15</span></button>
    <button type="button" class="play-main" data-action="toggle" aria-pressed="false" aria-label="再生">${icon("play", "i-play")}${icon("pause", "i-pause")}<span class="spinner" aria-hidden="true"></span></button>
    <button type="button" class="icon-btn skip" data-action="fwd" aria-label="30秒進む" data-tip="30秒進む (L)">${icon("rotate-cw")}<span class="skip-n" aria-hidden="true">30</span></button>
    <button type="button" class="icon-btn" data-action="next" aria-label="古いエピソードへ" data-tip="次の回">${icon("skip-forward")}</button>
  </div>
  <div class="dock-scrub">
    <span class="time" id="np-now">0:00</span>
    <div class="scrub" id="scrub">
      <canvas aria-hidden="true"></canvas>
      <input id="np-range" type="range" min="0" max="1000" step="1" value="0" aria-label="再生位置" aria-valuetext="0:00">
      <output class="scrub-tip" id="scrub-tip" hidden></output>
    </div>
    <span class="time" id="np-left">-0:00</span>
  </div>
  <div class="dock-tools">
    <div class="menu-wrap">
      <button type="button" class="pill-btn" id="rate-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="rate-menu" data-tip="再生速度">1.0×</button>
      <div class="menu" role="menu" id="rate-menu" aria-label="再生速度" hidden>${[["0.8", "0.8×"], ["1", "1.0×"], ["1.2", "1.2×"], ["1.5", "1.5×"], ["1.75", "1.75×"], ["2", "2.0×"]].map(([value, label]) => menuItem(value, label, value === "1")).join("")}</div>
    </div>
    <div class="menu-wrap">
      <button type="button" class="icon-btn" id="sleep-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="sleep-menu" aria-label="スリープタイマー" data-tip="スリープタイマー">${icon("timer")}<span class="tool-badge" id="sleep-badge" hidden></span></button>
      <div class="menu" role="menu" id="sleep-menu" aria-label="スリープタイマー" hidden>${menuItem("off", "オフ", true)}${menuItem("15", "15分", false)}${menuItem("30", "30分", false)}${menuItem("45", "45分", false)}${menuItem("60", "60分", false)}${menuItem("end", "この回の終わりまで", false)}</div>
    </div>
    <button type="button" class="icon-btn" id="autoplay-btn" aria-pressed="true" aria-label="連続再生" data-tip="連続再生">${icon("repeat")}</button>
    <div class="volume">
      <button type="button" class="icon-btn" id="mute-btn" aria-pressed="false" aria-label="ミュート" data-tip="ミュート (M)">${icon("volume", "i-vol")}${icon("volume-x", "i-mute")}</button>
      <input id="volume" type="range" min="0" max="100" step="1" value="100" aria-label="音量">
    </div>
    <button type="button" class="icon-btn" data-action="details" aria-label="エピソードの詳細" data-tip="詳細・文字起こし">${icon("file-text")}</button>
    <button type="button" class="icon-btn dock-close" data-action="collapse" aria-label="小さく表示">${icon("chevron-down")}</button>
  </div>
  <div class="dock-chapters" id="dock-chapters" aria-label="論文ごとの目安位置"></div>
  <audio id="player-audio" preload="none"></audio>
  <p class="sr-only" id="np-status" aria-live="polite"></p>
</section>`;
}

function sheetHtml() {
  return `<dialog class="sheet" id="sheet" aria-labelledby="sheet-title">
  <div class="sheet-scroll">
    <header class="sheet-head">
      <div class="sheet-cover"></div>
      <div class="sheet-heading">
        <p class="sheet-kicker" id="sheet-kicker"></p>
        <h2 id="sheet-title"></h2>
        <p class="sheet-sub" id="sheet-sub"></p>
        <div class="sheet-actions" id="sheet-actions"></div>
      </div>
      <button type="button" class="icon-btn sheet-close" data-close aria-label="閉じる" data-tip="閉じる (Esc)">${icon("x")}</button>
    </header>
    <div class="sheet-tabs" role="tablist" aria-label="エピソード情報">
      <button type="button" role="tab" id="tab-about" aria-controls="sheet-panel" aria-selected="true" data-tab="about">概要</button>
      <button type="button" role="tab" id="tab-papers" aria-controls="sheet-panel" aria-selected="false" tabindex="-1" data-tab="papers">収録論文</button>
      <button type="button" role="tab" id="tab-transcript" aria-controls="sheet-panel" aria-selected="false" tabindex="-1" data-tab="transcript">文字起こし</button>
      <button type="button" role="tab" id="tab-files" aria-controls="sheet-panel" aria-selected="false" tabindex="-1" data-tab="files">音声ファイル</button>
    </div>
    <div class="sheet-panel" id="sheet-panel" role="tabpanel" aria-labelledby="tab-about" tabindex="0"></div>
  </div>
</dialog>`;
}

function shortcutsHtml() {
  const rows = [
    ["Space / K", "再生・一時停止"],
    ["J / L", "15秒戻る / 30秒進む"],
    ["← / →", "5秒戻る / 進む"],
    ["Shift + < / >", "再生速度を下げる / 上げる"],
    ["Shift + P / N", "前の回 / 次の回"],
    ["M", "ミュート"],
    ["/ または ⌘K", "検索"],
    ["?", "このヘルプ"],
    ["Esc", "閉じる"],
  ];
  return `<dialog class="sheet small" id="shortcuts" aria-labelledby="shortcuts-title">
  <div class="sheet-scroll">
    <header class="sheet-head plain"><h2 id="shortcuts-title">キーボード操作</h2><button type="button" class="icon-btn sheet-close" data-close aria-label="閉じる">${icon("x")}</button></header>
    <dl class="keys">${rows.map(([key, label]) => `<div><dt><kbd>${esc(key)}</kbd></dt><dd>${esc(label)}</dd></div>`).join("")}</dl>
  </div>
</dialog>`;
}

export function renderLibraryPage(model) {
  const title = esc(model.title);
  const covered = model.languages.filter((lang) => lang.covered);
  const latest = model.episodes[0] ?? null;
  const tabs = covered
    .map((lang) => `<button type="button" class="tab" data-lang-tab="${esc(lang.code)}" lang="${esc(lang.code)}" aria-pressed="false">${esc(lang.label)}</button>`)
    .join("");
  const navigation = covered.length > 0 ? `<nav class="tabs" aria-label="Language">${tabs}</nav>` : "";
  const alternates = model.languages
    .map((lang) => `<link rel="alternate" type="application/rss+xml" hreflang="${esc(lang.code)}" title="${esc(`${model.title} (${lang.label})`)}" href="${esc(lang.rss)}">`)
    .join("\n");
  const paperIds = new Set();
  let seconds = 0;
  for (const ep of model.episodes) {
    for (const paper of ep.papers) paperIds.add(paper.id || paper.title);
    for (const audio of Object.values(ep.audio)) seconds += Number(audio.duration) || 0;
  }
  const hours = Math.round(seconds / 360) / 10;
  const description = esc(`毎日の arXiv を、六つの言語で聴く。${model.subtitleJa || ""}`);

  const feature = latest ? `<article class="feature" data-date="${esc(latest.date)}" aria-labelledby="feature-title">
      <div class="cover feature-cover">${coverSvg(latest.topicId, latest.date)}${playButton(latest, `最新回を再生: ${latest.topic.ja || latest.topicId}`, "large")}<span class="cover-progress" aria-hidden="true"><i></i></span></div>
      <div class="feature-body">
        <p class="cat"><span>最新 · No. 01</span><time datetime="${esc(latest.date)}">${esc(dateLabel(latest.date))}</time></p>
        <h2 class="feature-title" id="feature-title"><a class="open-card" href="#ep-${esc(latest.date)}">${topicSpans(latest, model.languages)}</a></h2>
        <p class="when"><span>論文 ${latest.papers.length}本</span>${model.languages.filter((lang) => latest.audio[lang.code]).map((lang) => `<span class="dur" data-lang="${esc(lang.code)}">${esc(latest.audio[lang.code].clock)}</span>`).join("")}</p>
      </div>
    </article>` : "";

  const main = model.episodes.length === 0
    ? `<section class="library" id="library" tabindex="-1"><p class="empty">まだエピソードはありません。<span class="lmuted">No episodes yet — try <code>node scripts/podcast/daily.mjs</code>.</span></p></section>`
    : `<section class="continue" id="continue" aria-labelledby="continue-title" hidden>
  <div class="section-head"><h2 id="continue-title">続きを聴く</h2></div>
  <div class="rail" id="continue-rail"></div>
</section>
<section class="library" id="library" tabindex="-1" aria-labelledby="library-title">
  <div class="section-head"><h2 id="library-title">書架</h2><p>一日一回、テーマの違う論文ブリーフ。</p></div>
  ${toolbarHtml()}
  ${shelfHtml(model)}
  <p class="no-results" id="no-results" hidden>該当するエピソードはありません。<button type="button" class="link-btn" data-action="clear-filters">条件をクリア</button></p>
</section>`;

  const feeds = model.languages
    .map((lang) => `<li><a href="${esc(lang.rss)}">${icon("rss")}<span>${esc(lang.rssLabel)}</span></a><button type="button" class="icon-btn small" data-copy="${esc(lang.rss)}" aria-label="${esc(lang.label)} の RSS URL をコピー" data-tip="URLをコピー">${icon("link")}</button></li>`)
    .join("");

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0a09">
<meta name="color-scheme" content="dark">
<meta name="description" content="${description}">
<meta property="og:title" content="${title} — 音の図書館">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<title>${title} — 音の図書館</title>
${alternates}
<script type="application/json" id="air-catalog">${jsonForScript(atmosphereCatalog())}</script>
<style>${STYLE}</style>
<script>document.documentElement.classList.add("js");try{var l=JSON.parse(localStorage.getItem("oto:lang")||"null");document.documentElement.dataset.uiLang=(typeof l==="string"&&l)||"ja"}catch(e){document.documentElement.dataset.uiLang="ja"}</script>
<script>(function(){try{var list=JSON.parse(document.getElementById("air-catalog").textContent);var ids=list.map(function(item){return item.id});var saved="";try{saved=sessionStorage.getItem("oto:air")||""}catch(e){}var id=ids.indexOf(saved)>=0?saved:ids[Math.floor(Math.random()*ids.length)];try{sessionStorage.setItem("oto:air",id)}catch(e){}document.documentElement.dataset.air=id;var theme=list[0];for(var i=0;i<list.length;i++)if(list[i].id===id)theme=list[i];var meta=document.querySelector('meta[name="theme-color"]');if(meta&&theme&&theme.bg)meta.setAttribute("content",theme.bg)}catch(e){}})();</script>
</head>
<body>
<div class="air" id="air" aria-hidden="true"></div>
${iconSprite()}
<a class="skip" href="#library">書架へスキップ</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="#top" aria-label="音の図書館 トップへ">${icon("audio-lines")}<span>音の図書館</span></a>
    <button type="button" class="search-trigger" data-action="search" aria-label="検索 (/)">${icon("search")}<span>検索</span><kbd aria-hidden="true">/</kbd></button>
    ${navigation}
  </div>
</header>
<main id="top">
<section class="hero" aria-labelledby="hero-title">
  <div class="hero-grid">
    <div class="hero-copy">
      <p class="eyebrow">${title} · arXiv daily briefs</p>
      <h1 id="hero-title">音の図書館</h1>
      <p class="lede">毎日の arXiv を、<br>六つの言語で聴く。</p>
      <p class="sub">${esc(model.subtitleJa)}</p>
      ${model.second.text ? `<p class="sub-alt" lang="${esc(model.second.lang)}">${esc(model.second.text)}</p>` : ""}
      <div class="air-card">
        <button type="button" class="air-draw" id="air-chip" data-action="air" aria-describedby="air-note">
          <span class="air-kicker">この部屋</span>
          <span class="air-name" id="air-name">${esc(ATMOSPHERES[0].name)}</span>
          <span class="air-swap">別の空気</span>
        </button>
        <p class="air-note" id="air-note">${esc(`${ATMOSPHERES[0].note} — ${ATMOSPHERES[0].source}`)}</p>
      </div>
      <script>(function(){try{var list=JSON.parse(document.getElementById("air-catalog").textContent);var id=document.documentElement.dataset.air;var theme=list[0];for(var i=0;i<list.length;i++)if(list[i].id===id)theme=list[i];var name=document.getElementById("air-name");var note=document.getElementById("air-note");if(name)name.textContent=theme.name;if(note)note.textContent=theme.note+" — "+theme.source}catch(e){}})();</script>
      <div class="hero-actions">${latest ? `<button type="button" class="primary-btn" id="hero-play" data-action="hero-play">${icon("play")}<span class="hero-play-label">最新回を再生</span><span class="hero-play-meta"></span></button>` : ""}<a class="secondary-btn" href="#library">${icon("book-open")}<span>書架を見る</span></a></div>
      <dl class="stats">
        <div><dt>エピソード</dt><dd>${model.episodes.length}</dd></div>
        <div><dt>言語</dt><dd>${model.languages.length}</dd></div>
        <div><dt>論文</dt><dd>${paperIds.size}</dd></div>
        <div><dt>音声</dt><dd>${hours}<small>時間</small></dd></div>
      </dl>
    </div>
    ${feature}
  </div>
</section>
${main}
</main>
<footer class="footer">
  <div class="footer-grid">
    <div>
      <p class="footer-brand">${icon("audio-lines")}<span>音の図書館</span></p>
      <p>出典は arXiv。各論文のライセンスに従います。台本は抄録をもとにローカルで要約し、音声もローカルで生成しています。これからの収録は <a href="https://github.com/debpalash/VoiceStudio" target="_blank" rel="noopener">VoiceStudio</a>（OmniVoice）を最初に使い、日本語の声が届かないときだけ、これまでのローカル音声へ戻します。部屋の名前は環境心理学の知見にちなみます。画面そのものが学習効果を保証するものではありません。</p>
      <p class="footer-links"><a href="episodes.json">episodes.json</a><a href="${esc(model.repoUrl)}" target="_blank" rel="noopener">GitHub ${icon("external-link")}</a><button type="button" class="link-btn" data-action="shortcuts">${icon("keyboard")}キーボード操作</button></p>
    </div>
    <div>
      <h2 class="footer-h">ポッドキャスト（RSS）</h2>
      <ul class="feeds" aria-label="RSS">${feeds}</ul>
    </div>
  </div>
  <p class="credits">Icons: <a href="https://lucide.dev" target="_blank" rel="noopener">Lucide</a> (ISC License)</p>
</footer>
${model.episodes.length ? dockHtml() : ""}
${model.episodes.length ? sheetHtml() : ""}
${shortcutsHtml()}
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="library-data">${jsonForScript({ languages: model.languages, episodes: model.episodes })}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
