/* Phantomresearch Daily — 音の図書館 client.
   Inlined into index.html by site.mjs. Reads the embedded #library-data JSON
   and upgrades the server-rendered page: sound-field hero, scroll-lit
   statement, a physical bookcase (springs, dominoes, dust, synthesised
   sound), reading-room dialog, card catalog, mini player and two
   assistants: しおり the cat and こむぎ the dog.
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

  /* ---------------- event bus ---------------- */
  var bus = (function () {
    var h = {};
    return {
      on: function (n, f) { (h[n] = h[n] || []).push(f); },
      emit: function (n) {
        var a = Array.prototype.slice.call(arguments, 1);
        (h[n] || []).forEach(function (f) { try { f.apply(null, a); } catch (e) { /* a listener must not break the page */ } });
      }
    };
  })();
  var gestured = false;
  ["pointerdown", "keydown", "touchstart"].forEach(function (t) {
    window.addEventListener(t, function () { gestured = true; }, { capture: true, passive: true });
  });

  /* ---------------- sound effects (synthesised: no audio files) ---------------- */
  var sfx = (function () {
    var on = store.get("sfx", true), ctx = null, master = null, last = 0;
    var btn = $("[data-sfx]");
    function sync() {
      if (!btn) return;
      btn.setAttribute("aria-pressed", String(on));
      btn.setAttribute("aria-label", on ? "効果音をオフにする" : "効果音をオンにする");
    }
    sync();
    if (btn) btn.addEventListener("click", function () {
      on = !on; store.set("sfx", on); sync();
      toast(on ? "効果音 ON — 本の手ざわりを音でも" : "効果音 OFF");
      if (on) thud(0.5);
    });
    // The AudioContext is only created after a user gesture (autoplay rules).
    function ensure() {
      if (!on || !gestured) return null;
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination); } catch (e) { ctx = null; return null; }
      }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    function noise(c, dur) {
      var n = Math.max(1, Math.floor(c.sampleRate * dur)), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
      for (var k = 0; k < n; k++) d[k] = Math.random() * 2 - 1;
      var src = c.createBufferSource(); src.buffer = b; return src;
    }
    function env(g, t, peak, a, r) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + r);
    }
    // a book settling against wood: low body thump + short woody click
    function thud(v) {
      var c = ensure(); if (!c) return;
      var now = performance.now();
      if (now - last < 28) return;
      last = now;
      v = clamp(v, 0.04, 1);
      var t = c.currentTime;
      var o = c.createOscillator(), g = c.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(120 + 90 * v + Math.random() * 30, t);
      o.frequency.exponentialRampToValueAtTime(58, t + 0.13);
      env(g, t, 0.55 * v, 0.004, 0.16);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.2);
      var n = noise(c, 0.05), f = c.createBiquadFilter(), ng = c.createGain();
      f.type = "bandpass"; f.frequency.value = 1100 + 900 * v + Math.random() * 300; f.Q.value = 1.4;
      env(ng, t, 0.3 * v, 0.002, 0.045);
      n.connect(f); f.connect(ng); ng.connect(master); n.start(t);
    }
    // cloth sliding over wood
    function slide(dur, v) {
      var c = ensure(); if (!c) return;
      var t = c.currentTime, n = noise(c, dur), f = c.createBiquadFilter(), g = c.createGain();
      f.type = "bandpass"; f.Q.value = 0.8;
      f.frequency.setValueAtTime(700, t); f.frequency.linearRampToValueAtTime(2400, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.12 * (v || 1), t + dur * 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      n.connect(f); f.connect(g); g.connect(master); n.start(t);
    }
    function purr(dur) {
      var c = ensure(); if (!c) return;
      var t = c.currentTime, n = noise(c, dur), f = c.createBiquadFilter(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
      f.type = "lowpass"; f.frequency.value = 180;
      lfo.frequency.value = 23; lg.gain.value = 0.12;
      lfo.connect(lg); lg.connect(g.gain);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16, t + 0.25); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      n.connect(f); f.connect(g); g.connect(master); n.start(t); lfo.start(t); lfo.stop(t + dur);
    }
    function bark() {
      var c = ensure(); if (!c) return;
      [0, 0.17].forEach(function (d, k) {
        var t = c.currentTime + d, o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(k ? 560 : 620, t); o.frequency.exponentialRampToValueAtTime(k ? 330 : 380, t + 0.11);
        f.type = "bandpass"; f.frequency.value = 1100; f.Q.value = 2.2;
        env(g, t, 0.16, 0.008, 0.1);
        o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + 0.14);
      });
    }
    function chime() {
      var c = ensure(); if (!c) return;
      [880, 1318.5, 1760].forEach(function (fr, k) {
        var t = c.currentTime + k * 0.09, o = c.createOscillator(), g = c.createGain();
        o.type = "sine"; o.frequency.value = fr;
        env(g, t, 0.07, 0.01, 0.9);
        o.connect(g); g.connect(master); o.start(t); o.stop(t + 1);
      });
    }
    return { thud: thud, slide: slide, purr: purr, bark: bark, chime: chime };
  })();

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
    $$(".slot[data-i]").forEach(function (sl) {
      var ep = EPS[byNo(sl.getAttribute("data-i"))];
      if (!ep) return;
      var t = label(ep);
      $(".spine-title", sl).textContent = t;
      var cv = $(".cv-title", sl); if (cv) cv.textContent = t;
      var cs = sl.style;
      cs.setProperty("--fs", String(spineFont(t, Number(cs.getPropertyValue("--h")) || 260, Number(cs.getPropertyValue("--w")) || 52)));
      sl.setAttribute("aria-label", "No." + ep.no + " " + ep.date + " " + t);
    });
    bus.emit("lang", l);
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
      bus.emit("ended", cur);
    });
    audio.addEventListener("error", function () { if (cur) toast("音声を読み込めませんでした"); });
    window.addEventListener("resize", drawWave);
    window.addEventListener("pagehide", function () { savePos(true); });

    function syncState() {
      var playing = cur && !audio.paused;
      var t = $("[data-pl-toggle]");
      t.innerHTML = playing ? ICON.pause : ICON.play;
      t.setAttribute("aria-label", playing ? "一時停止" : "再生");
      $$(".slot.is-playing").forEach(function (s) { s.classList.remove("is-playing"); });
      if (playing) { var sp = slotEl(cur.i); if (sp) sp.classList.add("is-playing"); }
      bus.emit("audio", !!playing, cur);
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

  function slotEl(i) { return EPS[i] ? $('.slot[data-i="' + EPS[i].no + '"]') : null; }
  function spineEl(i) { var sl = slotEl(i); return sl ? $(".spine", sl) : null; }

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

  /* ---------------- bookcase physics ----------------
     Every object on the shelf (book, brass bookend, still life) is a body
     with damped springs. Books can be pushed over sideways and lean on their
     neighbours like dominoes, fall into place with gravity when the case
     first comes into view, wobble when you stroke their spines, and slide
     out (turning their front cover to you) when picked. Sound, dust and a
     tiny shake of the case accompany every knock. */
  var shelf = (function () {
    var noop = function () {};
    var shelfEl = $("[data-shelf]");
    var cab = $("[data-cabinet]");
    if (!shelfEl || !cab) return { pullOut: noop, putBack: noop, wiggle: noop };
    var frame = $(".cab-frame", cab);
    var dustCv = $("[data-dust]", cab);
    var S = function () { return parseFloat(getComputedStyle(cab).getPropertyValue("--s")) || 1; };
    var scale = S();

    function spring(k, c) { return { x: 0, v: 0, t: 0, k: k, c: c }; }
    var bodies = Array.prototype.slice.call(shelfEl.children).map(function (el) {
      var isBook = el.classList.contains("slot");
      return {
        el: el,
        book: isBook,
        i: isBook ? byNo(el.getAttribute("data-i")) : -1,
        piv: isBook ? $(".bk", el) : (el.firstElementChild || el),
        inn: isBook ? $(".bk-in", el) : null,
        heavy: !isBook,
        tilt: spring(isBook ? 240 : 520, isBook ? 9 : 16),
        pull: spring(210, 21),
        turn: spring(170, 17),
        lift: { x: 0, v: 0, t: 0 },
        held: false, wait: false, hover: false, out: false,
        sign: 1, lastKnock: 0, prev: null, next: null, h: 200, w: 40, row: 0,
        drawn: ""
      };
    });
    var books = bodies.filter(function (b) { return b.book; });

    function measure() {
      scale = S();
      bodies.forEach(function (b) {
        b.h = b.piv.offsetHeight || 200;
        b.w = b.el.offsetWidth || 40;
        b.row = b.el.offsetTop;
      });
      bodies.forEach(function (b, k) {
        var p = bodies[k - 1], n = bodies[k + 1];
        b.prev = p && p.row === b.row ? p : null;
        b.next = n && n.row === b.row ? n : null;
      });
      sizeDust();
    }

    /* ---- render ---- */
    function draw(b) {
      var t = b.tilt.x;
      var sign = t >= 0 ? 1 : -1;
      if (sign !== b.sign) { b.sign = sign; b.piv.style.transformOrigin = sign > 0 ? "100% 100%" : "0% 100%"; }
      var key = t.toFixed(2) + "|" + b.lift.x.toFixed(1) + "|" + b.pull.x.toFixed(1) + "|" + b.turn.x.toFixed(1);
      if (key === b.drawn) return;
      b.drawn = key;
      if (b.book) {
        b.piv.style.transform = "rotate(" + t.toFixed(2) + "deg)";
        b.inn.style.transform = "translate3d(0," + (-b.lift.x).toFixed(1) + "px," + b.pull.x.toFixed(1) + "px) rotateY(" + b.turn.x.toFixed(1) + "deg)";
        b.el.classList.toggle("is-active", b.held || b.out || b.pull.x > 3 || Math.abs(b.lift.x) > 3);
      } else {
        b.piv.style.transform = "translateY(" + (-b.lift.x).toFixed(1) + "px) rotate(" + t.toFixed(2) + "deg)";
      }
    }

    /* ---- simulation ---- */
    var running = false, lastT = 0, visible = false, shake = { x: 0, v: 0 };
    function kick() { if (!running) { running = true; lastT = performance.now(); requestAnimationFrame(step); } }
    function stepSpring(s, dt) {
      var a = s.k * (s.t - s.x) - s.c * s.v;
      s.v += a * dt; s.x += s.v * dt;
      return Math.abs(s.v) > 0.02 || Math.abs(s.t - s.x) > 0.02;
    }
    function knock(b, speed, where) {
      var now = performance.now();
      if (now - b.lastKnock < 110) return;
      b.lastKnock = now;
      var v = clamp(speed, 0, 1);
      if (v < 0.04) return;
      sfx.thud(v);
      shake.v += (Math.random() < 0.5 ? -1 : 1) * 40 * v;
      puff(b, where, v);
      bus.emit("shelf:knock", v);
    }
    function step(now) {
      var dt = Math.min(1 / 30, (now - lastT) / 1000 || 0.016);
      lastT = now;
      var active = false;
      for (var k = 0; k < bodies.length; k++) {
        var b = bodies[k];
        var before = b.tilt.x;
        if (stepSpring(b.tilt, dt)) active = true;
        // the case floor and the neighbours stop a book from leaning past ~32°
        b.tilt.x = clamp(b.tilt.x, -32, 32);
        // landing on the board / clicking back upright
        if (!b.held && before !== 0 && (before > 0) !== (b.tilt.x > 0) && Math.abs(b.tilt.v) > 14) knock(b, Math.abs(b.tilt.v) / 260, "base");
        if (b.book) {
          var p0 = b.pull.x;
          if (stepSpring(b.pull, dt)) active = true;
          if (stepSpring(b.turn, dt)) active = true;
          if (p0 > 6 && b.pull.x <= 1.5 && b.pull.v < -60 && !b.out) knock(b, Math.min(1, -b.pull.v / 500), "base");
        }
        // lift: spring while held, gravity + bounce otherwise
        var L = b.lift;
        if (b.held || b.wait) {
          var a = 320 * (L.t - L.x) - 22 * L.v; L.v += a * dt; L.x += L.v * dt;
          if (Math.abs(L.v) > 0.05 || Math.abs(L.t - L.x) > 0.05) active = true;
        } else if (L.x > 0 || L.v !== 0) {
          L.v -= 2600 * dt; L.x += L.v * dt;
          if (L.x <= 0) {
            var imp = -L.v;
            L.x = 0;
            if (imp > 90) { L.v = imp * 0.28; knock(b, imp / 900, "base"); } else L.v = 0;
          }
          active = true;
        }
      }
      // dominoes: a leaning body pushes its neighbour in the same row
      for (var r = 0; r < bodies.length; r++) {
        var A = bodies[r];
        if (A.tilt.x > 0.6 && A.next) push(A, A.next, 1);
      }
      for (var l = bodies.length - 1; l >= 0; l--) {
        var Bq = bodies[l];
        if (Bq.tilt.x < -0.6 && Bq.prev) push(Bq, Bq.prev, -1);
      }
      if (Math.abs(shake.x) > 0.02 || Math.abs(shake.v) > 0.02) {
        shake.v += (-900 * shake.x - 24 * shake.v) * dt; shake.x += shake.v * dt;
        frame.style.transform = "translateX(" + shake.x.toFixed(2) + "px)";
        active = true;
      }
      for (var d = 0; d < bodies.length; d++) draw(bodies[d]);
      var dusty = stepDust(dt);
      running = active || (visible && dusty);
      if (running) requestAnimationFrame(step);
    }
    function push(A, B, dir) {
      // How far B must lean so A's top edge clears it, softened so a loose
      // shelf absorbs some of the push (heavy bookends barely move).
      var factor = B.heavy ? 0.28 : 0.82;
      var need = (Math.abs(A.tilt.x) - 0.6) * factor * Math.min(1.15, A.h / Math.max(60, B.h));
      if (need <= 0) return;
      var cur = B.tilt.x * dir;
      if (cur < need) {
        var hit = (need - cur) > 1.5 && Math.abs(A.tilt.v) > 40 && cur < 0.5;
        B.tilt.x = need * dir;
        if (B.tilt.v * dir < A.tilt.v * dir * factor) B.tilt.v = A.tilt.v * factor;
        if (hit) knock(B, Math.abs(A.tilt.v) / 500, dir > 0 ? "left" : "right");
      }
    }

    /* ---- dust motes in the lamp light + puffs on every knock ---- */
    var motes = [], puffs = [], dctx = dustCv ? dustCv.getContext("2d") : null, DW = 0, DH = 0, ddpr = 1;
    function sizeDust() {
      if (!dctx) return;
      ddpr = Math.min(2, window.devicePixelRatio || 1);
      DW = dustCv.clientWidth; DH = dustCv.clientHeight;
      dustCv.width = Math.round(DW * ddpr); dustCv.height = Math.round(DH * ddpr);
      if (!motes.length) for (var k = 0; k < 46; k++) motes.push({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.4, vx: (Math.random() - 0.5) * 0.006, vy: -0.002 - Math.random() * 0.006, p: Math.random() * 6 });
    }
    function puff(b, where, v) {
      if (!dctx || reduce) return;
      var fr = frame.getBoundingClientRect(), r = b.el.getBoundingClientRect();
      var x = where === "left" ? r.left : where === "right" ? r.right : r.left + r.width / 2;
      var y = r.bottom - parseFloat(getComputedStyle(cab).getPropertyValue("--board") || 18) - (where === "base" ? 0 : b.h * 0.85);
      var n = Math.round(2 + v * 9);
      for (var k = 0; k < n; k++) puffs.push({ x: x - fr.left, y: y - fr.top, vx: (Math.random() - 0.5) * 70 * (0.4 + v), vy: -10 - Math.random() * 50 * (0.4 + v), life: 0, max: 0.9 + Math.random() * 0.8, r: 0.8 + Math.random() * 1.8 });
      kick();
    }
    var lightX = 0.6, lightY = 0.2;
    function stepDust(dt) {
      if (!dctx || !visible || reduce) return false;
      dctx.setTransform(ddpr, 0, 0, ddpr, 0, 0);
      dctx.clearRect(0, 0, DW, DH);
      var lx = lightX * DW, ly = lightY * DH;
      for (var k = 0; k < motes.length; k++) {
        var m = motes[k];
        m.p += dt; m.x += (m.vx + Math.sin(m.p * 0.7) * 0.002) * dt; m.y += m.vy * dt;
        if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); }
        if (m.x < -0.02) m.x = 1.02; if (m.x > 1.02) m.x = -0.02;
        var px = m.x * DW, py = m.y * DH;
        var d = Math.hypot(px - lx, (py - ly) * 1.3) / 420;
        var a = Math.max(0, 0.55 - d) * (0.6 + 0.4 * Math.sin(m.p * 2));
        if (a < 0.02) continue;
        dctx.fillStyle = "rgba(255,226,170," + a.toFixed(3) + ")";
        dctx.beginPath(); dctx.arc(px, py, m.r, 0, 6.283); dctx.fill();
      }
      for (var q = puffs.length - 1; q >= 0; q--) {
        var p = puffs[q];
        p.life += dt;
        if (p.life > p.max) { puffs.splice(q, 1); continue; }
        p.vx *= 0.96; p.vy = p.vy * 0.96 + 14 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        var al = (1 - p.life / p.max) * 0.22;
        dctx.fillStyle = "rgba(236,220,190," + al.toFixed(3) + ")";
        dctx.beginPath(); dctx.arc(p.x, p.y, p.r * (1 + p.life * 0.6), 0, 6.283); dctx.fill();
      }
      return true;
    }

    /* ---- interaction ---- */
    var drag = null;
    books.forEach(function (b) {
      var el = b.el;
      el.addEventListener("dragstart", function (e) { e.preventDefault(); });
      el.addEventListener("pointerenter", function (e) {
        if (e.pointerType !== "mouse" || drag) return;
        b.hover = true;
        if (!b.out) { b.pull.t = 16 * scale; }
        kick();
        bus.emit("shelf:hover", b.i);
      });
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        var mx = clamp((e.clientX - r.left) / r.width, 0, 1);
        el.style.setProperty("--mx", mx.toFixed(3));
        if (b.hover && !b.out && !b.held) { b.turn.t = (0.5 - mx) * 26; kick(); }
      });
      el.addEventListener("pointerleave", function () {
        b.hover = false;
        if (!b.held && !b.out) { b.pull.t = 0; b.turn.t = 0; kick(); }
      });
      el.addEventListener("pointerdown", function (e) {
        if (e.button !== 0 || b.out) return;
        drag = { b: b, x: e.clientX, y: e.clientY, t: performance.now(), moved: false, id: e.pointerId, type: e.pointerType };
        b.held = true; b.lift.t = 0;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
        el.classList.add("is-grab");
        kick();
      });
      el.addEventListener("pointermove", function (e) {
        if (!drag || drag.b !== b || e.pointerId !== drag.id) return;
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 6) { drag.moved = true; bus.emit("shelf:grab", b.i); }
        if (!drag.moved) return;
        // push the top of the spine: the angle follows the finger at the top
        b.tilt.t = clamp(Math.atan2(dx, b.h * 0.9) * 57.3, -30, 30);
        b.lift.t = drag.type === "mouse" ? clamp(-dy * 0.45, 0, 54 * scale) : 0;
        b.pull.t = 10 * scale;
        b.turn.t = 0;
        kick();
      });
      function release(e) {
        if (!drag || drag.b !== b) return;
        var d = drag; drag = null;
        b.held = false;
        el.classList.remove("is-grab");
        b.tilt.t = 0; b.lift.t = 0;
        if (!b.hover) { b.pull.t = 0; b.turn.t = 0; } else b.pull.t = 16 * scale;
        kick();
        if (e.type === "pointercancel") return;
        if (!d.moved || b.lift.x > 36 * scale) {
          pullOut(b.i, true);
        } else {
          var tipped = bodies.filter(function (x) { return Math.abs(x.tilt.x) > 6; }).length;
          bus.emit("shelf:drop", b.i, tipped);
        }
      }
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
      el.addEventListener("click", function (e) {
        e.preventDefault();
        // keyboard activation (Enter) arrives as a click without a pointer
        if (e.detail === 0) pullOut(b.i, true);
      });
    });

    // stroking the spines makes them wobble (and click softly against each other)
    var lastRiffle = 0;
    shelfEl.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "mouse" || drag) return;
      var t = e.target.closest && e.target.closest(".slot");
      var fr = frame.getBoundingClientRect();
      lightX = clamp((e.clientX - fr.left) / fr.width, 0, 1);
      lightY = clamp((e.clientY - fr.top) / fr.height, 0, 1);
      cab.style.setProperty("--lx", (lightX * 100).toFixed(1) + "%");
      cab.style.setProperty("--ly", (lightY * 100).toFixed(1) + "%");
      if (!t) return;
      var b = bodies.find(function (x) { return x.el === t; });
      var mv = e.movementX || 0;
      if (b && !b.out && Math.abs(mv) > 3) {
        b.tilt.v += clamp(mv, -40, 40) * 3.2;
        var now = performance.now();
        if (Math.abs(mv) > 9 && now - lastRiffle > 70) { lastRiffle = now; sfx.thud(Math.min(0.12, Math.abs(mv) / 300)); bus.emit("shelf:stroke"); }
        kick();
      }
    });

    /* ---- pull a book out, front cover turned to the reader ---- */
    var outBook = null;
    function pullOut(i, thenOpen) {
      var b = books.find(function (x) { return x.i === i; });
      if (!b) { if (thenOpen) room.open(i, null); return; }
      if (outBook && outBook !== b) putBack();
      outBook = b; b.out = true;
      b.tilt.t = 0; b.lift.t = 0;
      b.pull.t = 150 * scale; b.turn.t = -72;
      sfx.slide(0.42, 0.8);
      kick();
      bus.emit("shelf:pull", i);
      if (!thenOpen) return;
      setTimeout(function () { room.open(i, $(".f-cover", b.el) || $(".spine", b.el)); }, reduce ? 0 : 430);
    }
    function putBack() {
      var b = outBook;
      if (!b) return;
      outBook = null; b.out = false;
      b.pull.t = 0; b.turn.t = 0;
      sfx.slide(0.3, 0.5);
      kick();
    }
    function wiggle(i) {
      var b = books.find(function (x) { return x.i === i; });
      if (!b) return;
      b.tilt.v += 260; b.lift.v = 260; b.lift.x = 0.1;
      kick();
    }
    bus.on("room:close", function () { setTimeout(putBack, 60); });

    /* ---- the books fall into place the first time the case is seen ---- */
    var dropped = false;
    function dropIn() {
      if (dropped) return;
      dropped = true;
      if (reduce) return;
      var t0 = performance.now();
      bodies.forEach(function (b, k) {
        b.delay = 60 + k * 32;
        b.wait = true;
        b.lift.x = b.lift.t = 46 + (k % 3) * 12; b.lift.v = 0;
        b.tilt.x = (Math.random() - 0.5) * 8;
        b.el.style.opacity = '0';
        draw(b);
      });
      (function tick() {
        var el = performance.now() - t0, any = false;
        bodies.forEach(function (b) {
          if (b.wait && el >= b.delay) { b.wait = false; b.lift.v = 0; b.el.style.opacity = ''; }
          if (b.wait) any = true;
        });
        kick();
        if (any) requestAnimationFrame(tick); else setTimeout(function () { bus.emit('shelf:settled'); }, 700);
      })();
    }

    measure();
    window.addEventListener("resize", function () { measure(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (en) {
        visible = en[0].isIntersecting;
        if (visible) { if (en[0].intersectionRatio > 0.15) dropIn(); kick(); }
      }, { threshold: [0, 0.15, 0.4] }).observe(cab);
    } else { visible = true; kick(); }

    return { pullOut: pullOut, putBack: putBack, wiggle: wiggle };
  })();

  $$("[data-open-book]").forEach(function (a) {
    a.addEventListener("click", function (e) { e.preventDefault(); var i = byNo(a.getAttribute("data-open-book")); room.open(i, spineEl(i)); });
  });

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
        bus.emit("room:open", i);
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
        bus.emit("room:close", state.index);
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

  /* ---------------- assistants ----------------
     しおり — a black cat, the librarian, lives on top of the bookcase.
     こむぎ — a shiba, the guide, waits in the corner of the screen.
     Both react to what happens on the page (books, playback, sections) and
     talk through little speech bubbles. Everything they say is generated
     from the library data, so it changes every day. */
  (function () {
    var catEl = $("[data-cat]"), catBubble = $("[data-cat-bubble]");
    var dock = $("[data-dog-dock]"), dogEl = $("[data-dog]"), dogBubble = $("[data-dog-bubble]"), callBtn = $("[data-dog-call]");
    if (!EPS.length) { if (dock) dock.hidden = true; return; }
    var latest = EPS[0];
    var totalHours = EPS.reduce(function (s, ep) { return s + Object.keys(ep.audio).reduce(function (t, l) { return t + (ep.audio[l].dur || 0); }, 0); }, 0) / 3600;

    /* speech bubbles with a typewriter effect */
    var narrow = window.matchMedia && matchMedia("(max-width: 720px)");
    function say(bubble, who, text, opts) {
      if (!bubble) return;
      opts = opts || {};
      if (narrow && narrow.matches) [catBubble, dogBubble].forEach(function (o) { if (o && o !== bubble) hide(o); });
      clearTimeout(bubble._hide); clearInterval(bubble._type);
      bubble.hidden = false;
      bubble.innerHTML = '<button type="button" class="x" aria-label="閉じる">×</button><span class="who">' + esc(who) + '</span><span class="tx"></span>';
      bubble.style.animation = "none"; void bubble.offsetWidth; bubble.style.animation = "";
      var tx = $(".tx", bubble), k = 0;
      var finish = function () {
        tx.textContent = text;
        if (opts.menu) {
          var m = document.createElement("div");
          m.className = "menu";
          opts.menu.forEach(function (item) {
            var b = document.createElement("button");
            b.type = "button"; b.textContent = item[0];
            b.addEventListener("click", function (e) { e.stopPropagation(); hide(bubble); item[1](); });
            m.appendChild(b);
          });
          bubble.appendChild(m);
        }
        var ms = opts.stay || (opts.menu ? 14000 : 3600 + text.length * 70);
        bubble._hide = setTimeout(function () { hide(bubble); }, ms);
      };
      $(".x", bubble).addEventListener("click", function (e) { e.stopPropagation(); hide(bubble); });
      if (reduce) { finish(); return; }
      bubble._type = setInterval(function () {
        k += 1;
        tx.textContent = text.slice(0, k);
        if (k >= text.length) { clearInterval(bubble._type); finish(); }
      }, 26);
    }
    function hide(bubble) {
      if (!bubble) return;
      clearTimeout(bubble._hide); clearInterval(bubble._type);
      bubble.hidden = true;
    }
    function blinker(el) {
      if (!el || reduce) return;
      (function loop() {
        setTimeout(function () {
          if (!el.classList.contains("is-sleep")) {
            el.classList.add("is-blink");
            setTimeout(function () { el.classList.remove("is-blink"); }, 140);
          }
          loop();
        }, 2200 + Math.random() * 4200);
      })();
    }
    function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
    function greeting() {
      var h = new Date().getHours();
      return h < 5 ? "夜ふかしさんだね" : h < 11 ? "おはよう" : h < 17 ? "こんにちは" : "こんばんは";
    }

    /* ---------- しおり (cat) ---------- */
    var cat = (function () {
      if (!catEl) return { say: function () {}, react: function () {} };
      var head = $(".cat-head", catEl), pupils = $(".cat-pupils", catEl);
      var idle = 0, sleeping = false, tipIndex = Math.floor(Math.random() * 3);
      blinker(catEl);
      function tips() {
        var oldest = EPS[EPS.length - 1];
        var rnd = EPS[Math.floor(Math.random() * EPS.length)];
        return [
          "今日の新刊は『" + label(latest) + "』。論文が" + latest.papers.length + "本、" + Object.keys(latest.audio).length + "つの声で読まれてるよ。",
          "背表紙を横にドラッグしてみて。となりの本も押されて、ドミノみたいに傾くの。",
          "本をクリックすると、表紙をこっちに向けて取り出せるよ。",
          "この棚には" + EPS.length + "冊。いちばん古いのは No.1『" + label(oldest) + "』だよ。",
          "ここには " + totalHours.toFixed(1) + " 時間ぶんの声が眠ってるんだ。",
          "背表紙をそっとなでると、本がゆらゆらするの。わたしのお気に入り。",
          "言語を切り替えると、背表紙も表紙もぜんぶその言葉になるよ。",
          "おすすめは No." + rnd.no + "『" + label(rnd) + "』。気になったら取り出してみて。",
          "/ キーを押すと目録の検索にとべるよ。カードから本がひらくの。"
        ];
      }
      function wake(quiet) {
        idle = 0;
        if (!sleeping) return;
        sleeping = false;
        catEl.classList.remove("is-sleep");
        if (!quiet && Math.random() < 0.35) say(catBubble, "しおり", pick(["…ふぁ。いらっしゃい。", "ん…寝てないよ、本の番をしてただけ。", "にゃ…あ、お客さんだ。"]));
      }
      setInterval(function () {
        idle += 1;
        if (!sleeping && idle > 28 && !catEl.classList.contains("is-listening")) { sleeping = true; catEl.classList.add("is-sleep"); hide(catBubble); }
      }, 1000);
      ["scroll", "keydown"].forEach(function (t) { window.addEventListener(t, function () { wake(true); }, { passive: true }); });

      // eyes (and a little of the head) follow the pointer
      var pending = false, px = 0, py = 0;
      window.addEventListener("pointermove", function (e) {
        px = e.clientX; py = e.clientY;
        if (Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0) > 2) wake(true);
        if (pending || reduce) return;
        pending = true;
        requestAnimationFrame(function () {
          pending = false;
          var r = catEl.getBoundingClientRect();
          if (r.bottom < -200 || r.top > window.innerHeight + 200) return;
          var cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.25;
          var dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy) || 1;
          var m = Math.min(2.6, d / 60);
          pupils.style.transform = "translate(" + (dx / d * m).toFixed(2) + "px," + (dy / d * m * 0.7).toFixed(2) + "px)";
          if (!sleeping) head.style.transform = "rotate(" + clamp(dx / 60, -7, 7).toFixed(2) + "deg)";
        });
      });

      catEl.addEventListener("click", function () {
        var wasAsleep = sleeping;
        wake(true);
        catEl.classList.remove("is-purr"); void catEl.offsetWidth;
        catEl.classList.add("is-purr");
        sfx.purr(1.4);
        setTimeout(function () { catEl.classList.remove("is-purr"); }, 1400);
        hearts();
        var list = tips();
        var text = wasAsleep ? "…ん、にゃ？ 起こされちゃった。" + list[0] : list[tipIndex++ % list.length];
        say(catBubble, "しおり · 司書", text);
      });
      function hearts() {
        if (reduce) return;
        for (var k = 0; k < 3; k++) {
          var h = document.createElement("span");
          h.className = "heart"; h.textContent = "♥";
          h.style.left = (30 + Math.random() * 50) + "%"; h.style.top = "10%";
          h.style.setProperty("--dx", ((Math.random() - 0.5) * 40).toFixed(0) + "px");
          h.style.animationDelay = (k * 0.15) + "s";
          catEl.appendChild(h);
          setTimeout(function (n) { return function () { n.remove(); }; }(h), 1800);
        }
      }
      function startle(text) {
        wake(true);
        catEl.classList.remove("is-startle"); void catEl.offsetWidth;
        catEl.classList.add("is-startle");
        setTimeout(function () { catEl.classList.remove("is-startle"); }, 600);
        if (text) say(catBubble, "しおり", text);
      }
      return {
        say: function (t) { wake(true); say(catBubble, "しおり · 司書", t); },
        startle: startle,
        listen: function (on) { catEl.classList.toggle("is-listening", on); if (on) wake(true); },
        lookAt: function (el) {
          if (!el || reduce || sleeping) return;
          var r = catEl.getBoundingClientRect(), t = el.getBoundingClientRect();
          var dx = t.left + t.width / 2 - (r.left + r.width / 2);
          head.style.transform = "rotate(" + clamp(dx / 50, -9, 9).toFixed(2) + "deg) translateY(2px)";
        }
      };
    })();

    /* ---------- こむぎ (dog) ---------- */
    var dog = (function () {
      if (!dock || !dogEl) return { say: function () {}, happy: function () {}, fetch: function () {} };
      blinker(dogEl);
      var hidden = store.get("dogHidden", false);
      function show() {
        hidden = false; store.set("dogHidden", false);
        dock.classList.remove("is-hidden"); dock.classList.add("is-in");
        callBtn.hidden = true;
      }
      function goAway() {
        hidden = true; store.set("dogHidden", true);
        hide(dogBubble);
        dock.classList.add("is-hidden");
        setTimeout(function () { callBtn.hidden = false; }, 700);
      }
      function happy(ms) {
        dogEl.classList.add("is-happy");
        clearTimeout(dogEl._h);
        dogEl._h = setTimeout(function () { dogEl.classList.remove("is-happy"); }, ms || 1600);
      }
      function talk(text, opts) {
        if (hidden) return;
        happy(1200);
        say(dogBubble, "こむぎ · 案内係", text, opts);
      }
      function menu(text) {
        talk(text || "なにする？ワン！", { menu: [
          ["▶ 今日の巻を聴く", function () { player.play(0, lang); talk("再生したよ！『" + label(latest) + "』"); }],
          ["🎲 おまかせで1冊", fetchBook],
          ["🔎 論文をさがす", function () { catalog.focus && catalog.focus(); talk("キーワードを入れてね。カードを押すと本がひらくワン"); }],
          ["💤 またね", function () { talk("またね！左下の足あとを押すと、すぐ戻ってくるワン", { stay: 1800 }); setTimeout(goAway, 1900); }]
        ] });
      }
      // run to the shelf and bring back a random book
      function fetchBook() {
        var cur = player.current();
        var choices = EPS.map(function (_, k) { return k; }).filter(function (k) { return !cur || k !== cur.i; });
        var i = pick(choices);
        var ep = EPS[i];
        sfx.bark();
        talk("とってくるワン！", { stay: 2000 });
        var stacks = $("#stacks");
        if (stacks) stacks.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        if (!reduce && dogEl.animate) {
          dogEl.classList.add("is-run");
          var far = Math.min(window.innerWidth * 0.55, 520);
          var a = dogEl.animate([
            { transform: "translateX(0)" },
            { transform: "translateX(" + far + "px)", offset: 0.45 },
            { transform: "translateX(" + far + "px) scaleX(-1)", offset: 0.55 },
            { transform: "translateX(0) scaleX(-1)", offset: 0.98 },
            { transform: "translateX(0)" }
          ], { duration: 1900, easing: "ease-in-out" });
          setTimeout(function () { shelf.wiggle(i); }, 900);
          a.onfinish = function () {
            dogEl.classList.remove("is-run");
            talk("これはどう？ No." + ep.no + "『" + label(ep) + "』", { stay: 4200 });
            setTimeout(function () { shelf.pullOut(i, true); }, 700);
          };
        } else {
          talk("これはどう？ No." + ep.no + "『" + label(ep) + "』", { stay: 4200 });
          shelf.pullOut(i, true);
        }
      }
      dogEl.addEventListener("click", function () { sfx.bark(); menu(); });
      callBtn.addEventListener("click", function () { show(); sfx.bark(); talk("呼んだ？ワン！"); });

      // entrance + first words
      if (hidden) { dock.classList.add("is-hidden"); callBtn.hidden = false; }
      else setTimeout(function () {
        dock.classList.add("is-in");
        var met = store.get("met", false), seen = store.get("seen", "");
        setTimeout(function () {
          if (!met) {
            store.set("met", true); store.set("seen", latest.date);
            sfx.bark();
            talk("ワン！ぼくはこむぎ、案内係だよ。困ったらぼくを押してね。", { stay: 5200 });
          } else if (seen !== latest.date) {
            store.set("seen", latest.date);
            sfx.chime();
            talk("新刊が届いたワン！ No." + latest.no + "『" + label(latest) + "』", { menu: [
              ["▶ 聴く", function () { player.play(0, lang); }],
              ["📖 棚で見る", function () { var s = $("#stacks"); if (s) s.scrollIntoView({ behavior: "smooth" }); setTimeout(function () { shelf.pullOut(0, true); }, 900); }]
            ] });
          }
        }, 900);
      }, 1500);

      // one hint per section per visit
      var hinted = {};
      var hints = {
        stacks: "本の背表紙を横にドラッグしてみて！となりの本も一緒に傾くワン",
        catalog: "ここは目録。/ キーでも検索できるワン",
        subscribe: "RSS をコピーしてアプリに入れると、毎朝6:30に新刊が届くワン"
      };
      if ("IntersectionObserver" in window) {
        var io = new IntersectionObserver(function (en) {
          en.forEach(function (x) {
            var id = x.target.id;
            if (!x.isIntersecting || hinted[id] || !dogBubble.hidden) return;
            hinted[id] = true;
            setTimeout(function () { if (dogBubble.hidden) talk(hints[id]); }, 600);
          });
        }, { threshold: 0.35 });
        Object.keys(hints).forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
      }
      return { say: talk, happy: happy, fetch: fetchBook };
    })();

    /* ---------- reactions ---------- */
    var greeted = false, stroked = false, grabs = 0;
    bus.on("shelf:settled", function () {
      if (greeted) return;
      greeted = true;
      cat.say(greeting() + "。今朝の新刊は『" + label(latest) + "』だよ。ゆっくり見ていってね。");
    });
    bus.on("shelf:hover", function (i) { cat.lookAt(spineEl(i)); });
    bus.on("shelf:grab", function (i) { grabs += 1; cat.lookAt(spineEl(i)); if (grabs === 1) cat.say("そっと、そっとね…"); });
    bus.on("shelf:drop", function (i, tipped) {
      if (tipped >= 5) cat.startle(pick(["にゃっ！ドミノはほどほどにね。", "にゃっ！…ちゃんと元に戻ってよかった。", "わっ、棚が揺れた。本たちはみんな無事だよ。"]));
    });
    bus.on("shelf:knock", function (v) { if (v > 0.75) cat.startle(); });
    bus.on("shelf:stroke", function () { if (!stroked) { stroked = true; setTimeout(function () { cat.say("背表紙をなでるの、気持ちいいでしょ。"); }, 400); } });
    bus.on("shelf:pull", function (i) {
      if (Math.random() < 0.35) setTimeout(function () { cat.say(pick(["『" + label(EPS[i]) + "』、いい本を選んだね。", "その巻は No." + EPS[i].no + "。論文" + EPS[i].papers.length + "本入り。", "読み終わったら、ちゃんと棚に戻すからね。"])); }, 200);
    });
    bus.on("audio", function (on) { cat.listen(on); if (on) dog.happy(1000); });
    bus.on("ended", function () {
      dog.say("おしまい！明日の朝6:30に、また新しい巻が届くワン", { menu: [["🎲 おまかせで次の1冊", function () { dog.fetch(); }]] });
    });
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
