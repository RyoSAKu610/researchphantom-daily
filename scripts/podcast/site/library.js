/* Phantomresearch Daily — 音の図書館 client.
   Inlined into index.html by site.mjs. Reads the embedded #library-data JSON
   and upgrades the server-rendered page: sound-field hero, scroll-lit
   statement, bookshelf, reading-room dialog, card catalog and mini player.
   Every storage access is wrapped: the page works with storage blocked. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var dataEl = $("#library-data");
  if (!dataEl) return;
  var D;
  try { D = JSON.parse(dataEl.textContent); } catch (e) { return; }
  var EPS = D.episodes || [];
  var LANGS = D.languages || [];
  var root = document.documentElement;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia && matchMedia("(pointer: fine)").matches;

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem("rp:" + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("rp:" + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del: function (k) { try { localStorage.removeItem("rp:" + k); } catch (e) { /* storage blocked */ } }
  };
  var ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 4.6v14.8a1 1 0 0 0 1.52.85l12.1-7.4a1 1 0 0 0 0-1.7L9.02 3.75A1 1 0 0 0 7.5 4.6z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="4" width="4.6" height="16" rx="1.3"/><rect x="13.9" y="4" width="4.6" height="16" rx="1.3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    orn: '<svg class="cover-orn" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><circle cx="24" cy="24" r="22"/><circle cx="24" cy="24" r="15" stroke-dasharray="2 3"/><path d="M14 24h3M31 24h3M18 24c0-3 1.5-6 3-6s1.5 12 3 12 1.5-12 3-12 3 3 3 6"/></svg>'
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clock(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }
  function mb(bytes) { return bytes ? (bytes / 1e6).toFixed(1) + " MB" : ""; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function seeded(seed) {
    var h = 2166136261;
    for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
  }
  function byNo(no) { return EPS.length - Number(no); }

  var toastTimer;
  function toast(msg) {
    var el = $("[data-toast]");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("is-on"); }, 2200);
  }

  /* ---------------- language ---------------- */
  var lang = store.get("lang", null);
  if (LANGS.indexOf(lang) < 0) {
    var nav = (navigator.language || "ja").slice(0, 2).toLowerCase();
    lang = LANGS.indexOf(nav) >= 0 ? nav : LANGS.indexOf("ja") >= 0 ? "ja" : LANGS[0];
  }
  function label(ep, l) { l = l || lang; return (ep.labels && (ep.labels[l] || ep.labels.ja)) || ep.topicId; }
  function voiceFor(ep, l) {
    l = l || lang;
    if (ep.audio[l]) return l;
    for (var i = 0; i < LANGS.length; i++) if (ep.audio[LANGS[i]]) return LANGS[i];
    return null;
  }
  function spineLen(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      n += (c >= 0x3000 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) ? 1 : text[i] === " " ? 0.3 : 0.58;
    }
    return Math.max(1, n);
  }
  function spineFont(text, h, w) {
    var len = Math.max(1, Math.round(spineLen(text) * 10) / 10);
    var avail = h - 118, one = avail / len;
    var size = one >= 12.5 ? Math.min(19, one) : Math.min(16, avail / Math.ceil(len / 2), (w - 10) / 2 / 1.18);
    return Math.max(10, Math.floor(size * 10) / 10);
  }
  function setLang(l) {
    if (LANGS.indexOf(l) < 0) return;
    lang = l;
    store.set("lang", l);
    root.setAttribute("data-lang", l);
    $$("[data-lang-tab]").forEach(function (t) {
      var on = t.getAttribute("data-lang-tab") === l;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-pressed", String(on));
    });
    $$(".spine[data-i]").forEach(function (sp) {
      var ep = EPS[byNo(sp.getAttribute("data-i"))];
      if (!ep) return;
      var t = label(ep);
      $(".spine-title", sp).textContent = t;
      var cs = sp.style;
      cs.setProperty("--fs", String(spineFont(t, Number(cs.getPropertyValue("--h")) || 260, Number(cs.getPropertyValue("--w")) || 52)));
      sp.setAttribute("aria-label", "No." + ep.no + " " + ep.date + " " + t);
    });
    hero.refresh();
    catalog.render();
    if (room.index != null) room.render(room.index, { keep: true });
    player.refreshMeta();
  }
  $$("[data-lang-tab]").forEach(function (t) {
    t.addEventListener("click", function () { setLang(t.getAttribute("data-lang-tab")); });
  });

  /* ---------------- audio + player ---------------- */
  var audio = new Audio();
  audio.preload = "none";
  var actx = null, analyser = null, freq = null;
  // Web Audio analyser only on desktop pointers over http(s): file:// would
  // taint the media element (silent output) and iOS suspends AudioContext in
  // the background, which would cut lock-screen playback.
  function ensureGraph() {
    if (actx) { if (actx.state === "suspended") actx.resume(); return; }
    if (!finePointer || !/^https?:$/.test(location.protocol)) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      actx = new AC();
      var src = actx.createMediaElementSource(audio);
      analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.84;
      src.connect(analyser);
      analyser.connect(actx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) { actx = null; analyser = null; }
  }

  var player = (function () {
    var el = $("[data-player]");
    var wave = $("[data-pl-wave]");
    var RATES = [1, 1.25, 1.5, 1.75, 2, 0.8];
    var rate = store.get("rate", 1);
    if (RATES.indexOf(rate) < 0) rate = 1;
    var cur = null; // {i, l}
    var bars = [];
    var hoverX = -1;
    var lastSave = 0;

    function key(c) { return "pos:" + EPS[c.i].date + ":" + c.l; }
    function savePos(force) {
      if (!cur || !audio.duration) return;
      var now = Date.now();
      if (!force && now - lastSave < 4000) return;
      lastSave = now;
      if (audio.currentTime > 8 && audio.currentTime < audio.duration - 12) store.set(key(cur), Math.floor(audio.currentTime));
      else store.del(key(cur));
    }

    function play(i, l, opts) {
      opts = opts || {};
      var ep = EPS[i];
      if (!ep) return;
      l = voiceFor(ep, l);
      if (!l) return;
      if (cur && cur.i === i && cur.l === l) {
        if (opts.seek != null) audio.currentTime = opts.seek;
        if (audio.paused) resume(); else if (!opts.seek) audio.pause();
        return;
      }
      savePos(true);
      cur = { i: i, l: l };
      var a = ep.audio[l];
      audio.src = a.path;
      audio.playbackRate = rate;
      var saved = store.get(key(cur), 0);
      var start = opts.seek != null ? opts.seek : saved;
      if (start > 0) {
        audio.addEventListener("loadedmetadata", function () {
          try { audio.currentTime = start; } catch (e) { /* not seekable yet */ }
        }, { once: true });
      }
      buildBars();
      refreshMeta();
      show();
      resume();
      mediaSession();
    }
    function resume() {
      ensureGraph();
      var p = audio.play();
      if (p && p.catch) p.catch(function (err) {
        if (err && err.name !== "AbortError") toast("再生できませんでした");
      });
    }
    function toggle() {
      if (!cur) { hero.play(); return; }
      if (audio.paused) resume(); else audio.pause();
    }
    function show() {
      el.classList.add("is-on");
      document.body.style.setProperty("--player-h", (el.offsetHeight + 28) + "px");
    }
    function hide() {
      audio.pause();
      savePos(true);
      cur = null;
      el.classList.remove("is-on");
      document.body.style.setProperty("--player-h", "0px");
      syncState();
    }
    function refreshMeta() {
      if (!cur) return;
      var ep = EPS[cur.i];
      $("[data-pl-title]").textContent = "No." + ep.no + " " + label(ep);
      $("[data-pl-lang]").textContent = cur.l;
      var bk = $("[data-pl-open]");
      bk.style.setProperty("--c1", ep.cloth[0]);
      bk.style.setProperty("--c2", ep.cloth[1]);
      $("[data-pl-rate]").textContent = rate + "×";
      mediaSession();
    }
    function buildBars() {
      if (!cur) return;
      var rnd = seeded(EPS[cur.i].date + cur.l);
      bars = [];
      var v = 0.5;
      for (var k = 0; k < 220; k++) {
        v = clamp(v + (rnd() - 0.5) * 0.5, 0.12, 1);
        var syll = 0.55 + 0.45 * Math.abs(Math.sin(k * 0.7 + rnd() * 2));
        bars.push(clamp(v * syll, 0.08, 1));
      }
      drawWave();
    }
    function drawWave() {
      if (!wave || !cur) return;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var w = wave.clientWidth, h = wave.clientHeight;
      if (!w) return;
      if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
      var ctx = wave.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var step = 3, n = Math.floor(w / step);
      var dur = audio.duration || EPS[cur.i].audio[cur.l].dur || 1;
      var prog = clamp(audio.currentTime / dur, 0, 1);
      var live = !audio.paused && analyser;
      if (live) analyser.getByteFrequencyData(freq);
      for (var k = 0; k < n; k++) {
        var b = bars[Math.floor((k / n) * bars.length)] || 0.2;
        var x = k * step;
        var frac = k / n;
        var bh = Math.max(2, b * (h - 4));
        if (live && Math.abs(frac - prog) < 0.04) {
          var f = freq[Math.floor(Math.abs(frac - prog) / 0.04 * 40)] / 255;
          bh = Math.max(bh, f * (h - 2));
        }
        var played = frac <= prog;
        var hov = hoverX >= 0 && x <= hoverX && !played;
        ctx.fillStyle = played ? "#e3c583" : hov ? "rgba(243,234,216,.45)" : "rgba(243,234,216,.18)";
        ctx.fillRect(x, (h - bh) / 2, 2, bh);
      }
      wave.setAttribute("aria-valuenow", String(Math.round(prog * 100)));
    }
    function seekFromEvent(e) {
      var r = wave.getBoundingClientRect();
      var frac = clamp((e.clientX - r.left) / r.width, 0, 1);
      var dur = audio.duration || (cur && EPS[cur.i].audio[cur.l].dur) || 0;
      if (dur) audio.currentTime = frac * dur;
      drawWave();
    }
    if (wave) {
      var dragging = false;
      wave.addEventListener("pointerdown", function (e) { if (!cur) return; dragging = true; wave.setPointerCapture(e.pointerId); seekFromEvent(e); });
      wave.addEventListener("pointermove", function (e) {
        var r = wave.getBoundingClientRect();
        hoverX = e.clientX - r.left;
        if (dragging) seekFromEvent(e); else drawWave();
      });
      wave.addEventListener("pointerup", function () { dragging = false; });
      wave.addEventListener("pointerleave", function () { hoverX = -1; drawWave(); });
      wave.addEventListener("keydown", function (e) {
        if (!cur) return;
        if (e.key === "ArrowRight") { audio.currentTime += 5; e.preventDefault(); }
        if (e.key === "ArrowLeft") { audio.currentTime -= 5; e.preventDefault(); }
      });
    }
    $("[data-pl-toggle]").addEventListener("click", toggle);
    $("[data-pl-back]").addEventListener("click", function () { audio.currentTime = Math.max(0, audio.currentTime - 15); });
    $("[data-pl-fwd]").addEventListener("click", function () { audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 30); });
    $("[data-pl-close]").addEventListener("click", hide);
    $("[data-pl-open]").addEventListener("click", function () { if (cur) room.open(cur.i, spineEl(cur.i)); });
    $("[data-pl-title]").addEventListener("click", function () { if (cur) room.open(cur.i, spineEl(cur.i)); });
    $("[data-pl-rate]").addEventListener("click", function () {
      rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
      audio.playbackRate = rate;
      store.set("rate", rate);
      this.textContent = rate + "×";
      toast("再生速度 " + rate + "×");
    });

    var raf = 0;
    function loop() {
      drawWave();
      raf = audio.paused ? 0 : requestAnimationFrame(loop);
    }
    audio.addEventListener("play", function () { syncState(); if (!raf) raf = requestAnimationFrame(loop); });
    audio.addEventListener("pause", function () { syncState(); savePos(true); });
    audio.addEventListener("timeupdate", function () {
      if (!cur) return;
      $("[data-pl-time]").textContent = clock(audio.currentTime) + " / " + clock(audio.duration || EPS[cur.i].audio[cur.l].dur);
      hero.progress();
      savePos(false);
      if (audio.paused) drawWave();
      if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && audio.duration) {
        try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch (e) { /* unsupported */ }
      }
    });
    audio.addEventListener("ended", function () {
      if (cur) store.del(key(cur));
      syncState();
      toast("おしまい。また明日の巻で。");
    });
    audio.addEventListener("error", function () { if (cur) toast("音声を読み込めませんでした"); });
    window.addEventListener("resize", drawWave);
    window.addEventListener("pagehide", function () { savePos(true); });

    function syncState() {
      var playing = cur && !audio.paused;
      var t = $("[data-pl-toggle]");
      t.innerHTML = playing ? ICON.pause : ICON.play;
      t.setAttribute("aria-label", playing ? "一時停止" : "再生");
      $$(".spine.is-playing").forEach(function (s) { s.classList.remove("is-playing"); });
      if (playing) { var sp = spineEl(cur.i); if (sp) sp.classList.add("is-playing"); }
      document.title = (playing ? "▶ " + label(EPS[cur.i]) + " — " : "") + baseTitle;
      hero.sync();
      room.sync();
    }

    var artCache = {};
    function artwork(ep) {
      if (artCache[ep.date]) return artCache[ep.date];
      try {
        var c = document.createElement("canvas");
        c.width = c.height = 512;
        var x = c.getContext("2d");
        var g = x.createLinearGradient(0, 0, 512, 512);
        g.addColorStop(0, ep.cloth[0]); g.addColorStop(1, ep.cloth[1]);
        x.fillStyle = g; x.fillRect(0, 0, 512, 512);
        x.strokeStyle = "rgba(246,230,189,.45)"; x.lineWidth = 2; x.strokeRect(28, 28, 456, 456);
        x.fillStyle = "#e3c583"; x.fillRect(28, 92, 456, 6);
        x.font = "500 26px serif"; x.fillText("No." + ep.no + "  ·  " + ep.date, 56, 74);
        x.font = "500 54px serif"; x.fillStyle = "#f6e6bd";
        wrapText(x, label(ep), 56, 200, 400, 66);
        x.font = "italic 24px serif"; x.fillStyle = "rgba(246,230,189,.7)"; x.fillText("Phantomresearch Daily", 56, 452);
        artCache[ep.date] = c.toDataURL("image/png");
      } catch (e) { artCache[ep.date] = ""; }
      return artCache[ep.date];
    }
    function wrapText(x, text, px, py, maxW, lh) {
      var line = "", chars = text.indexOf(" ") > 0 ? text.split(/(\s+)/) : text.split("");
      for (var k = 0; k < chars.length; k++) {
        var test = line + chars[k];
        if (x.measureText(test).width > maxW && line) { x.fillText(line.trim(), px, py); line = chars[k]; py += lh; }
        else line = test;
      }
      x.fillText(line.trim(), px, py);
    }
    function mediaSession() {
      if (!cur || !("mediaSession" in navigator) || !window.MediaMetadata) return;
      var ep = EPS[cur.i];
      var art = artwork(ep);
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: label(ep, cur.l),
          artist: "Phantomresearch Daily · " + (D.labels[cur.l] || cur.l),
          album: "No." + ep.no + " · " + ep.date,
          artwork: art ? [{ src: art, sizes: "512x512", type: "image/png" }] : []
        });
        var ms = navigator.mediaSession;
        ms.setActionHandler("play", resume);
        ms.setActionHandler("pause", function () { audio.pause(); });
        ms.setActionHandler("seekbackward", function () { audio.currentTime = Math.max(0, audio.currentTime - 15); });
        ms.setActionHandler("seekforward", function () { audio.currentTime += 30; });
        ms.setActionHandler("seekto", function (d) { if (d.seekTime != null) audio.currentTime = d.seekTime; });
        ms.setActionHandler("previoustrack", cur.i > 0 ? function () { play(cur.i - 1, cur.l); } : null);
        ms.setActionHandler("nexttrack", cur.i < EPS.length - 1 ? function () { play(cur.i + 1, cur.l); } : null);
      } catch (e) { /* partial support */ }
    }

    return {
      play: play, toggle: toggle, refreshMeta: refreshMeta,
      current: function () { return cur; },
      isPlaying: function (i, l) { return !!cur && cur.i === i && (l == null || cur.l === l) && !audio.paused; },
      seekBy: function (s) { if (cur) audio.currentTime = clamp(audio.currentTime + s, 0, audio.duration || 1e9); },
      saved: function (i, l) { return store.get("pos:" + EPS[i].date + ":" + l, 0); }
    };
  })();
  var baseTitle = document.title;

  function spineEl(i) { return EPS[i] ? $('.spine[data-i="' + EPS[i].no + '"]') : null; }

  /* ---------------- hero: sound field ---------------- */
  var hero = (function () {
    var section = $("#today");
    var btn = $("[data-hero-play]");
    var titleEl = $("[data-hero-title]");
    var altEl = $("[data-hero-alt]");
    var resumeEl = $("[data-hero-resume]");
    var altTimer = null, altIndex = 0;

    function refresh() {
      if (!EPS.length) return;
      var ep = EPS[0];
      if (titleEl) titleEl.textContent = label(ep);
      var l = voiceFor(ep);
      var saved = l ? player.saved(0, l) : 0;
      if (resumeEl) {
        resumeEl.hidden = !(saved > 8);
        resumeEl.textContent = saved > 8 ? "続きから " + clock(saved) + "（" + l.toUpperCase() + "）" : "";
      }
      startAlt();
    }
    function startAlt() {
      if (!altEl || !EPS.length) return;
      var ep = EPS[0];
      var others = LANGS.filter(function (x) { return x !== lang; }).map(function (x) { return ep.labels[x]; }).filter(Boolean);
      var span = $("span", altEl);
      clearInterval(altTimer);
      altIndex = 0;
      if (!others.length || !span) return;
      span.textContent = others[0];
      if (reduce) return;
      altTimer = setInterval(function () {
        span.classList.add("out");
        setTimeout(function () {
          altIndex = (altIndex + 1) % others.length;
          span.textContent = others[altIndex];
          span.classList.remove("out");
        }, 600);
      }, 3400);
    }
    function play() { if (EPS.length) player.play(0, lang); }
    function sync() {
      if (!btn) return;
      var on = player.isPlaying(0);
      $("[data-ico]", btn).innerHTML = on ? ICON.pause : ICON.play;
      btn.setAttribute("aria-label", on ? "一時停止" : "今日の回を再生");
      if (!on) refreshResumeOnly();
    }
    function refreshResumeOnly() {
      var c = player.current();
      if (!resumeEl || !c || c.i !== 0) return;
      var s = player.saved(0, c.l);
      resumeEl.hidden = !(s > 8);
      resumeEl.textContent = s > 8 ? "続きから " + clock(s) + "（" + c.l.toUpperCase() + "）" : "";
    }
    function progress() {
      var c = player.current();
      if (!btn) return;
      var p = c && c.i === 0 && audio.duration ? audio.currentTime / audio.duration : 0;
      btn.style.setProperty("--p", p.toFixed(4));
    }
    if (btn) btn.addEventListener("click", function () {
      var c = player.current();
      if (c && c.i === 0) player.toggle(); else play();
    });

    /* ridgeline field: rows of gold lines that breathe, bend under the
       pointer, ripple on tap and dance to the playing audio */
    var cv = section && $(".hero-canvas", section);
    if (cv && cv.getContext) {
      var ctx = cv.getContext("2d");
      var W = 0, H = 0, dpr = 1, rows = 30;
      var m = { x: -9999, y: -9999, tx: -9999, ty: -9999, s: 0, ts: 0 };
      var ripples = [];
      var visible = true, rafId = 0, energy = 0;
      var resize = function () {
        dpr = Math.min(2, window.devicePixelRatio || 1);
        W = cv.clientWidth; H = cv.clientHeight;
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        rows = W < 700 ? 22 : 32;
        if (reduce) frame(0);
      };
      var frame = function (t) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        m.x += (m.tx - m.x) * 0.12; m.y += (m.ty - m.y) * 0.12; m.s += (m.ts - m.s) * 0.06;
        var bins = null, level = 0;
        if (analyser && !audio.paused) {
          analyser.getByteFrequencyData(freq);
          bins = freq;
          for (var b = 0; b < 48; b++) level += freq[b];
          level /= 48 * 255;
        }
        energy += (level - energy) * 0.12;
        var top = H * 0.26, bottom = H * 1.02, gap = (bottom - top) / rows;
        var step = W < 700 ? 9 : 7;
        var R = Math.max(90, W * 0.09);
        var now = t * 0.001;
        ripples = ripples.filter(function (r) { return now - r.t < 2.6; });
        for (var r = 0; r < rows; r++) {
          var depth = r / (rows - 1);
          var y0 = top + r * gap;
          var pts = [];
          for (var x = -step; x <= W + step; x += step) {
            var nx = x / W;
            var c = nx - 0.5;
            var env = Math.exp(-(c * c) / 0.035) * 0.85 + Math.exp(-(c * c) / 0.2) * 0.25;
            var n = Math.sin(nx * 8.3 + now * 0.55 + r * 0.71) * 0.5 +
                    Math.sin(nx * 21.7 - now * 0.9 + r * 1.37) * 0.28 +
                    Math.sin(nx * 47.1 + now * 1.6 + r * 0.43) * 0.14;
            n = (n + 0.92) / 1.84;
            var a = 0;
            if (bins) {
              var bi = Math.floor(Math.abs(c) * 2 * 70);
              a = (bins[bi] || 0) / 255 * (0.55 + 0.45 * Math.sin(r * 1.9 + now * 2.2));
            }
            var amp = (gap * 1.2 + H * 0.05) * env * (n * (0.62 + energy * 0.8) + a * 1.6);
            var dx = x - m.x, dy = (y0 - m.y) * 1.6;
            var bump = Math.exp(-(dx * dx + dy * dy) / (2 * R * R)) * gap * 3.4 * m.s;
            var rip = 0;
            for (var k = 0; k < ripples.length; k++) {
              var rp = ripples[k], age = now - rp.t;
              var dist = Math.sqrt((x - rp.x) * (x - rp.x) + (y0 - rp.y) * (y0 - rp.y) * 2.2);
              var front = age * 520;
              var d = dist - front;
              if (d > -140 && d < 140) rip += Math.cos(d / 22) * Math.exp(-(d * d) / 5000) * Math.exp(-age * 1.4) * gap * 1.6;
            }
            pts.push(x, y0 - amp - bump - rip);
          }
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          for (var p = 2; p < pts.length; p += 2) ctx.lineTo(pts[p], pts[p + 1]);
          ctx.lineTo(W + step, H); ctx.lineTo(-step, H); ctx.closePath();
          ctx.fillStyle = "#0c0a08";
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          for (var q = 2; q < pts.length; q += 2) ctx.lineTo(pts[q], pts[q + 1]);
          var alpha = 0.10 + depth * 0.55 + energy * 0.25;
          ctx.strokeStyle = "rgba(227,197,131," + Math.min(0.9, alpha).toFixed(3) + ")";
          ctx.lineWidth = 0.8 + depth * 0.7;
          ctx.stroke();
        }
      };
      var tick = function (t) {
        frame(t);
        rafId = visible ? requestAnimationFrame(tick) : 0;
      };
      var setPointer = function (x, y) {
        var r = cv.getBoundingClientRect();
        m.tx = x - r.left; m.ty = y - r.top; m.ts = 1;
        if (m.x < -999) { m.x = m.tx; m.y = m.ty; }
      };
      section.addEventListener("pointermove", function (e) { setPointer(e.clientX, e.clientY); });
      section.addEventListener("pointerleave", function () { m.ts = 0; });
      section.addEventListener("touchmove", function (e) { var t0 = e.touches[0]; if (t0) setPointer(t0.clientX, t0.clientY); }, { passive: true });
      section.addEventListener("touchend", function () { m.ts = 0; }, { passive: true });
      section.addEventListener("pointerdown", function (e) {
        if (e.target.closest("button,a")) return;
        var r = cv.getBoundingClientRect();
        ripples.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() * 0.001 });
        if (ripples.length > 5) ripples.shift();
      });
      window.addEventListener("resize", resize);
      resize();
      if (reduce) frame(0);
      else if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (en) {
          visible = en[0].isIntersecting;
          if (visible && !rafId) rafId = requestAnimationFrame(tick);
        }).observe(section);
      } else rafId = requestAnimationFrame(tick);
    }

    return { refresh: refresh, play: play, sync: sync, progress: progress };
  })();

  /* ---------------- statement: words light up on scroll ---------------- */
  (function () {
    var p = $("[data-statement]");
    if (!p) return;
    var words = $$(".w", p);
    var sec = p.closest(".statement");
    var ticking = false;
    function update() {
      ticking = false;
      var r = sec.getBoundingClientRect();
      var total = r.height - window.innerHeight;
      var prog = clamp(-r.top / (total || 1), 0, 1);
      var lit = Math.round(prog * 1.25 * words.length);
      words.forEach(function (w, k) { w.classList.toggle("on", k < lit); });
    }
    window.addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  })();

  /* ---------------- nav, reveal, counters, magnetic ---------------- */
  (function () {
    var navEl = $("[data-nav]");
    var onScroll = function () { navEl && navEl.classList.toggle("is-scrolled", window.scrollY > 12); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    var reveal = $$("[data-reveal]");
    var counters = $$("[data-count]");
    function count(el) {
      var target = Number(el.getAttribute("data-count")), dec = Number(el.getAttribute("data-dec")) || 0;
      if (reduce) { el.textContent = target.toFixed(dec); return; }
      var t0 = performance.now(), dur = 1800;
      (function step(t) {
        var k = clamp((t - t0) / dur, 0, 1);
        var e = k === 1 ? 1 : 1 - Math.pow(2, -10 * k);
        el.textContent = (target * e).toFixed(dec);
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    }
    if (!("IntersectionObserver" in window)) {
      reveal.forEach(function (el) { el.classList.add("is-in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add("is-in");
        $$("[data-count]", en.target).forEach(count);
        io.unobserve(en.target);
      });
    }, { rootMargin: "0px 0px -12% 0px" });
    reveal.forEach(function (el) { io.observe(el); });
    counters.forEach(function (el) { if (!el.closest("[data-reveal]")) count(el); });

    if (finePointer && !reduce) {
      $$(".play-xl,[data-magnetic]").forEach(function (el) {
        var zone = el.parentElement;
        zone.addEventListener("pointermove", function (e) {
          var r = el.getBoundingClientRect();
          var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < 140) el.style.transform = "translate(" + dx * 0.22 + "px," + dy * 0.22 + "px)";
          else el.style.transform = "";
        });
        zone.addEventListener("pointerleave", function () { el.style.transform = ""; });
      });
    }
  })();

  /* ---------------- shelf ---------------- */
  (function () {
    var shelf = $("[data-shelf]");
    if (!shelf) return;
    var thumb = $("[data-shelf-thumb]");
    var prev = $("[data-shelf-prev]"), next = $("[data-shelf-next]");
    function updateThumb() {
      var max = shelf.scrollWidth - shelf.clientWidth;
      var ratio = shelf.clientWidth / shelf.scrollWidth;
      var prog = max > 0 ? shelf.scrollLeft / max : 0;
      if (thumb) {
        thumb.style.width = (ratio * 100).toFixed(1) + "%";
        thumb.style.transform = "translateX(" + (prog * (1 - ratio) / ratio * 100).toFixed(1) + "%)";
      }
      if (prev) prev.disabled = shelf.scrollLeft < 4;
      if (next) next.disabled = shelf.scrollLeft > max - 4;
    }
    shelf.addEventListener("scroll", updateThumb, { passive: true });
    window.addEventListener("resize", updateThumb);
    updateThumb();
    function page(dir) { shelf.scrollBy({ left: dir * shelf.clientWidth * 0.7, behavior: reduce ? "auto" : "smooth" }); }
    if (prev) prev.addEventListener("click", function () { page(-1); });
    if (next) next.addEventListener("click", function () { page(1); });

    // mouse drag with momentum (touch already scrolls natively)
    var down = false, moved = false, sx = 0, sl = 0, lx = 0, lt = 0, vel = 0, mom = 0;
    shelf.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      down = true; moved = false; sx = lx = e.clientX; sl = shelf.scrollLeft; lt = performance.now(); vel = 0;
      cancelAnimationFrame(mom);
    });
    window.addEventListener("pointermove", function (e) {
      if (!down) return;
      var dx = e.clientX - sx;
      if (!moved && Math.abs(dx) > 5) { moved = true; shelf.classList.add("is-dragging"); }
      if (!moved) return;
      shelf.scrollLeft = sl - dx;
      var now = performance.now();
      vel = (e.clientX - lx) / Math.max(1, now - lt);
      lx = e.clientX; lt = now;
    });
    window.addEventListener("pointerup", function () {
      if (!down) return;
      down = false;
      if (!moved) return;
      setTimeout(function () { shelf.classList.remove("is-dragging"); }, 0);
      var v = -vel * 16;
      (function glide() {
        if (Math.abs(v) < 0.4 || reduce) return;
        shelf.scrollLeft += v; v *= 0.94;
        mom = requestAnimationFrame(glide);
      })();
    });
    shelf.addEventListener("click", function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);

    $$(".spine", shelf).forEach(function (sp) {
      var i = byNo(sp.getAttribute("data-i"));
      sp.addEventListener("pointermove", function (e) {
        var r = sp.getBoundingClientRect();
        sp.style.setProperty("--mx", ((e.clientX - r.left) / r.width).toFixed(3));
      });
      sp.addEventListener("pointerenter", function () {
        var a = sp.previousElementSibling, b = sp.nextElementSibling;
        if (a && a.classList.contains("spine")) a.style.setProperty("--lean", "-1.6deg");
        if (b && b.classList.contains("spine")) b.style.setProperty("--lean", "1.6deg");
      });
      sp.addEventListener("pointerleave", function () {
        var a = sp.previousElementSibling, b = sp.nextElementSibling;
        if (a && a.style) a.style.removeProperty("--lean");
        if (b && b.style) b.style.removeProperty("--lean");
      });
      sp.addEventListener("click", function (e) { e.preventDefault(); room.open(i, sp); });
    });
    $$("[data-open-book]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); var i = byNo(a.getAttribute("data-open-book")); room.open(i, spineEl(i)); });
    });
  })();

  /* ---------------- reading room ---------------- */
  var room = (function () {
    var el = $("#room");
    var book = $("[data-book]", el);
    var state = { index: null, lang: null, from: null, pushed: false, lastFocus: null, transcript: false };

    function voicesHtml(ep, i) {
      return LANGS.filter(function (l) { return ep.audio[l]; }).map(function (l) {
        var a = ep.audio[l];
        var on = player.isPlaying(i, l);
        var cur = player.current();
        var isCur = cur && cur.i === i && cur.l === l;
        return '<button type="button" class="voice' + (isCur ? " is-current" : "") + '" data-voice="' + l + '" aria-label="' + esc(D.labels[l] + "で再生") + '">' +
          '<span class="pb">' + (on ? ICON.pause : ICON.play) + "</span>" +
          '<span><span class="vn">' + esc(D.labels[l] || l) + '</span><span class="vd">' + clock(a.dur) + " · " + mb(a.bytes) + "</span></span></button>";
      }).join("");
    }
    function render(i, opts) {
      opts = opts || {};
      var ep = EPS[i];
      if (!ep) return;
      state.index = i;
      if (!opts.keep || !ep.audio[state.lang]) state.lang = voiceFor(ep);
      if (!opts.keep) state.transcript = false;
      var a = state.lang ? ep.audio[state.lang] : null;
      book.style.setProperty("--c1", ep.cloth[0]);
      book.style.setProperty("--c2", ep.cloth[1]);
      var langs = D.allLanguages.map(function (l) {
        return "<li><b>" + esc(l) + "</b><span>" + esc(ep.labels[l] || "") + "</span></li>";
      }).join("");
      var papers = ep.papers.map(function (p, k) {
        var authors = p.authors.slice(0, 4).join(", ") + (p.authors.length > 4 ? " ほか" + (p.authors.length - 4) + "名" : "");
        return '<li class="paper" data-paper="' + esc(p.id) + '"><h4>' + (p.url ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.title) + "</a>" : esc(p.title)) + "</h4>" +
          '<div class="pm">' + (p.id ? "arXiv:" + esc(p.id) : "") + (p.cat ? ' · <span class="cat">' + esc(p.cat) + "</span>" : "") + (p.published ? " · " + esc(p.published) : "") + "</div>" +
          (authors ? '<div class="pa">' + esc(authors) + "</div>" : "") +
          (p.ex ? '<details data-ex="' + k + '"><summary>抄録を読む</summary><p class="ex">' + esc(excerptFor(ep.date, k) || "読み込み中…") + "</p></details>" : "") + "</li>";
      }).join("");
      var newer = EPS[i - 1], older = EPS[i + 1];
      book.innerHTML =
        '<div class="book-cover">' +
          '<div><div class="cover-no">No.' + ep.no + " · " + esc(ep.date.replace(/-/g, ".")) + " " + esc(ep.day) + "</div></div>" +
          '<div><h2 class="cover-title" id="room-title">' + esc(label(ep)) + '</h2><ul class="cover-langs">' + langs + "</ul></div>" +
          '<div class="cover-foot"><span>' + ep.papers.length + " papers<br>" + Object.keys(ep.audio).length + " voices</span>" + ICON.orn + "</div>" +
        "</div>" +
        '<div class="book-page">' +
          '<button type="button" class="page-close" data-close aria-label="閉じる">' + ICON.close + "</button>" +
          '<p class="page-eyebrow">Listen · ' + Object.keys(ep.audio).length + "つの声</p>" +
          '<h3 class="page-h">どの声で聴きますか</h3>' +
          '<div class="voices">' + voicesHtml(ep, i) + "</div>" +
          (a ? '<div class="voice-tools"><a href="' + esc(a.path) + '" download="' + esc(a.file) + '">MP3を保存（' + esc(state.lang.toUpperCase()) + "）</a>" +
            (a.script ? '<button type="button" data-transcript>' + (state.transcript ? "台本を閉じる" : "台本を読む") + "（" + esc(state.lang.toUpperCase()) + "）</button>" : "") +
            '<button type="button" data-share>この巻のリンクをコピー</button></div>' : "") +
          '<div class="transcript" data-transcript-box hidden></div>' +
          '<hr class="page-rule">' +
          '<p class="page-eyebrow">Bibliography · 収録論文 ' + ep.papers.length + "</p>" +
          '<h3 class="page-h">この巻に収められた論文</h3>' +
          '<ol class="papers-list">' + papers + "</ol>" +
          (ep.notes && ep.notes.length ? '<div class="page-notes">Colophon — ' + ep.notes.map(esc).join("<br>") + "</div>" : "") +
          '<div class="page-nav">' +
            '<button type="button" data-goto="' + (i - 1) + '"' + (newer ? "" : " disabled") + "><small>← 次の巻</small><span>" + (newer ? "No." + newer.no + " " + esc(label(newer)) : "—") + "</span></button>" +
            '<button type="button" data-goto="' + (i + 1) + '"' + (older ? "" : " disabled") + "><small>前の巻 →</small><span>" + (older ? "No." + older.no + " " + esc(label(older)) : "—") + "</span></button>" +
          "</div>" +
        "</div>";
      el.setAttribute("aria-labelledby", "room-title");
      if (state.transcript) loadTranscript();
      if (opts.highlight) {
        var target = $('[data-paper="' + (window.CSS && CSS.escape ? CSS.escape(opts.highlight) : opts.highlight) + '"]', book);
        if (target) {
          target.classList.add("is-hl");
          var det = $("details", target); if (det) det.open = true;
          setTimeout(function () { target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }); }, reduce ? 0 : 520);
        }
      }
    }
    // Abstracts live in episodes.json; fetched once, on the first open.
    book.addEventListener("toggle", function (e) {
      var d = e.target;
      if (!d.open || !d.hasAttribute || !d.hasAttribute("data-ex")) return;
      var date = EPS[state.index].date, k = Number(d.getAttribute("data-ex"));
      var p = $(".ex", d);
      if (excerptFor(date, k)) { p.textContent = excerptFor(date, k); return; }
      loadExcerpts().then(function () {
        p.textContent = excerptFor(date, k) || "抄録を読み込めませんでした。";
      });
    }, true);
    function loadTranscript() {
      var ep = EPS[state.index], a = ep && ep.audio[state.lang];
      var box = $("[data-transcript-box]", book);
      if (!box || !a || !a.script) return;
      box.hidden = false;
      box.textContent = "読み込み中…";
      fetch(a.script).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function (t) { box.textContent = t.trim(); })
        .catch(function () { box.innerHTML = '台本を読み込めませんでした。<a href="' + esc(a.script) + '">直接ひらく</a>'; });
    }
    book.addEventListener("click", function (e) {
      var v = e.target.closest("[data-voice]");
      if (v) {
        state.lang = v.getAttribute("data-voice");
        player.play(state.index, state.lang);
        render(state.index, { keep: true });
        var again = $('[data-voice="' + state.lang + '"]', book); if (again) again.focus({ preventScroll: true });
        return;
      }
      if (e.target.closest("[data-transcript]")) {
        state.transcript = !state.transcript;
        render(state.index, { keep: true });
        var tb = $("[data-transcript]", book); if (tb) tb.focus({ preventScroll: true });
        return;
      }
      if (e.target.closest("[data-share]")) {
        copy(location.href.split("#")[0] + "#book/" + EPS[state.index].date, "リンクをコピーしました");
        return;
      }
      var g = e.target.closest("[data-goto]");
      if (g && !g.disabled) {
        var to = Number(g.getAttribute("data-goto"));
        var pageEl = $(".book-page", book);
        if (!reduce && book.animate) {
          book.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(" + (to > state.index ? -24 : 24) + "px)" }], { duration: 220, easing: "ease-in" }).onfinish = function () {
            render(to);
            book.animate([{ opacity: 0, transform: "translateX(" + (to > state.index ? 24 : -24) + "px)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: "cubic-bezier(.22,1,.36,1)" });
          };
        } else render(to);
        if (pageEl) pageEl.scrollTop = 0;
        state.from = spineEl(to);
        replaceHash(to);
        return;
      }
      if (e.target.closest("[data-close]")) close();
    });
    el.addEventListener("click", function (e) { if (e.target.classList.contains("room-scrim")) close(); });

    function replaceHash(i) {
      try { history.replaceState({ room: true }, "", "#book/" + EPS[i].date); } catch (e) { /* sandboxed */ }
    }
    function open(i, from, opts) {
      opts = opts || {};
      if (!EPS[i]) return;
      var wasOpen = state.index != null && el.classList.contains("is-open");
      state.from = from || spineEl(i);
      state.lastFocus = wasOpen ? state.lastFocus : document.activeElement;
      render(i, opts);
      if (!wasOpen) {
        el.hidden = false;
        el.classList.add("is-open");
        root.style.overflow = "hidden";
        try {
          if (!opts.fromHash) { history.pushState({ room: true }, "", "#book/" + EPS[i].date); state.pushed = true; }
        } catch (e) { state.pushed = false; }
        requestAnimationFrame(function () {
          el.classList.add("is-in");
          animateIn();
          var c = $(".page-close", book); if (c) c.focus({ preventScroll: true });
        });
      } else replaceHash(i);
    }
    function flipFrom() {
      var f = state.from;
      if (!f || !f.getBoundingClientRect) return null;
      var r = f.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > window.innerHeight) return null;
      var b = book.getBoundingClientRect();
      return "translate(" + (r.left + r.width / 2 - (b.left + b.width / 2)) + "px," + (r.top + r.height / 2 - (b.top + b.height / 2)) + "px) scale(" + (r.width / b.width).toFixed(4) + "," + (r.height / b.height).toFixed(4) + ")";
    }
    function animateIn() {
      if (reduce || !book.animate) return;
      var from = flipFrom();
      book.animate(from
        ? [{ transform: from, opacity: 0.9, borderRadius: "3px" }, { transform: "none", opacity: 1, borderRadius: "6px" }]
        : [{ transform: "translateY(40px) scale(.97)", opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: from ? 760 : 560, easing: "cubic-bezier(.22,1,.36,1)" });
      $$(".book-cover > *, .book-page > *", book).forEach(function (n, k) {
        n.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 600, delay: 260 + Math.min(k, 8) * 45, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" });
      });
    }
    function close(fromPop) {
      if (state.index == null) return;
      if (!fromPop && state.pushed) { state.pushed = false; history.back(); return; }
      if (!fromPop) { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* sandboxed */ } }
      var finish = function () {
        el.classList.remove("is-open", "is-in");
        el.hidden = true;
        root.style.overflow = "";
        state.index = null;
        state.pushed = false;
        if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus({ preventScroll: true });
      };
      el.classList.remove("is-in");
      if (reduce || !book.animate) { finish(); return; }
      var to = flipFrom();
      book.animate(to
        ? [{ transform: "none", opacity: 1 }, { transform: to, opacity: 0.4 }]
        : [{ transform: "none", opacity: 1 }, { transform: "translateY(30px) scale(.98)", opacity: 0 }],
        { duration: to ? 520 : 320, easing: "cubic-bezier(.65,0,.35,1)" }).onfinish = finish;
    }
    window.addEventListener("popstate", function () {
      var m = /^#book\/(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
      if (m) { var i = indexOfDate(m[1]); if (i >= 0) { open(i, null, { fromHash: true }); return; } }
      if (state.index != null) close(true);
    });
    document.addEventListener("keydown", function (e) {
      if (state.index == null) return;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "Tab" && !el.contains(document.activeElement)) {
        var c0 = $(".page-close", book); if (c0) { e.preventDefault(); c0.focus(); }
        return;
      }
      if (e.key === "Tab") {
        var f = $$('button:not([disabled]),a[href],summary,[tabindex="0"]', book).filter(function (n) { return n.offsetParent !== null; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    function sync() {
      if (state.index == null) return;
      var v = $(".voices", book);
      if (v) v.innerHTML = voicesHtml(EPS[state.index], state.index);
    }
    return {
      open: open, close: close, sync: sync,
      render: render,
      get index() { return state.index; }
    };
  })();

  var EXCERPTS = null, exPromise = null;
  function excerptFor(date, k) { return EXCERPTS && EXCERPTS[date] ? EXCERPTS[date][k] : ""; }
  function loadExcerpts() {
    if (exPromise) return exPromise;
    exPromise = fetch("episodes.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) {
        EXCERPTS = {};
        (j.episodes || []).forEach(function (e) {
          EXCERPTS[e.date] = (e.papers || []).map(function (p) { return String((p && p.excerpt) || "").trim(); });
        });
      })
      .catch(function () { exPromise = null; });
    return exPromise;
  }
  function indexOfDate(date) {
    for (var i = 0; i < EPS.length; i++) if (EPS[i].date === date) return i;
    return -1;
  }
  function copy(text, msg) {
    var done = function () { toast(msg); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast(text); }
      ta.remove();
    }
  }
  $$("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      copy(new URL(b.getAttribute("data-copy"), location.href).href, "RSS の URL をコピーしました");
    });
  });

  /* ---------------- catalog ---------------- */
  var catalog = (function () {
    var cards = $("[data-cards]");
    var input = $("[data-search]");
    var chipsEl = $("[data-chips]");
    var countEl = $("[data-count-label]");
    var moreBtn = $("[data-more]");
    if (!cards) return { render: function () {} };
    var all = [];
    EPS.forEach(function (ep, i) {
      ep.papers.forEach(function (p, k) {
        all.push({ i: i, p: p, r: (seeded(p.id + ep.date)() - 0.5) * 1.4, hay: (p.title + " " + p.authors.join(" ") + " " + p.id + " " + p.cat + " " + Object.keys(ep.labels).map(function (l) { return ep.labels[l]; }).join(" ")).toLowerCase() });
      });
    });
    var cats = {};
    all.forEach(function (c) { if (c.p.cat) cats[c.p.cat] = (cats[c.p.cat] || 0) + 1; });
    var top = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a] || (a < b ? -1 : 1); }).slice(0, 9);
    var cat = null, q = "", limit = 12;
    chipsEl.innerHTML = '<button type="button" class="chip is-on" data-cat="">すべて<span class="n">' + all.length + "</span></button>" +
      top.map(function (c) { return '<button type="button" class="chip" data-cat="' + esc(c) + '">' + esc(c) + '<span class="n">' + cats[c] + "</span></button>"; }).join("");
    chipsEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cat]");
      if (!b) return;
      cat = b.getAttribute("data-cat") || null;
      $$(".chip", chipsEl).forEach(function (c) { c.classList.toggle("is-on", c === b); });
      limit = 12; render();
    });
    var deb;
    input.addEventListener("input", function () {
      clearTimeout(deb);
      deb = setTimeout(function () { q = input.value.trim().toLowerCase(); limit = 12; render(); }, 120);
    });
    moreBtn.addEventListener("click", function () { limit += 12; render(); });
    function mark(text, terms) {
      var out = esc(text);
      terms.forEach(function (t) {
        if (t.length < 2) return;
        var re = new RegExp("(" + esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
        out = out.replace(re, "<mark>$1</mark>");
      });
      return out;
    }
    function render() {
      var terms = q ? q.split(/\s+/) : [];
      var hits = all.filter(function (c) {
        if (cat && c.p.cat !== cat) return false;
        for (var k = 0; k < terms.length; k++) if (c.hay.indexOf(terms[k]) < 0) return false;
        return true;
      });
      countEl.textContent = (q || cat ? "「" + [cat, q].filter(Boolean).join(" · ") + "」 " : "") + hits.length + " 枚のカード";
      if (!hits.length) {
        cards.innerHTML = '<p class="empty-cat">該当するカードは見つかりませんでした。別のことばで探してみてください。</p>';
        moreBtn.hidden = true;
        return;
      }
      cards.innerHTML = hits.slice(0, limit).map(function (c) {
        var ep = EPS[c.i], p = c.p;
        var authors = p.authors.slice(0, 3).join(", ") + (p.authors.length > 3 ? " ほか" : "");
        return '<button type="button" class="card" style="--r:' + c.r.toFixed(2) + 'deg" data-card="' + c.i + '" data-pid="' + esc(p.id) + '">' +
          '<span class="card-top"><span>' + (p.id ? "arXiv " + esc(p.id) : "") + '</span><span class="cat">' + esc(p.cat) + "</span></span>" +
          '<span class="card-title">' + mark(p.title, terms) + "</span>" +
          '<span class="card-authors">' + mark(authors, terms) + "</span>" +
          '<span class="card-ep"><i style="--c:' + ep.cloth[0] + '"></i>No.' + ep.no + " " + mark(label(ep), terms) + "</span></button>";
      }).join("");
      moreBtn.hidden = hits.length <= limit;
    }
    cards.addEventListener("click", function (e) {
      var c = e.target.closest("[data-card]");
      if (!c) return;
      var i = Number(c.getAttribute("data-card"));
      room.open(i, c, { highlight: c.getAttribute("data-pid") });
    });
    render();
    return { render: render, focus: function () { input.focus(); input.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }); } };
  })();

  /* ---------------- keyboard ---------------- */
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (typing) { if (e.key === "Escape") t.blur(); return; }
    if (e.key === "Escape") return;
    if (e.key === "/") { e.preventDefault(); if (room.index != null) room.close(); catalog.focus && catalog.focus(); return; }
    var interactive = t && (t.tagName === "BUTTON" || t.tagName === "A" || t.tagName === "SUMMARY");
    if ((e.key === " " && !interactive) || e.key === "k") { e.preventDefault(); player.toggle(); return; }
    if (!player.current() || t.getAttribute("role") === "slider") return;
    if (e.key === "ArrowRight" || e.key === "l") { player.seekBy(e.key === "l" ? 30 : 15); e.preventDefault(); }
    if (e.key === "ArrowLeft" || e.key === "j") { player.seekBy(-15); e.preventDefault(); }
  });

  /* ---------------- boot ---------------- */
  setLang(lang);
  var hm = /^#book\/(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
  if (hm) {
    var hi = indexOfDate(hm[1]);
    if (hi >= 0) setTimeout(function () { room.open(hi, null, { fromHash: true }); }, 60);
  } else if (/^#ep-\d{4}-\d{2}-\d{2}$/.test(location.hash)) {
    var ei = indexOfDate(location.hash.slice(4));
    if (ei >= 0) setTimeout(function () { room.open(ei, null, { fromHash: true }); }, 60);
  }
})();
