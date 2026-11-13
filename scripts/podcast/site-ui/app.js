(() => {
  "use strict";
  const doc = document;
  const root = doc.documentElement;
  const dataNode = doc.getElementById("library-data");
  if (!dataNode) return;
  let DATA;
  try { DATA = JSON.parse(dataNode.textContent); } catch (err) { return; }
  const EPISODES = DATA.episodes || [];
  const LANGS = DATA.languages || [];
  const LANG = Object.fromEntries(LANGS.map((l) => [l.code, l]));
  const COVERED = LANGS.filter((l) => l.covered).map((l) => l.code);
  const BY_DATE = new Map(EPISODES.map((ep) => [ep.date, ep]));
  const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2];
  // Topic lines, durations and the no-JS blocks. Play buttons also carry
  // data-lang (the continue rail) and must stay visible.
  const LANG_BLOCKS = ".topic-label[data-lang], .dur[data-lang], .lang-block[data-lang]";
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  const $ = (sel, el = doc) => el.querySelector(sel);
  const $$ = (sel, el = doc) => Array.from(el.querySelectorAll(sel));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls = "") => `<svg class="icon${cls ? " " + cls : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem("oto:" + key); return raw == null ? fallback : JSON.parse(raw); } catch (err) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem("oto:" + key, JSON.stringify(value)); } catch (err) { /* private mode */ } },
    remove(key) { try { localStorage.removeItem("oto:" + key); } catch (err) { /* private mode */ } },
  };

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  const minutesLeft = (sec) => `残り${Math.max(1, Math.round(sec / 60))}分`;
  const topicOf = (ep, lang) => (ep.topic && (ep.topic[lang] || ep.topic.ja)) || ep.date;
  const dateText = (ep) => {
    const card = doc.getElementById("ep-" + ep.date);
    const t = card && $("time", card);
    return t ? t.textContent : ep.date;
  };

  // ---- toast ------------------------------------------------------------------
  const toastEl = $("#toast");
  let toastTimer = 0;
  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 2600);
  }

  // ---- positions (resume) ----------------------------------------------------------
  const posKey = (ep, lang) => `pos:${ep.date}:${lang}`;
  function readPos(ep, lang) {
    const p = store.get(posKey(ep, lang), null);
    return p && typeof p.t === "number" ? p : null;
  }
  function progressOf(ep, lang) {
    const p = readPos(ep, lang);
    const d = (p && p.d) || (ep.audio[lang] && ep.audio[lang].duration) || 0;
    if (!p || !d) return { frac: 0, t: 0, d, state: "new" };
    const frac = clamp(p.t / d, 0, 1);
    return { frac, t: p.t, d, state: p.done || frac > 0.97 ? "done" : frac > 0.01 ? "progress" : "new" };
  }
  function resumeAt(ep, lang) {
    const pr = progressOf(ep, lang);
    return pr.state === "progress" && pr.d - pr.t > 10 ? pr.t : 0;
  }

  // ---- language ------------------------------------------------------------------
  let lang = (() => {
    const q = new URLSearchParams(location.search).get("lang");
    const saved = store.get("lang", "");
    return [q, saved].find((c) => c && COVERED.includes(c)) || COVERED[0] || "ja";
  })();

  function applyLang(next) {
    lang = next;
    store.set("lang", next);
    $$(".tab[data-lang-tab]").forEach((tab) => {
      const on = tab.dataset.langTab === next;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-pressed", String(on));
    });
    root.dataset.uiLang = next;
    $$(LANG_BLOCKS).forEach((el) => { el.hidden = el.dataset.lang !== next; });
    $$(".episode, .feature").forEach((card) => {
      const ep = BY_DATE.get(card.dataset.date);
      const ok = Boolean(ep && ep.audio[next]);
      card.classList.toggle("is-unavailable", !ok);
      $$("[data-play]", card).forEach((b) => { b.disabled = !ok; });
    });
    paintCards();
    renderContinue();
    updateHeroCta();
    applyFilters();
    if (sheet.ep) renderSheet();
  }

  function anchorCard() {
    let best = null;
    let bestDist = Infinity;
    const mid = window.innerHeight * 0.4;
    $$(".episode").forEach((card) => {
      if (card.hidden) return;
      const r = card.getBoundingClientRect();
      if (r.bottom < 80 || r.top > window.innerHeight) return;
      const dist = Math.abs(r.top - mid);
      if (dist < bestDist) { bestDist = dist; best = card; }
    });
    return best;
  }

  function switchLang(next) {
    if (!next || next === lang) return;
    const anchor = anchorCard();
    const before = anchor ? anchor.getBoundingClientRect().top : null;
    const ep = player.ep;
    const wasPlaying = Boolean(ep && !audio.paused);
    const at = ep ? position() : 0;
    const fromDur = duration();
    applyLang(next);
    if (anchor && before !== null) {
      const delta = anchor.getBoundingClientRect().top - before;
      if (Math.abs(delta) > 1) window.scrollBy(0, delta);
    }
    if (ep && ep.audio[next] && player.lang !== next) {
      const toDur = ep.audio[next].duration || fromDur;
      const mapped = fromDur > 0 && toDur > 0 ? (at / fromDur) * toDur : at;
      load(ep, next, { at: mapped, play: wasPlaying, quiet: true });
      toast(`${LANG[next].label} に切り替えました · ${fmt(mapped)}`);
    } else if (ep && !ep.audio[next]) {
      toast(`この回は ${LANG[next].label} の音声がありません`);
    }
  }

  // ---- player core -------------------------------------------------------------------
  const audio = $("#player-audio");
  const dock = $("#dock");
  if (!audio || !dock) { applyLangStatic(); return; }
  const player = { ep: null, lang: null, pendingSeek: null, blobUrl: "", blobFor: "", loadingFor: "", blob: null, lastSave: 0 };
  let rate = clamp(Number(store.get("rate", 1)) || 1, 0.5, 3);
  let autoplay = store.get("autoplay", true) !== false;
  const statusEl = $("#np-status");

  function applyLangStatic() {
    root.dataset.uiLang = lang;
    $$(LANG_BLOCKS).forEach((el) => { el.hidden = el.dataset.lang !== lang; });
  }

  const srcOf = (ep, l) => (ep && ep.audio[l] ? ep.audio[l].src : "");
  function position() { return player.pendingSeek != null ? player.pendingSeek : (audio.currentTime || 0); }
  function duration() {
    const d = audio.duration;
    if (isFinite(d) && d > 0) return d;
    const a = player.ep && player.ep.audio[player.lang];
    return (a && a.duration) || 0;
  }

  function dropBlob() {
    if (player.blobUrl) URL.revokeObjectURL(player.blobUrl);
    player.blobUrl = "";
    player.blobFor = "";
    player.blob = null;
  }

  function load(ep, l, opts = {}) {
    const src = srcOf(ep, l);
    if (!src) return false;
    const { play = true, quiet = false } = opts;
    let at = opts.at;
    const same = player.ep === ep && player.lang === l && audio.dataset.src === src;
    player.ep = ep;
    player.lang = l;
    if (!same) {
      if (at == null) at = resumeAt(ep, l);
      dropBlob();
      player.pendingSeek = at > 0.5 ? at : null;
      audio.dataset.src = src;
      audio.src = src;
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
      if (at > 0.5) audio.addEventListener("loadedmetadata", () => seekTo(at), { once: true });
      wave.setPeaks(pseudoPeaks(ep.date + l), false);
      chapters = [];
      wave.setMarks([]);
      loadChapters(ep, l);
      maybePeaks(ep, l);
    } else if (at != null) {
      seekTo(at);
    }
    if (!opts.prime) store.set("last", { date: ep.date, lang: l });
    renderNowPlaying();
    setArtwork(ep);
    if (play) start();
    else paint();
    if (!quiet && play && statusEl) statusEl.textContent = `再生: ${topicOf(ep, l)}`;
    return true;
  }

  function start() {
    const pending = audio.play();
    if (pending && pending.catch) {
      pending.catch((err) => {
        if (!err || err.name === "AbortError") return;
        toast(err.name === "NotAllowedError" ? "再生ボタンを押してください" : "再生できませんでした");
      });
    }
  }

  function togglePlayer() {
    if (!player.ep) {
      const ep = EPISODES.find((e) => e.audio[lang]);
      if (ep) load(ep, lang);
      return;
    }
    if (audio.paused) start();
    else audio.pause();
  }

  function toggleEpisode(ep, l = lang) {
    if (!ep) return;
    if (!ep.audio[l]) l = Object.keys(ep.audio)[0];
    if (!l) return;
    if (player.ep === ep && player.lang === l && audio.dataset.src) { togglePlayer(); return; }
    load(ep, l, { play: true });
  }

  function isSeekable(at) {
    const ranges = audio.seekable;
    for (let i = 0; i < ranges.length; i += 1) {
      if (at >= ranges.start(i) && at <= ranges.end(i)) return true;
    }
    return false;
  }

  // Servers that ignore Range requests (python -m http.server, some CDNs)
  // leave the element unseekable; playing from a fetched blob fixes seeking.
  function loadWhole() {
    const src = audio.dataset.src;
    if (!src || player.loadingFor === src || !window.fetch || !window.URL || !URL.createObjectURL) return;
    player.loadingFor = src;
    setBuffering(true);
    if (statusEl) statusEl.textContent = "音声を読み込み中…";
    fetch(src).then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.blob();
    }).then((blob) => {
      if (audio.dataset.src !== src) return;
      const wasPlaying = !audio.paused;
      const fallback = audio.currentTime || 0;
      dropBlob();
      player.blob = blob;
      player.blobUrl = URL.createObjectURL(blob);
      player.blobFor = src;
      audio.addEventListener("loadedmetadata", () => {
        const at = player.pendingSeek != null ? player.pendingSeek : fallback;
        player.pendingSeek = null;
        try { audio.currentTime = at; } catch (err) { /* ignore */ }
        if (wasPlaying) start();
        paint();
      }, { once: true });
      audio.src = player.blobUrl;
      audio.playbackRate = rate;
    }).catch(() => {
      player.pendingSeek = null;
      toast("この位置へ移動できませんでした");
      paint();
    }).then(() => {
      if (player.loadingFor === src) player.loadingFor = "";
      setBuffering(false);
    });
  }

  function seekTo(at) {
    if (typeof at !== "number" || !isFinite(at) || !audio.dataset.src) return;
    const dur = duration();
    const next = dur > 0 ? clamp(at, 0, Math.max(0, dur - 0.25)) : Math.max(0, at);
    const src = audio.dataset.src;
    // A blob that has not decoded yet must not be re-fetched; just remember
    // the latest target. Otherwise, if this position is outside the seekable
    // ranges (servers that ignore Range, such as python -m http.server),
    // fetch the whole file once and play that blob.
    if (player.blobFor === src && audio.readyState === 0) {
      player.pendingSeek = next;
    } else if (player.blobFor === src || isSeekable(next)) {
      player.pendingSeek = null;
      try { audio.currentTime = next; } catch (err) { /* ignore */ }
    } else {
      player.pendingSeek = next;
      loadWhole();
    }
    paint();
  }

  function skip(delta) {
    if (!player.ep) return;
    seekTo(position() + delta);
  }

  function neighbor(step) {
    if (!player.ep) return null;
    const l = player.lang;
    let i = EPISODES.indexOf(player.ep) + step;
    while (i >= 0 && i < EPISODES.length) {
      if (EPISODES[i].audio[l]) return EPISODES[i];
      i += step;
    }
    return null;
  }
  function goNeighbor(step) {
    const ep = neighbor(step);
    if (!ep) { toast(step > 0 ? "これより古い回はありません" : "これが最新の回です"); return; }
    load(ep, player.lang, { play: !audio.paused || step !== 0 });
  }

  function setRate(next) {
    rate = clamp(next, 0.5, 3);
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    store.set("rate", rate);
    const btn = $("#rate-btn");
    if (btn) {
      btn.textContent = `${rate % 1 === 0 ? rate.toFixed(1) : String(rate)}×`;
      btn.classList.toggle("is-on", rate !== 1);
      btn.setAttribute("aria-label", `再生速度 ${btn.textContent}`);
    }
    $$("#rate-menu [role=menuitemradio]").forEach((it) => it.setAttribute("aria-checked", String(Number(it.dataset.value) === rate)));
  }
  function stepRate(dir) {
    let i = RATES.indexOf(rate);
    if (i < 0) i = RATES.indexOf(1);
    const next = RATES[clamp(i + dir, 0, RATES.length - 1)];
    setRate(next);
    toast(`再生速度 ${$("#rate-btn").textContent}`);
  }

  function savePosition(force) {
    const ep = player.ep;
    if (!ep) return;
    const now = Date.now();
    if (!force && now - player.lastSave < 4000) return;
    player.lastSave = now;
    const t = position();
    const d = duration();
    if (t < 3 && !force) return;
    store.set(posKey(ep, player.lang), { t: Math.round(t * 10) / 10, d: Math.round(d * 10) / 10, at: now, done: d > 0 && t / d > 0.97 });
  }

  // ---- painting ------------------------------------------------------------------------
  const nowEl = $("#np-now");
  const leftEl = $("#np-left");
  const range = $("#np-range");
  const line = $(".dock-line", dock);
  let scrubbing = false;

  function setBuffering(on) {
    $$(".play-main, .is-current [data-play]").forEach((b) => b.classList.toggle("is-buffering", on));
  }

  function paint() {
    const t = position();
    const d = duration();
    const frac = d > 0 ? clamp(t / d, 0, 1) : 0;
    if (nowEl) nowEl.textContent = fmt(t);
    if (leftEl) leftEl.textContent = "-" + fmt(Math.max(0, d - t));
    if (range && !scrubbing) {
      range.value = String(Math.round(frac * 1000));
      range.setAttribute("aria-valuetext", `${fmt(t)} / ${fmt(d)}`);
    }
    if (line) line.style.setProperty("--p", frac.toFixed(4));
    wave.setProgress(frac);
    const playing = Boolean(player.ep) && !audio.paused && !audio.ended;
    const main = $(".play-main", dock);
    if (main) {
      main.setAttribute("aria-pressed", String(playing));
      main.setAttribute("aria-label", playing ? "一時停止" : "再生");
    }
    dock.classList.toggle("is-playing", playing);
    $$("[data-play]").forEach((btn) => {
      const host = btn.closest("[data-date]");
      const on = playing && host && player.ep && host.dataset.date === player.ep.date && (player.lang === lang || !player.ep.audio[lang] || btn.dataset.lang === player.lang);
      btn.setAttribute("aria-pressed", String(Boolean(on)));
    });
    $$(".episode").forEach((card) => {
      const cur = Boolean(player.ep && card.dataset.date === player.ep.date);
      card.classList.toggle("is-current", cur);
      card.classList.toggle("is-playing", cur && playing);
    });
    if (player.ep) {
      const card = doc.getElementById("ep-" + player.ep.date);
      if (card && player.lang === lang) paintCard(card, player.ep, { frac, t, d });
    }
    highlightTranscript(t);
    highlightChapters(t);
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = playing ? "playing" : "paused";
        if (d > 0 && navigator.mediaSession.setPositionState) navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: clamp(t, 0, d) });
      } catch (err) { /* unsupported */ }
    }
  }

  function paintCard(card, ep, pr) {
    const p = pr || progressOf(ep, lang);
    const frac = p.frac || 0;
    const done = p.state ? p.state === "done" : frac > 0.97;
    card.classList.toggle("has-progress", frac > 0.01 && !done);
    card.classList.toggle("is-done", done);
    const bar = $(".cover-progress", card);
    if (bar) bar.style.setProperty("--p", frac.toFixed(4));
    const note = $(".resume-note", card);
    if (note) note.textContent = frac > 0.01 && !done && p.d ? minutesLeft(p.d - p.t) : "";
  }
  function paintCards() {
    $$(".episode, .feature").forEach((card) => {
      const ep = BY_DATE.get(card.dataset.date);
      if (ep) paintCard(card, ep);
    });
  }

  function renderNowPlaying() {
    const ep = player.ep;
    if (!ep) return;
    const title = $("#np-title");
    const sub = $("#np-sub");
    if (title) title.textContent = topicOf(ep, player.lang);
    if (sub) sub.textContent = `${dateText(ep)} · ${LANG[player.lang] ? LANG[player.lang].label : player.lang}`;
    const art = $(".dock-art .art", dock);
    const cover = coverMarkup(ep);
    if (art && art.dataset.date !== ep.date) { art.innerHTML = cover; art.dataset.date = ep.date; }
    renderDockChapters();
  }

  function coverMarkup(ep) {
    const card = doc.getElementById("ep-" + ep.date);
    const svg = card && $(".cover-art", card);
    return svg ? svg.outerHTML : "";
  }

  // ---- waveform scrubber ---------------------------------------------------------------
  function pseudoPeaks(seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i += 1) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    const rnd = () => { h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const out = [];
    let walk = 0.5;
    for (let i = 0; i < 200; i += 1) {
      walk = clamp(walk + (rnd() - 0.5) * 0.35, 0.2, 0.95);
      const pause = rnd() < 0.06 ? 0.25 : 1;
      out.push(clamp(walk * pause * (0.7 + rnd() * 0.3), 0.08, 1));
    }
    return out;
  }

  const wave = (() => {
    const wrap = $("#scrub");
    const canvas = wrap && $("canvas", wrap);
    const ctx = canvas && canvas.getContext("2d");
    const state = { peaks: pseudoPeaks("idle"), real: false, p: 0, hover: -1, marks: [] };
    let raf = 0;
    function draw() {
      raf = 0;
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const barW = 2;
      const gap = 2;
      const n = Math.max(12, Math.floor(w / (barW + gap)));
      const src = state.peaks;
      const mid = h / 2;
      for (let i = 0; i < n; i += 1) {
        const a = Math.floor((i / n) * src.length);
        const b = Math.max(a + 1, Math.floor(((i + 1) / n) * src.length));
        let v = 0;
        for (let j = a; j < b; j += 1) v = Math.max(v, src[j] || 0);
        const bh = Math.max(2, v * (h - 4));
        const x = i * (barW + gap);
        const frac = (i + 0.5) / n;
        let color = "rgba(244,240,232,.26)";
        if (frac <= state.p) color = "#e8c27a";
        else if (state.hover >= 0 && frac <= state.hover) color = "rgba(244,240,232,.5)";
        ctx.fillStyle = color;
        ctx.fillRect(x, mid - bh / 2, barW, bh);
      }
      ctx.fillStyle = "rgba(232,194,122,.9)";
      for (const m of state.marks) {
        const x = Math.round(m * w);
        ctx.fillRect(clamp(x - 1, 0, w - 2), 0, 2, 3);
        ctx.fillRect(clamp(x - 1, 0, w - 2), h - 3, 2, 3);
      }
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
    if (canvas && "ResizeObserver" in window) new ResizeObserver(schedule).observe(canvas);
    return {
      setPeaks(peaks, real) { if (!real && state.real && peaks === state.peaks) return; state.peaks = peaks && peaks.length ? peaks : state.peaks; state.real = Boolean(real); schedule(); },
      setProgress(p) { if (Math.abs(p - state.p) > 0.0004) { state.p = p; schedule(); } },
      setHover(p) { state.hover = p; schedule(); },
      setMarks(marks) { state.marks = marks; schedule(); },
      redraw: schedule,
    };
  })();

  const peakJobs = new Set();
  function maybePeaks(ep, l) {
    const key = `peaks:${ep.date}:${l}`;
    const cached = store.get(key, null);
    if (Array.isArray(cached) && cached.length > 20) { wave.setPeaks(cached, true); return; }
    const conn = navigator.connection;
    if (conn && (conn.saveData || /(^|-)2g|3g/.test(conn.effectiveType || ""))) return;
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx || peakJobs.has(key)) return;
    peakJobs.add(key);
    const run = () => {
      const src = srcOf(ep, l);
      const fromBlob = player.blob && player.blobFor === src ? player.blob.arrayBuffer() : fetch(src).then((r) => { if (!r.ok) throw new Error(); return r.arrayBuffer(); });
      fromBlob.then((buf) => new Promise((resolve, reject) => {
        const ctx = new Ctx(1, 1, 4000);
        const p = ctx.decodeAudioData(buf, resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      })).then((decoded) => {
        const data = decoded.getChannelData(0);
        const N = 200;
        const block = Math.max(1, Math.floor(data.length / N));
        const out = [];
        let max = 0;
        for (let i = 0; i < N; i += 1) {
          let sum = 0;
          const start = i * block;
          for (let j = 0; j < block; j += 1) { const v = data[start + j] || 0; sum += v * v; }
          const rms = Math.sqrt(sum / block);
          out.push(rms);
          if (rms > max) max = rms;
        }
        const peaks = out.map((v) => Math.round(clamp(max ? Math.pow(v / max, 0.8) : 0, 0.04, 1) * 100) / 100);
        store.set(key, peaks);
        if (player.ep === ep && player.lang === l) wave.setPeaks(peaks, true);
      }).catch(() => { /* keep the drawn placeholder */ }).then(() => peakJobs.delete(key));
    };
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
    setTimeout(() => idle(run), 2500);
  }

  // ---- transcript & approximate chapters ----------------------------------------------------
  // Timings are estimated from character offsets in the script (speech rate is
  // roughly uniform), so every time shown here is labelled as approximate.
  const transcripts = new Map();
  let chapters = [];
  function getTranscript(ep, l) {
    const a = ep.audio[l];
    if (!a || !a.script) return Promise.resolve(null);
    const key = ep.date + ":" + l;
    if (!transcripts.has(key)) {
      transcripts.set(key, fetch(a.script).then((r) => { if (!r.ok) throw new Error(); return r.text(); }).then((text) => {
        const paras = [];
        let offset = 0;
        const total = text.replace(/\s+/g, "").length || 1;
        for (const raw of text.split(/\n+/)) {
          const para = raw.trim();
          if (!para) continue;
          paras.push({ text: para, frac: offset / total });
          offset += para.replace(/\s+/g, "").length;
        }
        const compact = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const n = ep.papers.length;
        const hits = ep.papers.map((paper) => {
          const needle = compact(paper.title || "").slice(0, 28);
          const hit = needle.length >= 8 ? paras.findIndex((p) => compact(p.text).includes(needle)) : -1;
          return hit >= 0 ? paras[hit].frac : null;
        });
        const known = hits.map((frac, index) => (frac == null ? null : { index, frac })).filter(Boolean);
        // Every paper gets a seek point. A title found in the script pins
        // that paper; the rest are spaced between the pins (or evenly).
        const chaps = ep.papers.map((paper, index) => {
          let frac = hits[index];
          if (frac == null) {
            const prev = [...known].reverse().find((item) => item.index < index);
            const next = known.find((item) => item.index > index);
            if (prev && next) frac = prev.frac + (next.frac - prev.frac) * ((index - prev.index) / (next.index - prev.index));
            else if (next) frac = next.index ? next.frac * (index / next.index) : 0;
            else if (prev) frac = prev.frac + (1 - prev.frac) * ((index - prev.index) / Math.max(1, n - prev.index));
            else frac = n ? index / n : 0;
          }
          return { index, title: paper.title, frac };
        });
        return { paras, chapters: chaps };
      }).catch(() => { transcripts.delete(key); return null; }));
    }
    return transcripts.get(key);
  }

  function loadChapters(ep, l) {
    getTranscript(ep, l).then((tr) => {
      if (!tr || player.ep !== ep || player.lang !== l) return;
      chapters = tr.chapters;
      wave.setMarks(chapters.map((c) => c.frac));
      renderDockChapters();
      if (sheet.ep === ep && (sheet.tab === "papers" || sheet.tab === "transcript")) renderSheet();
    });
  }

  function renderDockChapters() {
    const box = $("#dock-chapters");
    if (!box) return;
    const d = duration();
    if (!chapters.length || !d) { box.innerHTML = ""; return; }
    box.innerHTML = `<h3>論文ごとの目安位置</h3>` + chapters.map((c) => `<button type="button" class="ch-btn" data-seek-frac="${c.frac}"><time>≈${fmt(c.frac * d)}</time><span>${esc(c.title)}</span></button>`).join("");
  }
  function highlightChapters(t) {
    const d = duration();
    if (!d) return;
    const btns = $$(".ch-btn", dock);
    let current = -1;
    chapters.forEach((c, i) => { if (t >= c.frac * d - 1) current = i; });
    btns.forEach((b, i) => b.classList.toggle("is-now", i === current));
  }

  // ---- scrub interactions ---------------------------------------------------------------------
  const scrubWrap = $("#scrub");
  const tip = $("#scrub-tip");
  function chapterAt(frac) {
    let hit = null;
    for (const c of chapters) if (frac >= c.frac) hit = c;
    return hit;
  }
  function showTip(frac) {
    if (!tip || !scrubWrap) return;
    const d = duration();
    if (!d) { tip.hidden = true; return; }
    const ch = chapterAt(frac);
    tip.innerHTML = `${fmt(frac * d)}${ch ? `<small>${esc(ch.title)}</small>` : ""}`;
    tip.hidden = false;
    const w = scrubWrap.clientWidth;
    const half = tip.offsetWidth / 2;
    tip.style.left = clamp(frac * w, half, w - half) + "px";
  }
  if (scrubWrap && range) {
    scrubWrap.addEventListener("pointermove", (e) => {
      const r = scrubWrap.getBoundingClientRect();
      const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
      if (e.pointerType === "mouse" || scrubbing) { wave.setHover(frac); showTip(frac); }
    });
    scrubWrap.addEventListener("pointerleave", () => { if (!scrubbing) { wave.setHover(-1); if (tip) tip.hidden = true; } });
    range.addEventListener("pointerdown", () => { scrubbing = true; });
    const endScrub = () => {
      if (!scrubbing) return;
      scrubbing = false;
      wave.setHover(-1);
      if (tip) tip.hidden = true;
      paint();
    };
    window.addEventListener("pointerup", endScrub);
    window.addEventListener("pointercancel", endScrub);
    range.addEventListener("input", () => {
      const d = duration();
      if (!d) return;
      if (!player.ep) { togglePlayer(); return; }
      const frac = Number(range.value) / 1000;
      if (scrubbing) showTip(frac);
      seekTo(frac * d);
    });
    range.addEventListener("keydown", (e) => {
      const map = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 };
      if (e.key in map) { e.preventDefault(); e.stopPropagation(); skip(map[e.key]); }
      else if (e.key === "Home") { e.preventDefault(); seekTo(0); }
      else if (e.key === "End") { e.preventDefault(); seekTo(duration() - 1); }
    });
  }

  // ---- audio events ----------------------------------------------------------------------------
  let ticking = 0;
  const tick = () => {
    ticking = 0;
    paint();
    if (!audio.paused) ticking = requestAnimationFrame(tick);
  };
  audio.addEventListener("play", () => { if (!ticking) ticking = requestAnimationFrame(tick); paint(); });
  audio.addEventListener("pause", () => { savePosition(true); paint(); renderContinue(); });
  audio.addEventListener("timeupdate", () => { savePosition(false); if (audio.paused) paint(); });
  audio.addEventListener("durationchange", paint);
  audio.addEventListener("waiting", () => setBuffering(true));
  audio.addEventListener("playing", () => setBuffering(false));
  audio.addEventListener("canplay", () => setBuffering(false));
  audio.addEventListener("error", () => {
    if (!audio.dataset.src) return;
    setBuffering(false);
    toast("音声を読み込めませんでした");
  });
  audio.addEventListener("ended", () => {
    savePosition(true);
    if (player.ep) store.set(posKey(player.ep, player.lang), { t: duration(), d: duration(), at: Date.now(), done: true });
    paintCards();
    renderContinue();
    if (sleep && sleep.kind === "end") { setSleep("off", true); toast("スリープタイマーで停止しました"); paint(); return; }
    if (!autoplay) { paint(); return; }
    const next = neighbor(1);
    if (next) { load(next, player.lang, { at: 0, play: true }); toast(`次の回: ${topicOf(next, player.lang)}`); }
    else paint();
  });
  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") savePosition(true); });
  window.addEventListener("pagehide", () => savePosition(true));

  // ---- menus ---------------------------------------------------------------------------------------
  const menus = [];
  function setupMenu(btn, menu, onPick) {
    if (!btn || !menu) return;
    const items = () => $$('[role^="menuitem"]', menu);
    const close = (focusBtn) => {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      if (focusBtn) btn.focus();
    };
    const open = () => {
      menus.forEach((m) => m.close(false));
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      const list = items();
      (list.find((i) => i.getAttribute("aria-checked") === "true") || list[0]).focus();
    };
    btn.addEventListener("click", (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(false); });
    btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); } });
    menu.addEventListener("keydown", (e) => {
      const list = items();
      const i = list.indexOf(doc.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); list[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === "Tab") close(false);
    });
    menu.addEventListener("click", (e) => {
      const it = e.target.closest('[role^="menuitem"]');
      if (!it) return;
      e.stopPropagation();
      onPick(it.dataset.value);
      close(true);
    });
    menus.push({ close });
  }
  doc.addEventListener("click", () => menus.forEach((m) => m.close(false)));

  setupMenu($("#rate-btn"), $("#rate-menu"), (v) => { setRate(Number(v)); toast(`再生速度 ${$("#rate-btn").textContent}`); });

  // ---- sleep timer -----------------------------------------------------------------------------------
  let sleep = null;
  let fading = false;
  function setSleep(value, silent) {
    if (value === "off") sleep = null;
    else if (value === "end") sleep = { kind: "end" };
    else sleep = { kind: "time", until: Date.now() + Number(value) * 60000 };
    $$("#sleep-menu [role=menuitemradio]").forEach((it) => it.setAttribute("aria-checked", String(it.dataset.value === value)));
    paintSleep();
    if (!silent) toast(value === "off" ? "スリープタイマーをオフにしました" : value === "end" ? "この回の終わりで停止します" : `${value}分後に停止します`);
  }
  function paintSleep() {
    const btn = $("#sleep-btn");
    const badge = $("#sleep-badge");
    if (!btn || !badge) return;
    btn.setAttribute("aria-pressed", String(Boolean(sleep)));
    if (!sleep) { badge.hidden = true; btn.setAttribute("aria-label", "スリープタイマー"); return; }
    badge.hidden = false;
    if (sleep.kind === "end") { badge.textContent = "終"; btn.setAttribute("aria-label", "スリープタイマー: この回の終わり"); return; }
    const mins = Math.max(0, Math.ceil((sleep.until - Date.now()) / 60000));
    badge.textContent = String(mins);
    btn.setAttribute("aria-label", `スリープタイマー: 残り${mins}分`);
  }
  setupMenu($("#sleep-btn"), $("#sleep-menu"), (v) => setSleep(v));
  setInterval(() => {
    if (!sleep || sleep.kind !== "time") return;
    paintSleep();
    if (Date.now() >= sleep.until && !fading) {
      fading = true;
      const startVol = audio.volume;
      const t0 = performance.now();
      const step = (now) => {
        const k = clamp((now - t0) / 4000, 0, 1);
        audio.volume = startVol * (1 - k);
        if (k < 1 && !audio.paused) requestAnimationFrame(step);
        else { audio.pause(); audio.volume = startVol; fading = false; setSleep("off", true); toast("スリープタイマーで停止しました"); }
      };
      requestAnimationFrame(step);
    }
  }, 1000);

  // ---- volume & autoplay ---------------------------------------------------------------------------------
  const vol = $("#volume");
  const muteBtn = $("#mute-btn");
  function paintVolume() {
    if (vol) vol.value = String(Math.round((audio.muted ? 0 : audio.volume) * 100));
    if (muteBtn) {
      muteBtn.setAttribute("aria-pressed", String(audio.muted || audio.volume === 0));
      muteBtn.setAttribute("aria-label", audio.muted ? "ミュート解除" : "ミュート");
    }
  }
  audio.volume = clamp(Number(store.get("volume", 1)), 0, 1);
  if (vol) vol.addEventListener("input", () => { audio.muted = false; audio.volume = Number(vol.value) / 100; store.set("volume", audio.volume); paintVolume(); });
  if (muteBtn) muteBtn.addEventListener("click", () => { audio.muted = !audio.muted; paintVolume(); });
  audio.addEventListener("volumechange", paintVolume);

  const autoBtn = $("#autoplay-btn");
  function paintAutoplay() {
    if (!autoBtn) return;
    autoBtn.setAttribute("aria-pressed", String(autoplay));
    autoBtn.setAttribute("aria-label", autoplay ? "連続再生: オン" : "連続再生: オフ");
    autoBtn.dataset.tip = autoplay ? "連続再生: オン" : "連続再生: オフ";
  }
  if (autoBtn) autoBtn.addEventListener("click", () => { autoplay = !autoplay; store.set("autoplay", autoplay); paintAutoplay(); toast(autoplay ? "終わったら次の回を再生します" : "連続再生をオフにしました"); });

  // ---- expand / collapse (mobile now-playing) --------------------------------------------------------------
  function setExpanded(on) {
    dock.classList.toggle("is-expanded", on);
    doc.body.classList.toggle("dock-open", on);
    const art = $(".dock-art", dock);
    if (art) art.setAttribute("aria-label", on ? "プレーヤーを小さく表示" : "プレーヤーを大きく表示");
    wave.redraw();
    if (on) { const c = $(".dock-close", dock); if (c) c.focus(); }
  }
  const isCompact = () => window.matchMedia("(max-width: 760px)").matches;

  // ---- sheet (episode detail) ----------------------------------------------------------------------------------
  const sheetEl = $("#sheet");
  const sheet = { ep: null, tab: "about", opener: null };
  function epFromHash() {
    const m = /^#ep-(\d{4}-\d{2}-\d{2})$/.exec(location.hash || "");
    return m ? BY_DATE.get(m[1]) || null : null;
  }

  function openSheet(ep, opts = {}) {
    if (!sheetEl || !ep) return;
    const { tab = "about", push = true } = opts;
    sheet.ep = ep;
    sheet.tab = tab;
    if (!sheetEl.open) sheet.opener = doc.activeElement;
    renderSheet();
    if (!sheetEl.open) {
      if (sheetEl.showModal) sheetEl.showModal();
      else sheetEl.setAttribute("open", "");
    }
    $(".sheet-scroll", sheetEl).scrollTop = 0;
    if (push && location.hash !== "#ep-" + ep.date) history.pushState({ sheet: ep.date }, "", location.pathname + location.search + "#ep-" + ep.date);
    getTranscript(ep, ep.audio[lang] ? lang : Object.keys(ep.audio)[0]).then(() => { if (sheet.ep === ep && sheet.tab !== "about") renderSheet(); });
  }
  function closeSheet() { if (sheetEl && sheetEl.open) sheetEl.close(); }
  if (sheetEl) {
    sheetEl.addEventListener("close", () => {
      sheet.ep = null;
      if (/^#ep-/.test(location.hash)) {
        if (history.state && history.state.sheet) history.back();
        else history.replaceState(null, "", location.pathname + location.search);
      }
      if (sheet.opener && sheet.opener.focus && doc.contains(sheet.opener)) sheet.opener.focus();
    });
    sheetEl.addEventListener("click", (e) => { if (e.target === sheetEl) closeSheet(); });
  }
  window.addEventListener("popstate", () => {
    const ep = epFromHash();
    if (ep) openSheet(ep, { push: false });
    else closeSheet();
  });

  function sheetLang(ep) { return ep.audio[lang] ? lang : Object.keys(ep.audio)[0] || lang; }

  function renderSheet() {
    const ep = sheet.ep;
    if (!ep || !sheetEl) return;
    const l = sheetLang(ep);
    const no = String(EPISODES.indexOf(ep) + 1).padStart(2, "0");
    $(".sheet-cover", sheetEl).innerHTML = coverMarkup(ep);
    $("#sheet-kicker").textContent = `No. ${no} · ${dateText(ep)}`;
    const titleEl = $("#sheet-title");
    titleEl.textContent = topicOf(ep, lang);
    titleEl.setAttribute("lang", ep.topic[lang] ? lang : "ja");
    const a = ep.audio[l];
    const subBits = [`論文 ${ep.papers.length}本`];
    if (a) subBits.push(`${LANG[l].label} ${fmt(a.duration)}`);
    if (!ep.audio[lang]) subBits.push(`${LANG[lang] ? LANG[lang].label : lang} の音声はありません`);
    $("#sheet-sub").textContent = subBits.join(" · ");
    const isCur = player.ep === ep && player.lang === l;
    const playing = isCur && !audio.paused;
    const pr = progressOf(ep, l);
    let playLabel = "再生";
    if (playing) playLabel = "一時停止";
    else if (isCur && position() > 1) playLabel = `続きを再生 · ${fmt(position())}`;
    else if (pr.state === "progress") playLabel = `続きを再生 · ${minutesLeft(pr.d - pr.t)}`;
    else if (pr.state === "done") playLabel = "もう一度再生";
    $("#sheet-actions").innerHTML = (a ? `<button type="button" class="primary-btn" data-sheet-play>${icon(playing ? "pause" : "play")}<span>${esc(playLabel)}</span></button>` : "")
      + `<button type="button" class="icon-btn" data-share aria-label="共有" data-tip="リンクを共有">${icon("share")}</button>`
      + (a ? `<a class="icon-btn" href="${esc(a.src)}" download="${esc(a.file)}" aria-label="${esc(LANG[l].downloadLabel)}" data-tip="MP3をダウンロード">${icon("download")}</a>` : "")
      + (pr.state !== "new" ? `<button type="button" class="icon-btn" data-reset aria-label="再生記録を消す" data-tip="再生記録を消す">${icon("rotate-ccw")}</button>` : "");
    $$(".sheet-tabs [role=tab]", sheetEl).forEach((t) => {
      const on = t.dataset.tab === sheet.tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    const panel = $("#sheet-panel");
    panel.setAttribute("aria-labelledby", "tab-" + sheet.tab);
    panel.innerHTML = renderPanel(ep, l);
    highlightTranscript(position());
  }

  function renderPanel(ep, l) {
    const a = ep.audio[l];
    if (sheet.tab === "about") {
      const langs = LANGS.map((x) => `<li><span class="ld${ep.audio[x.code] ? "" : " is-off"}">${esc(x.code)}</span><span lang="${esc(x.code)}">${esc(ep.topic[x.code] || "")}</span></li>`).join("");
      return `${ep.synopsis ? `<p class="prose" lang="en">${esc(ep.synopsis)}</p><p class="note">最初の論文の抄録（英語）より。音声はこの回の論文を順に紹介します。</p>` : ""}
        <dl class="facts">
          <div><dt>日付</dt><dd>${esc(dateText(ep))}</dd></div>
          <div><dt>出典</dt><dd>${esc(ep.source === "arxiv" ? "arXiv" : ep.source || "—")}</dd></div>
          <div><dt>収録論文</dt><dd>${ep.papers.length}本</dd></div>
          ${a ? `<div><dt>長さ（${esc(LANG[l].label)}）</dt><dd>${fmt(a.duration)} · ${esc(a.size)}</dd></div>` : ""}
          ${a && a.voice ? `<div><dt>音声</dt><dd>${esc(a.voice)}</dd></div>` : ""}
        </dl>
        <ul class="topic-grid" aria-label="各言語のテーマ">${langs}</ul>`;
    }
    if (sheet.tab === "papers") {
      const tr = transcriptNow(ep, l);
      const d = (a && a.duration) || 0;
      const items = ep.papers.map((p, i) => {
        const ch = tr && tr.chapters.find((c) => c.index === i);
        const meta = [p.id ? `arXiv:${p.id}` : "", p.category, p.published, (p.authors || []).length ? (p.authors.length > 3 ? `${p.authors.slice(0, 3).join(", ")} ほか` : p.authors.join(", ")) : ""].filter(Boolean).join(" · ");
        return `<li class="paper">
          <h3 class="paper-title">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</h3>
          <p class="paper-meta">${esc(meta)}</p>
          <div class="paper-actions">
            ${ch && d ? `<button type="button" class="chip-btn accent" data-seek-frac="${ch.frac}" data-ep="${esc(ep.date)}" data-l="${esc(l)}">${icon("play")}≈${fmt(ch.frac * d)} から聴く</button>` : ""}
            ${p.url ? `<a class="chip-btn" href="${esc(p.url)}" target="_blank" rel="noopener">${icon("external-link")}arXiv</a>` : ""}
            ${p.pdf ? `<a class="chip-btn" href="${esc(p.pdf)}" target="_blank" rel="noopener">${icon("file-text")}PDF</a>` : ""}
          </div>
          ${p.abstract ? `<details><summary>抄録を読む</summary><p lang="en">${esc(p.abstract)}</p></details>` : ""}
        </li>`;
      }).join("");
      return `${tr && tr.chapters.length ? `<p class="note" style="margin:0 0 12px">「から聴く」の位置は台本の文字数から計算した目安です。</p>` : ""}<ol class="paper-list">${items || "<li>この回の収録論文データはありません。</li>"}</ol>`;
    }
    if (sheet.tab === "transcript") {
      if (!a || !a.script) return `<p class="loading">この言語の文字起こしはありません。</p>`;
      const tr = transcriptNow(ep, l);
      if (!tr) return `<p class="loading">文字起こしを読み込み中…</p>`;
      const d = a.duration || 0;
      return `<p class="note" style="margin:0 0 14px">${esc(LANG[l].label)} の台本です。各行の時刻は文字数から計算した目安で、押すとその辺りから再生します。</p>
        <div class="transcript" lang="${esc(l)}">${tr.paras.map((p, i) => `<button type="button" class="t-line" data-seek-frac="${p.frac}" data-ep="${esc(ep.date)}" data-l="${esc(l)}" data-i="${i}"><time>≈${fmt(p.frac * d)}</time><span>${esc(p.text)}</span></button>`).join("")}</div>
        <p class="note"><a class="link-btn" href="${esc(a.script)}" target="_blank" rel="noopener">テキストファイルを開く</a></p>`;
    }
    const rows = LANGS.filter((x) => ep.audio[x.code]).map((x) => {
      const f = ep.audio[x.code];
      const cur = player.ep === ep && player.lang === x.code;
      return `<div class="file-row${cur ? " is-current" : ""}">
        <div><h3 lang="${esc(x.code)}">${esc(x.label)}</h3><p>${fmt(f.duration)} · ${esc(f.size)}${f.voice ? ` · ${esc(f.voice)}` : ""}</p></div>
        <div class="file-actions">
          <button type="button" class="icon-btn" data-play-lang="${esc(x.code)}" aria-label="${esc(x.label)} で再生" data-tip="この言語で再生">${icon(cur && !audio.paused ? "pause" : "play")}</button>
          <a class="icon-btn" href="${esc(f.src)}" download="${esc(f.file)}" aria-label="${esc(x.downloadLabel)}" data-tip="ダウンロード">${icon("download")}</a>
          ${f.script ? `<a class="icon-btn" href="${esc(f.script)}" target="_blank" rel="noopener" aria-label="${esc(x.transcriptLabel)}" data-tip="台本">${icon("file-text")}</a>` : ""}
          <a class="icon-btn" href="${esc(x.rss)}" aria-label="${esc(x.rssLabel)}" data-tip="RSS">${icon("rss")}</a>
        </div>
      </div>`;
    }).join("");
    return `<div class="files">${rows}</div>`;
  }

  const transcriptValues = new Map();
  function transcriptNow(ep, l) {
    const key = ep.date + ":" + l;
    if (transcriptValues.has(key)) return transcriptValues.get(key);
    const p = getTranscript(ep, l);
    p.then((tr) => { transcriptValues.set(key, tr); if (sheet.ep === ep && sheet.tab !== "about") renderSheet(); });
    return null;
  }

  let lastLine = -1;
  let userScrolledAt = 0;
  if (sheetEl) $(".sheet-scroll", sheetEl).addEventListener("wheel", () => { userScrolledAt = Date.now(); }, { passive: true });
  if (sheetEl) $(".sheet-scroll", sheetEl).addEventListener("touchmove", () => { userScrolledAt = Date.now(); }, { passive: true });
  function highlightTranscript(t) {
    if (!sheet.ep || sheet.tab !== "transcript" || player.ep !== sheet.ep) return;
    const lines = $$(".t-line", sheetEl);
    if (!lines.length || player.lang !== lines[0].dataset.l) return;
    const d = duration();
    if (!d) return;
    let cur = -1;
    lines.forEach((el, i) => { if (Number(el.dataset.seekFrac) * d <= t + 0.5) cur = i; });
    if (cur === lastLine && lines[cur] && lines[cur].classList.contains("is-now")) return;
    lastLine = cur;
    lines.forEach((el, i) => el.classList.toggle("is-now", i === cur));
    if (cur >= 0 && !audio.paused && Date.now() - userScrolledAt > 5000 && sheetEl.open) {
      lines[cur].scrollIntoView({ block: "center", behavior: motion.matches ? "auto" : "smooth" });
    }
  }

  if (sheetEl) {
    const tablist = $(".sheet-tabs", sheetEl);
    tablist.addEventListener("click", (e) => {
      const t = e.target.closest("[role=tab]");
      if (!t) return;
      sheet.tab = t.dataset.tab;
      renderSheet();
    });
    tablist.addEventListener("keydown", (e) => {
      const tabs = $$("[role=tab]", tablist);
      const i = tabs.indexOf(doc.activeElement);
      let n = -1;
      if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") n = 0;
      else if (e.key === "End") n = tabs.length - 1;
      if (n < 0) return;
      e.preventDefault();
      sheet.tab = tabs[n].dataset.tab;
      renderSheet();
      tabs[n].focus();
    });
    sheetEl.addEventListener("click", (e) => {
      const target = e.target;
      if (target.closest("[data-close]")) { closeSheet(); return; }
      const ep = sheet.ep;
      if (!ep) return;
      if (target.closest("[data-sheet-play]")) { toggleEpisode(ep, sheetLang(ep)); renderSheet(); return; }
      if (target.closest("[data-share]")) { share(ep); return; }
      if (target.closest("[data-reset]")) {
        LANGS.forEach((x) => store.remove(posKey(ep, x.code)));
        paintCards(); renderContinue(); renderSheet(); applyFilters();
        toast("再生記録を消しました");
        return;
      }
      const pl = target.closest("[data-play-lang]");
      if (pl) { const l = pl.dataset.playLang; if (l !== lang && COVERED.includes(l)) switchLang(l); toggleEpisode(ep, l); renderSheet(); return; }
      const sk = target.closest("[data-seek-frac]");
      if (sk) {
        const l = sk.dataset.l || sheetLang(ep);
        const d = (ep.audio[l] && ep.audio[l].duration) || duration();
        const at = Number(sk.dataset.seekFrac) * d;
        if (player.ep === ep && player.lang === l) { seekTo(at); if (audio.paused) start(); }
        else load(ep, l, { at, play: true });
        renderSheet();
      }
    });
  }

  function shareUrl(ep, t) {
    const u = new URL(location.href);
    u.hash = "ep-" + ep.date;
    u.search = "";
    if (lang !== COVERED[0]) u.searchParams.set("lang", lang);
    if (t > 1) u.searchParams.set("t", String(Math.floor(t)));
    return u.toString();
  }
  function share(ep) {
    const t = player.ep === ep ? position() : 0;
    const url = shareUrl(ep, t);
    const title = topicOf(ep, lang);
    if (navigator.share && !finePointer.matches) {
      navigator.share({ title, text: `音の図書館 — ${title}`, url }).catch(() => {});
      return;
    }
    copy(url, t > 1 ? `${fmt(t)} からのリンクをコピーしました` : "リンクをコピーしました");
  }
  function copy(text, message) {
    const done = () => toast(message || "コピーしました");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    ta.select();
    try { doc.execCommand("copy"); done(); } catch (err) { toast("コピーできませんでした"); }
    ta.remove();
  }

  // ---- continue listening ------------------------------------------------------------------------------------
  function renderContinue() {
    const section = $("#continue");
    const rail = $("#continue-rail");
    if (!section || !rail) return;
    const items = [];
    for (const ep of EPISODES) {
      let best = null;
      for (const l of Object.keys(ep.audio)) {
        const p = readPos(ep, l);
        if (!p) continue;
        const pr = progressOf(ep, l);
        if (pr.state !== "progress") continue;
        if (!best || p.at > best.at) best = { ep, l, at: p.at || 0, pr };
      }
      if (best) items.push(best);
    }
    items.sort((a, b) => b.at - a.at);
    const list = items.slice(0, 8);
    section.hidden = list.length === 0;
    rail.innerHTML = list.map(({ ep, l, pr }) => `<div class="rail-item" data-date="${esc(ep.date)}">
      <div class="rail-art">${coverMarkup(ep)}</div>
      <div class="rail-meta">
        <button type="button" class="rail-title" data-open="${esc(ep.date)}" lang="${esc(l)}">${esc(topicOf(ep, l))}</button>
        <p class="rail-sub">${esc(LANG[l] ? LANG[l].label : l)} · ${minutesLeft(pr.d - pr.t)}</p>
        <div class="bar" style="--p:${pr.frac.toFixed(3)}"><i></i></div>
      </div>
      <div class="rail-actions">
        <button type="button" class="play-fab" data-play data-lang="${esc(l)}" aria-pressed="false" aria-label="続きを再生: ${esc(topicOf(ep, l))}">${icon("play", "i-play")}${icon("pause", "i-pause")}<span class="spinner" aria-hidden="true"></span></button>
        <button type="button" class="icon-btn small" data-forget="${esc(l)}" aria-label="リストから外す" data-tip="外す">${icon("x")}</button>
      </div>
    </div>`).join("");
    paint();
  }

  // ---- hero CTA --------------------------------------------------------------------------------------------------
  function heroTarget() {
    const last = store.get("last", null);
    const ep = last && BY_DATE.get(last.date);
    if (ep && ep.audio[last.lang] && progressOf(ep, last.lang).state === "progress") return { ep, l: last.lang, resume: true };
    const latest = EPISODES.find((e) => e.audio[lang]) || EPISODES[0];
    return { ep: latest, l: latest.audio[lang] ? lang : Object.keys(latest.audio)[0], resume: false };
  }
  function updateHeroCta() {
    const btn = $("#hero-play");
    if (!btn) return;
    const { ep, l, resume } = heroTarget();
    const label = $(".hero-play-label", btn);
    const meta = $(".hero-play-meta", btn);
    if (resume) {
      const pr = progressOf(ep, l);
      label.textContent = "続きを再生";
      meta.textContent = minutesLeft(pr.d - pr.t);
      btn.setAttribute("aria-label", `続きを再生: ${topicOf(ep, l)}（${minutesLeft(pr.d - pr.t)}）`);
    } else {
      label.textContent = "最新回を再生";
      meta.textContent = ep.audio[l] ? fmt(ep.audio[l].duration) : "";
      btn.setAttribute("aria-label", `最新回を再生: ${topicOf(ep, l)}`);
    }
  }

  // ---- library filters ------------------------------------------------------------------------------------------
  const lib = $("#library");
  const qInput = $("#lib-q");
  let filter = "all";
  let sortOld = false;
  const haystack = new Map(EPISODES.map((ep) => [ep.date, [
    ep.date, ...Object.values(ep.topic || {}),
    ...ep.papers.flatMap((p) => [p.title, p.id, p.category, ...(p.authors || [])]),
  ].join(" \u0000 ").toLowerCase()]));

  function applyFilters() {
    if (!lib) return;
    const q = qInput ? qInput.value.trim().toLowerCase() : "";
    const terms = q ? q.split(/\s+/) : [];
    let shown = 0;
    $$(".episode", lib).forEach((card) => {
      const ep = BY_DATE.get(card.dataset.date);
      const text = haystack.get(card.dataset.date) || "";
      let ok = terms.every((t) => text.includes(t));
      if (ok && filter !== "all") {
        const st = ep.audio[lang] ? progressOf(ep, lang).state : "none";
        ok = st === filter;
      }
      card.hidden = !ok;
      if (ok) shown += 1;
    });
    $$(".month", lib).forEach((m) => { m.hidden = !$$(".episode", m).some((c) => !c.hidden); });
    $$(".timeline a", lib).forEach((a) => { const m = doc.getElementById("m-" + a.dataset.month); a.hidden = !m || m.hidden; });
    const none = $("#no-results");
    if (none) none.hidden = shown !== 0;
    const count = $("#result-count");
    if (count) count.textContent = q || filter !== "all" ? `${shown} / ${EPISODES.length} 件` : "";
  }
  if (qInput) {
    qInput.addEventListener("input", applyFilters);
    qInput.addEventListener("keydown", (e) => { if (e.key === "Escape" && qInput.value) { e.stopPropagation(); qInput.value = ""; applyFilters(); } });
  }
  $$("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    filter = b.dataset.filter;
    $$("[data-filter]").forEach((x) => { const on = x === b; x.classList.toggle("is-active", on); x.setAttribute("aria-pressed", String(on)); });
    applyFilters();
  }));
  const sortBtn = $("#sort-btn");
  if (sortBtn) sortBtn.addEventListener("click", () => {
    sortOld = !sortOld;
    sortBtn.setAttribute("aria-pressed", String(sortOld));
    $("span", sortBtn).textContent = sortOld ? "古い順" : "新しい順";
    const months = $(".months", lib);
    const tl = $(".timeline", lib);
    const reverse = (parent, sel) => { if (parent) $$(sel, parent).reverse().forEach((el) => parent.appendChild(el)); };
    reverse(months, ":scope > .month");
    $$(".grid", lib).forEach((g) => reverse(g, ":scope > .episode"));
    reverse(tl, ":scope > a");
    toast(sortOld ? "古い順に並べました" : "新しい順に並べました");
  });
  function setView(view) {
    if (!lib) return;
    lib.classList.toggle("is-list", view === "list");
    $$("[data-view]").forEach((b) => { const on = b.dataset.view === view; b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on)); });
    store.set("view", view);
  }
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  function focusSearch() {
    if (!qInput) return;
    closeSheet();
    qInput.focus({ preventScroll: true });
    qInput.scrollIntoView({ block: "center", behavior: motion.matches ? "auto" : "smooth" });
  }

  // ---- timeline active month -------------------------------------------------------------------------------------
  if ("IntersectionObserver" in window && lib) {
    const links = new Map($$(".timeline a", lib).map((a) => [a.dataset.month, a]));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        links.forEach((a, m) => a.classList.toggle("is-active", m === en.target.dataset.month));
      });
    }, { rootMargin: "-30% 0px -60% 0px" });
    $$(".month", lib).forEach((m) => io.observe(m));
  }

  // ---- media session ------------------------------------------------------------------------------------------------
  const artCache = new Map();
  function setArtwork(ep) {
    if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
    const meta = (artwork) => {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: topicOf(ep, player.lang),
          artist: "Phantomresearch Daily",
          album: `音の図書館 · ${dateText(ep)}`,
          artwork,
        });
      } catch (err) { /* unsupported */ }
    };
    if (artCache.has(ep.date)) { meta(artCache.get(ep.date)); return; }
    meta([]);
    const svg = coverMarkup(ep);
    if (!svg) return;
    const img = new Image();
    img.onload = () => {
      try {
        const size = 512;
        const c = doc.createElement("canvas");
        c.width = size;
        c.height = size;
        const g = c.getContext("2d");
        const scale = Math.max(size / img.width, size / img.height);
        g.drawImage(img, (size - img.width * scale) / 2, (size - img.height * scale) / 2, img.width * scale, img.height * scale);
        const art = [{ src: c.toDataURL("image/png"), sizes: "512x512", type: "image/png" }];
        artCache.set(ep.date, art);
        if (player.ep === ep) meta(art);
      } catch (err) { /* tainted or unsupported */ }
    };
    img.width = 640;
    img.height = 400;
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.replace("<svg ", '<svg width="640" height="400" '));
  }
  if ("mediaSession" in navigator && navigator.mediaSession.setActionHandler) {
    const handlers = {
      play: () => togglePlayer(),
      pause: () => audio.pause(),
      stop: () => audio.pause(),
      seekbackward: (d) => skip(-((d && d.seekOffset) || 15)),
      seekforward: (d) => skip((d && d.seekOffset) || 30),
      seekto: (d) => { if (d && typeof d.seekTime === "number") seekTo(d.seekTime); },
      previoustrack: () => goNeighbor(-1),
      nexttrack: () => goNeighbor(1),
    };
    Object.entries(handlers).forEach(([k, fn]) => { try { navigator.mediaSession.setActionHandler(k, fn); } catch (err) { /* unsupported action */ } });
  }

  // ---- global clicks -----------------------------------------------------------------------------------------------------
  doc.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest(".tab[data-lang-tab]");
    if (tab) { switchLang(tab.dataset.langTab); return; }
    const forget = target.closest("[data-forget]");
    if (forget) {
      const item = forget.closest("[data-date]");
      const ep = item && BY_DATE.get(item.dataset.date);
      if (ep) { store.remove(posKey(ep, forget.dataset.forget)); paintCards(); renderContinue(); updateHeroCta(); applyFilters(); }
      return;
    }
    const play = target.closest("[data-play]");
    if (play) {
      e.preventDefault();
      const host = play.closest("[data-date]");
      const ep = host && BY_DATE.get(host.dataset.date);
      toggleEpisode(ep, play.dataset.lang || lang);
      return;
    }
    const opener = target.closest("[data-open]");
    if (opener) { openSheet(BY_DATE.get(opener.dataset.open)); return; }
    const link = target.closest("a.open-card");
    if (link) {
      e.preventDefault();
      const host = link.closest("[data-date]");
      openSheet(host && BY_DATE.get(host.dataset.date));
      return;
    }
    const teaJump = target.closest("[data-tea-jump]");
    if (teaJump) { showTea(teaJump.dataset.teaJump); return; }
    const stampBtn = target.closest("[data-stamp]");
    if (stampBtn) { armBoothStamp(stampBtn.dataset.stamp); return; }
    const penBtn = target.closest("[data-pen]");
    if (penBtn) { armBoothPen(penBtn.dataset.pen); return; }
    const shotBtn = target.closest("[data-shot]");
    if (shotBtn) { selectBoothShot(Number(shotBtn.dataset.shot)); return; }
    const copyBtn = target.closest("[data-copy]");
    if (copyBtn) { copy(new URL(copyBtn.dataset.copy, location.href).toString(), "RSS の URL をコピーしました"); return; }
    const seekBtn = target.closest(".dock [data-seek-frac]");
    if (seekBtn) { seekTo(Number(seekBtn.dataset.seekFrac) * duration()); if (audio.paused) start(); return; }
    const action = target.closest("[data-action]");
    if (!action) return;
    switch (action.dataset.action) {
      case "toggle": togglePlayer(); break;
      case "back": skip(-15); break;
      case "fwd": skip(30); break;
      case "prev": goNeighbor(-1); break;
      case "next": goNeighbor(1); break;
      case "details": if (player.ep) { setExpanded(false); openSheet(player.ep, { tab: "transcript" }); } break;
      case "expand": if (isCompact()) setExpanded(!dock.classList.contains("is-expanded")); else if (player.ep) openSheet(player.ep); break;
      case "collapse": setExpanded(false); break;
      case "search": focusSearch(); break;
      case "shortcuts": openShortcuts(); break;
      case "clear-filters":
        if (qInput) qInput.value = "";
        { const all = $('[data-filter="all"]'); if (all) all.click(); else applyFilters(); }
        break;
      case "hero-play": {
        const { ep, l } = heroTarget();
        toggleEpisode(ep, l);
        break;
      }
      case "air": drawAir(); break;
      case "booth-open": openBooth(); break;
      case "booth-close": closeBooth(); break;
      case "booth-left": spinBooth(-28); break;
      case "booth-right": spinBooth(28); break;
      case "booth-shutter": takeBoothPhoto(); break;
      case "booth-save": saveBooth(); break;
      case "booth-clear": clearBoothDecor(); break;
      default: break;
    }
  });

  const tea = $("#tearoom");
  let teaIndex = 0;
  function teaOpen() {
    return Boolean(tea && (tea.classList.contains("is-on") || location.hash === "#tearoom"));
  }
  function showTea(id) {
    if (!tea) return;
    const rooms = $$(".tea-room", tea);
    const jumps = $$("[data-tea-jump]", tea);
    let index = rooms.findIndex((room) => room.dataset.tea === id);
    if (index < 0) index = 0;
    teaIndex = index;
    rooms.forEach((room, i) => room.classList.toggle("is-on", i === index));
    jumps.forEach((button, i) => {
      const on = i === index;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-current", on ? "true" : "false");
    });
    if (boothOpen()) loadBoothRoom(rooms[index].dataset.tea);
  }
  function setTeaMode(on) {
    if (!tea) return;
    tea.classList.toggle("is-on", on);
    doc.body.classList.toggle("tea-open", on);
    if (on) showTea(($$(".tea-room.is-on", tea)[0] || $$(".tea-room", tea)[0] || {}).dataset?.tea);
  }
  function stepTea(dir) {
    const rooms = $$(".tea-room", tea);
    if (!rooms.length) return;
    showTea(rooms[(teaIndex + dir + rooms.length) % rooms.length].dataset.tea);
  }
  window.addEventListener("hashchange", () => setTeaMode(location.hash === "#tearoom"));
  if (location.hash === "#tearoom") setTeaMode(true);

  const boothShots = [];
  let boothYaw = 0;
  let boothRoom = null;
  let boothWalls = null;
  let boothStamp = "";
  let boothPen = "";
  let boothShot = 0;
  let boothDrag = null;
  const FACES = ["床の間", "脇の窓", "入口", "逆の脇"];

  function boothOpen() {
    const el = $("#booth");
    return Boolean(el && !el.hidden);
  }
  function boothList() {
    const node = $("#tea-booth");
    if (!node) return [];
    try { return JSON.parse(node.textContent); } catch (err) { return []; }
  }
  function loadBoothRoom(id) {
    boothRoom = boothList().find((room) => room.id === id) || boothList()[0] || null;
    boothWalls = null;
    const name = $("#booth-name");
    if (name && boothRoom) name.textContent = `${boothRoom.name}を見回す`;
    paintBooth();
  }
  function openBooth() {
    const el = $("#booth");
    if (!el) return;
    if (location.hash !== "#tearoom") location.hash = "tearoom";
    el.hidden = false;
    doc.body.classList.add("booth-open");
    const current = ($$(".tea-room.is-on")[0] || {}).dataset?.tea;
    loadBoothRoom(current);
    const status = $("#booth-status");
    if (status && boothRoom) status.textContent = `${boothRoom.name}の中です。ドラッグで見回せます。`;
  }
  function closeBooth() {
    const el = $("#booth");
    if (el) el.hidden = true;
    doc.body.classList.remove("booth-open");
  }
  function spinBooth(delta) {
    boothYaw += delta;
    paintBooth();
  }
  function paintWall(ctx, x, y, w, h, face, room) {
    const gold = room.gold;
    ctx.fillStyle = gold ? "#c6a45a" : "#322820";
    ctx.fillRect(x, y, w, h * 0.22);
    ctx.fillStyle = gold ? "#e2c56a" : room.shoin ? "#e7e0d2" : "#6e5748";
    ctx.fillRect(x, y + h * 0.22, w, h * 0.46);
    ctx.fillStyle = "#c6b07a";
    ctx.fillRect(x, y + h * 0.68, w, h * 0.32);
    ctx.strokeStyle = "#3a2c1c";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.68);
    ctx.lineTo(x + w, y + h * 0.68);
    ctx.stroke();
    ctx.strokeStyle = gold ? "#8a6a32" : "#241c16";
    ctx.lineWidth = 3;
    for (let i = 1; i < 6; i += 1) {
      const xx = x + (w * i) / 6;
      ctx.beginPath();
      ctx.moveTo(xx, y);
      ctx.lineTo(xx, y + h * 0.22);
      ctx.stroke();
    }
    if (face === 0) {
      const tx = x + w * 0.52;
      const ty = y + h * 0.26;
      const tw = w * 0.34;
      const th = h * 0.4;
      ctx.fillStyle = gold ? "#f0d78a" : "#3a2e28";
      ctx.fillRect(tx, ty, tw, th);
      ctx.fillStyle = gold ? "#7a1c1c" : "#6b4228";
      ctx.fillRect(tx - 8, ty, 10, th);
      ctx.fillStyle = "#f7f1e6";
      ctx.fillRect(tx + tw * 0.22, ty + 18, tw * 0.5, th * 0.42);
      ctx.fillStyle = "#3d6a3a";
      ctx.beginPath();
      ctx.arc(tx + tw * 0.82, ty + th * 0.62, 7, 0, Math.PI * 2);
      ctx.fill();
      if (room.hearth) {
        ctx.fillStyle = "#1a1612";
        ctx.fillRect(x + w * 0.16, y + h * 0.74, w * 0.14, h * 0.1);
        ctx.fillStyle = "#2c2c2c";
        ctx.beginPath();
        ctx.ellipse(x + w * 0.23, y + h * 0.76, w * 0.04, h * 0.03, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (face === 1) {
      room.windows.forEach((kind, index) => {
        const wx = x + w * (0.12 + (index % 3) * 0.28);
        const wy = y + h * (0.3 + Math.floor(index / 3) * 0.16);
        const ww = w * 0.18;
        const wh = h * 0.16;
        if (kind === "round") {
          ctx.fillStyle = "#c5d2c2";
          ctx.beginPath();
          ctx.ellipse(wx + ww / 2, wy + wh / 2, ww / 2, wh / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (kind === "renji" || kind === "shitaji") {
          ctx.fillStyle = "#14110e";
          ctx.fillRect(wx, wy, ww, wh);
          ctx.strokeStyle = "#d7c39a";
          ctx.lineWidth = 2;
          for (let i = 1; i < 6; i += 1) {
            ctx.beginPath();
            ctx.moveTo(wx + (ww * i) / 6, wy);
            ctx.lineTo(wx + (ww * i) / 6, wy + wh);
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = "#f7f1e4";
          ctx.fillRect(wx, wy, ww, wh);
          ctx.strokeStyle = "#8d7352";
          ctx.lineWidth = 1.5;
          for (let i = 1; i < 4; i += 1) {
            ctx.beginPath();
            ctx.moveTo(wx + (ww * i) / 4, wy);
            ctx.lineTo(wx + (ww * i) / 4, wy + wh);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(wx, wy + (wh * i) / 4);
            ctx.lineTo(wx + ww, wy + (wh * i) / 4);
            ctx.stroke();
          }
        }
      });
      if (room.kato) {
        ctx.fillStyle = "#f4efe4";
        ctx.beginPath();
        ctx.moveTo(x + w * 0.4, y + h * 0.5);
        ctx.quadraticCurveTo(x + w * 0.5, y + h * 0.28, x + w * 0.6, y + h * 0.5);
        ctx.fill();
      }
    }
    if (face === 2) {
      if (room.nijiri) {
        ctx.fillStyle = "#100e0c";
        ctx.fillRect(x + w * 0.14, y + h * 0.5, w * 0.2, h * 0.16);
        ctx.strokeStyle = "#cbb892";
        ctx.lineWidth = 3;
        ctx.strokeRect(x + w * 0.14, y + h * 0.5, w * 0.2, h * 0.16);
      }
      if (room.garden) {
        ctx.fillStyle = "#7fa07a";
        ctx.fillRect(x + w * 0.55, y + h * 0.28, w * 0.3, h * 0.22);
      }
    }
    if (face === 3 && room.checker) {
      const size = Math.max(12, w * 0.04);
      for (let row = 0; row < 6; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          ctx.fillStyle = (row + col) % 2 ? "#1d3f72" : "#f4efe6";
          ctx.fillRect(x + w * 0.58 + col * size, y + h * 0.32 + row * size, size, size);
        }
      }
    }
    if (room.dim && !gold) {
      ctx.fillStyle = "rgba(0,0,0,.3)";
      ctx.fillRect(x, y, w, h);
    }
  }
  function ensureBoothWalls() {
    const view = $("#booth-view");
    if (!view || !boothRoom) return null;
    if (boothWalls && boothWalls.dataset.id === boothRoom.id) return boothWalls;
    const wall = doc.createElement("canvas");
    wall.width = view.width * 4;
    wall.height = view.height;
    wall.dataset.id = boothRoom.id;
    const ctx = wall.getContext("2d");
    for (let face = 0; face < 4; face += 1) paintWall(ctx, face * view.width, 0, view.width, view.height, face, boothRoom);
    boothWalls = wall;
    return wall;
  }
  function paintBooth() {
    const view = $("#booth-view");
    const wall = ensureBoothWalls();
    if (!view || !wall) return;
    const ctx = view.getContext("2d");
    const span = wall.width;
    const shift = ((boothYaw % 360) + 360) % 360 / 360 * span;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(wall, shift, 0, view.width, view.height, 0, 0, view.width, view.height);
    const remain = span - shift;
    if (remain < view.width) ctx.drawImage(wall, 0, 0, view.width - remain, view.height, remain, 0, view.width - remain, view.height);
    const facing = $("#booth-facing");
    if (facing) {
      const index = Math.round((((boothYaw % 360) + 360) % 360) / 90) % 4;
      facing.textContent = FACES[index];
    }
  }
  function takeBoothPhoto() {
    const view = $("#booth-view");
    if (!view || !boothRoom) return;
    const snap = doc.createElement("canvas");
    snap.width = view.width;
    snap.height = view.height;
    snap.getContext("2d").drawImage(view, 0, 0);
    boothShots.push({ name: boothRoom.name, reading: boothRoom.reading, canvas: snap, stamps: [], strokes: [] });
    if (boothShots.length > 4) boothShots.shift();
    boothShot = boothShots.length - 1;
    const stage = $(".booth-stage");
    if (stage) {
      stage.classList.add("is-flash");
      setTimeout(() => stage.classList.remove("is-flash"), 140);
    }
    const status = $("#booth-status");
    if (status) status.textContent = `${boothRoom.name}を${boothShots.length}枚目に撮りました。`;
    paintBoothStrip();
    paintBoothPrint();
  }
  function selectedShot() { return boothShots[boothShot] || null; }
  function paintBoothStrip() {
    const strip = $("#booth-strip");
    if (!strip) return;
    strip.innerHTML = boothShots.map((shot, index) => `<button type="button" data-shot="${index}" class="${index === boothShot ? "is-on" : ""}" aria-label="${shot.name}の${index + 1}枚目"><img alt="" src="${shot.canvas.toDataURL("image/jpeg", 0.7)}"></button>`).join("");
  }
  function drawStamp(ctx, stamp, x, y, w, h) {
    const px = x + stamp.x * w;
    const py = y + stamp.y * h;
    ctx.save();
    ctx.translate(px, py);
    ctx.fillStyle = "#e85d75";
    if (stamp.kind === "heart") {
      ctx.beginPath();
      ctx.arc(-6, 0, 7, 0, Math.PI * 2);
      ctx.arc(6, 0, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-12, 2);
      ctx.lineTo(0, 16);
      ctx.lineTo(12, 2);
      ctx.fill();
    } else if (stamp.kind === "kettle") {
      ctx.fillStyle = "#2c2c2c";
      ctx.fillRect(-10, -4, 20, 14);
      ctx.strokeStyle = "#2c2c2c";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(12, 4, 6, -1, 1);
      ctx.stroke();
    } else if (stamp.kind === "word") {
      ctx.fillStyle = "#1c160b";
      ctx.font = "700 18px serif";
      ctx.textAlign = "center";
      ctx.fillText("一期一会", 0, 6);
    } else {
      ctx.fillStyle = "#f4f1ec";
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3d6a3a";
      ctx.beginPath();
      ctx.moveTo(0, 8);
      ctx.lineTo(0, 20);
      ctx.stroke();
    }
    ctx.restore();
  }
  function paintBoothPrint() {
    const print = $("#booth-print");
    const shot = selectedShot();
    if (!print) return;
    const ctx = print.getContext("2d");
    ctx.fillStyle = "#2a241c";
    ctx.fillRect(0, 0, print.width, print.height);
    if (!shot) {
      ctx.fillStyle = "#a3988a";
      ctx.font = "18px sans-serif";
      ctx.fillText("撮ると、ここにプリクラが出ます", 36, print.height / 2);
      return;
    }
    ctx.drawImage(shot.canvas, 16, 16, print.width - 32, print.height - 56);
    shot.stamps.forEach((stamp) => drawStamp(ctx, stamp, 16, 16, print.width - 32, print.height - 56));
    shot.strokes.forEach((stroke) => {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      stroke.pts.forEach((pt, index) => {
        const px = 16 + pt.x * (print.width - 32);
        const py = 16 + pt.y * (print.height - 56);
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    });
    ctx.fillStyle = "#f4efe6";
    ctx.font = "600 22px serif";
    ctx.fillText(`${shot.name}　${shot.reading}`, 20, print.height - 16);
  }
  function selectBoothShot(index) {
    if (!boothShots[index]) return;
    boothShot = index;
    paintBoothStrip();
    paintBoothPrint();
  }
  function armBoothStamp(kind) {
    boothStamp = boothStamp === kind ? "" : kind;
    boothPen = "";
    $$("[data-stamp]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.stamp === boothStamp && boothStamp !== "")));
    $$("[data-pen]").forEach((button) => button.setAttribute("aria-pressed", "false"));
  }
  function armBoothPen(color) {
    boothPen = boothPen === color ? "" : color;
    boothStamp = "";
    $$("[data-pen]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.pen === boothPen && boothPen !== "")));
    $$("[data-stamp]").forEach((button) => button.setAttribute("aria-pressed", "false"));
  }
  function clearBoothDecor() {
    const shot = selectedShot();
    if (!shot) return;
    shot.stamps = [];
    shot.strokes = [];
    paintBoothPrint();
  }
  function boothPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const padX = 16 / canvas.width;
    const padY = 16 / canvas.height;
    const innerH = (canvas.height - 56) / canvas.height;
    return {
      x: Math.min(1, Math.max(0, (x - padX) / (1 - padX * 2))),
      y: Math.min(1, Math.max(0, (y - padY) / innerH)),
    };
  }
  function saveBooth() {
    if (!boothShots.length) { toast("先に撮ってください"); return; }
    const sheet = doc.createElement("canvas");
    sheet.width = 720;
    sheet.height = 88 + boothShots.length * 390 + 72;
    const ctx = sheet.getContext("2d");
    ctx.fillStyle = "#f7f1e6";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.fillStyle = "#1c160b";
    ctx.font = "700 28px serif";
    ctx.fillText("音の図書館　茶室プリクラ", 28, 48);
    boothShots.forEach((shot, index) => {
      const y = 72 + index * 390;
      ctx.fillStyle = "#1c160b";
      ctx.fillRect(24, y, 672, 370);
      ctx.drawImage(shot.canvas, 36, y + 12, 648, 300);
      shot.stamps.forEach((stamp) => drawStamp(ctx, stamp, 36, y + 12, 648, 300));
      shot.strokes.forEach((stroke) => {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        stroke.pts.forEach((pt, i) => {
          const px = 36 + pt.x * 648;
          const py = y + 12 + pt.y * 300;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });
      ctx.fillStyle = "#f4efe6";
      ctx.font = "600 20px serif";
      ctx.fillText(shot.name, 44, y + 348);
    });
    const link = doc.createElement("a");
    link.href = sheet.toDataURL("image/png");
    link.download = "tearoom-purikura.png";
    link.click();
    toast("プリクラを保存しました");
  }
  function bindBooth() {
    const view = $("#booth-view");
    const print = $("#booth-print");
    $$("[data-pen]").forEach((button) => { button.style.background = button.dataset.pen; });
    if (view) {
      view.addEventListener("pointerdown", (event) => {
        boothDrag = { x: event.clientX, id: event.pointerId };
        view.setPointerCapture(event.pointerId);
      });
      view.addEventListener("pointermove", (event) => {
        if (!boothDrag || boothDrag.id !== event.pointerId) return;
        boothYaw -= (event.clientX - boothDrag.x) * 0.35;
        boothDrag.x = event.clientX;
        paintBooth();
      });
      const end = () => { boothDrag = null; };
      view.addEventListener("pointerup", end);
      view.addEventListener("pointercancel", end);
    }
    if (print) {
      print.addEventListener("pointerdown", (event) => {
        const shot = selectedShot();
        if (!shot) return;
        const pt = boothPoint(event, print);
        if (boothStamp) {
          shot.stamps.push({ kind: boothStamp, x: pt.x, y: pt.y });
          paintBoothPrint();
          return;
        }
        if (!boothPen) return;
        boothDrag = { draw: true, id: event.pointerId };
        shot.strokes.push({ color: boothPen, pts: [pt] });
        print.setPointerCapture(event.pointerId);
        paintBoothPrint();
      });
      print.addEventListener("pointermove", (event) => {
        if (!boothDrag || !boothDrag.draw || boothDrag.id !== event.pointerId) return;
        const shot = selectedShot();
        const stroke = shot && shot.strokes[shot.strokes.length - 1];
        if (!stroke) return;
        stroke.pts.push(boothPoint(event, print));
        paintBoothPrint();
      });
      const end = () => { if (boothDrag && boothDrag.draw) boothDrag = null; };
      print.addEventListener("pointerup", end);
      print.addEventListener("pointercancel", end);
    }
    paintBoothPrint();
  }

  function drawAir() {
    const node = doc.getElementById("air-catalog");
    if (!node) return;
    let list;
    try { list = JSON.parse(node.textContent); } catch (err) { return; }
    if (!list.length) return;
    const cur = root.dataset.air;
    let next = list[Math.floor(Math.random() * list.length)];
    if (list.length > 1) {
      let guard = 0;
      while (next.id === cur && guard < 8) {
        next = list[Math.floor(Math.random() * list.length)];
        guard += 1;
      }
    }
    root.dataset.air = next.id;
    try { sessionStorage.setItem("oto:air", next.id); } catch (err) { /* private mode */ }
    const name = doc.getElementById("air-name");
    const note = doc.getElementById("air-note");
    if (name) name.textContent = next.name;
    if (note) note.textContent = `${next.note} — ${next.source}`;
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta && next.bg) meta.setAttribute("content", next.bg);
    toast(`${next.name}`);
  }

  function openShortcuts() {
    const d = $("#shortcuts");
    if (!d) return;
    if (d.showModal) d.showModal(); else d.setAttribute("open", "");
  }
  const sc = $("#shortcuts");
  if (sc) {
    sc.addEventListener("click", (e) => { if (e.target === sc || e.target.closest("[data-close]")) sc.close(); });
  }

  // ---- keyboard ---------------------------------------------------------------------------------------------------------
  doc.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    const t = e.target instanceof Element ? e.target : doc.body;
    const key = e.key;
    if ((e.metaKey || e.ctrlKey) && key.toLowerCase() === "k") { e.preventDefault(); focusSearch(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = t.closest("textarea, select, [contenteditable=true]") || (t.matches("input") && t.type !== "range");
    if (typing) return;
    if (boothOpen()) {
      if (key === "Escape") { e.preventDefault(); closeBooth(); return; }
      if (key === "ArrowLeft") { e.preventDefault(); spinBooth(-18); return; }
      if (key === "ArrowRight") { e.preventDefault(); spinBooth(18); return; }
    }
    if (teaOpen()) {
      if (key === "Escape") { e.preventDefault(); location.hash = "top"; return; }
      if (key === "ArrowLeft") { e.preventDefault(); stepTea(-1); return; }
      if (key === "ArrowRight") { e.preventDefault(); stepTea(1); return; }
    }
    if (key === "Escape" && dock.classList.contains("is-expanded")) { setExpanded(false); return; }
    const onControl = t.closest("button, a, summary, [role=tab], input[type=range]");
    switch (key) {
      case " ":
        if (onControl) return;
        e.preventDefault(); togglePlayer(); break;
      case "k": case "K": e.preventDefault(); togglePlayer(); break;
      case "j": case "J": e.preventDefault(); skip(-15); break;
      case "l": case "L": e.preventDefault(); skip(30); break;
      case "ArrowLeft": if (t.closest("[role=tablist], .tabs, .seg")) return; e.preventDefault(); skip(-5); break;
      case "ArrowRight": if (t.closest("[role=tablist], .tabs, .seg")) return; e.preventDefault(); skip(5); break;
      case "m": case "M": audio.muted = !audio.muted; paintVolume(); toast(audio.muted ? "ミュート" : "ミュート解除"); break;
      case ">": stepRate(1); break;
      case "<": stepRate(-1); break;
      case "N": goNeighbor(1); break;
      case "P": goNeighbor(-1); break;
      case "/": e.preventDefault(); focusSearch(); break;
      case "?": e.preventDefault(); openShortcuts(); break;
      default: break;
    }
  });

  // ---- motion: reveal, parallax, hero scrub ---------------------------------------------------------------------------------
  if (!motion.matches) {
    if ("IntersectionObserver" in window) {
      const reveal = new IntersectionObserver((entries) => {
        entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("is-in"); reveal.unobserve(en.target); } });
      }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
      $$(".episode").forEach((card) => {
        const r = card.getBoundingClientRect();
        if (r.top < window.innerHeight) return;
        card.classList.add("will-rise");
        reveal.observe(card);
      });
    }
    $$(".episode, .feature").forEach((card) => {
      card.addEventListener("pointermove", (e) => {
        if (e.pointerType !== "mouse") return;
        const r = card.getBoundingClientRect();
        card.style.setProperty("--px", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
        card.style.setProperty("--py", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
      });
      card.addEventListener("pointerleave", () => { card.style.setProperty("--px", "0"); card.style.setProperty("--py", "0"); });
    });
    let scrollRaf = 0;
    window.addEventListener("scroll", () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        root.style.setProperty("--scrub", clamp(window.scrollY / (window.innerHeight * 0.9), 0, 1).toFixed(3));
      });
    }, { passive: true });
  }

  // ---- boot ------------------------------------------------------------------------------------------------------------------
  setRate(rate);
  paintVolume();
  paintAutoplay();
  paintSleep();
  bindBooth();
  setView(store.get("view", "grid"));
  applyLang(lang);
  {
    const params = new URLSearchParams(location.search);
    const t0 = Number(params.get("t"));
    const hashEp = epFromHash();
    if (hashEp && hashEp.audio[lang]) {
      load(hashEp, lang, { at: t0 > 0 ? t0 : undefined, play: false, prime: true });
      if (t0 > 0) toast(`${fmt(t0)} から再生できます`);
    } else {
      const { ep, l } = heroTarget();
      if (ep && ep.audio[l]) load(ep, l, { play: false, prime: true });
    }
    if (hashEp) openSheet(hashEp, { push: false });
  }
  paint();
})();
