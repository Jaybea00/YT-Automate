/*!
 * KitMotion: the motion language of the AI component library (library/_kit/motion).
 *
 * The motion tokens and transitions come from transitions.dev (free tier, read via
 * `npx transitions-dev add --free`). They are rewritten here as seekable GSAP helpers.
 * Every helper ADDS tweens to the paused timeline you pass in, at an absolute time.
 *
 * LICENCE NOTE: the transitions.dev values and recipes may be used inside this project.
 * Do NOT publish or redistribute this file (or the tokens) as a transitions pack.
 *
 * Seek rules this file follows:
 *  - Only fromTo tweens with immediateRender:false. The start state of an element is set
 *    once at build time with gsap.set (prime), never by CSS transitions or class toggles.
 *  - Text and per-character effects run through drive(). It tweens a getter/setter
 *    property, which GSAP calls on every render, including seeks made with
 *    suppressEvents=true. onUpdate is NOT used, because GSAP skips onUpdate on
 *    suppressed seeks and the HyperFrames runtime seeks that way on some paths.
 *  - No timers, no Math.random (typing and streaming use a seeded PRNG), no Date.
 *  - For each element, call the helpers in time order. The text state and size state
 *    of an element are tracked at build time in call order.
 */
(function (root) {
  'use strict';
  var gsap = root.gsap;
  if (!gsap) throw new Error('KitMotion: load gsap before motion.js');
  var doc = root.document;

  /* ======================================================================
     TOKENS (transitions.dev live tuning, Oct 2026)
     ====================================================================== */

  // cubic-bezier control points, by role
  var BEZIER = {
    out:      [0.22, 1, 0.36, 1],    // house ease (easeOutQuint): menus, modals, panels, pages, tabs, toasts, stream, checks, reveal
    outExpo:  [0.16, 1, 0.3, 1],     // spinning counter reel
    pop:      [0.34, 1.36, 0.64, 1], // badge pop (about 4% overshoot)
    popDigit: [0.34, 1.45, 0.64, 1], // number pop-in (about 7% overshoot)
    bob:      [0.34, 1.35, 0.64, 1], // success-check bob, toggle thumb
    popSoft:  [0.34, 1.25, 0.64, 1], // plus-to-menu morph
    spring:   [0.34, 3.85, 0.64, 1], // avatar release only (overshoots by 100%; use sparingly)
    standard: [0.4, 0, 0.2, 1],      // badge close
    inOut:    [0.42, 0, 0.58, 1],    // CSS ease-in-out: text swap, icon swap, thinking swap, skeleton
    easeOut:  [0, 0, 0.58, 1],       // CSS ease-out: tooltip, error border/message
    ease:     [0.25, 0.1, 0.25, 1]   // CSS ease: texts-reveal exit fade
  };

  // duration scale in seconds (every value is used by at least one transitions.dev recipe)
  var DUR = {
    instant: 0.05, // tooltip out
    fast: 0.15,    // text swap, menu/modal close, tooltip in, checkbox fill, thinking swap
    base: 0.25,    // menu/modal open, icon swap, page slide, tabs, accordion, toast close
    medium: 0.35,  // toast open, streamed word fade, checkbox draw, toggle, panel close
    slow: 0.4,     // panel open, badge fade, skeleton reveal
    emphasis: 0.5, // number pop, success check, texts reveal, reasoning step
    reel: 1.4      // spinning counter
  };

  // per-transition tokens (px values are CSS px at UI scale 1; see config.scale)
  var T = {
    reveal:   { dur: 0.5, distance: 12, stagger: 0.04, blur: 3, ease: 'out', exit: 0.2, exitEase: 'ease' },
    digit:    { dur: 0.5, distance: 8, stagger: 0.07, blur: 2, ease: 'popDigit' },
    textSwap: { dur: 0.15, distance: 4, blur: 2, ease: 'inOut' },
    icon:     { dur: 0.25, blur: 2, scale: 0.25, ease: 'inOut' },
    check:    { dur: 0.5, rotate: 80, y: 40, blur: 10, pathDelay: 0.08, ease: 'out', bobEase: 'bob' },
    menu:     { open: 0.25, close: 0.15, preScale: 0.97, closingScale: 0.99, ease: 'out' },
    modal:    { open: 0.25, close: 0.15, scale: 0.96, closeScale: 0.96, ease: 'out' },
    panel:    { open: 0.4, close: 0.35, distance: 100, blur: 2, ease: 'out' },
    badge:    { slide: 0.26, pop: 0.5, fade: 0.4, close: 0.18, blur: 2, dx: -8.2, dy: 12.4,
                slideEase: 'out', popEase: 'pop', closeEase: 'standard' },
    resize:   { dur: 0.3, ease: 'out' },
    shake:    { distance: 6, overshoot: 4, a: 0.08, b: 0.06, ease: 'out', border: 0.15, revert: 0.28, revertEase: 'easeOut' },
    stream:   { gap: 0.06, fade: 0.35, blur: 1, ease: 'out' },
    toast:    { open: 0.35, close: 0.25, distance: 16, blur: 2, scale: 0.97, ease: 'out' },
    tooltip:  { in: 0.15, out: 0.05, delay: 0.08, scale: 0.98, ease: 'easeOut' },
    page:     { dur: 0.25, distance: 8, blur: 3, ease: 'out' },
    tabs:     { dur: 0.25, ease: 'out' },
    checkbox: { box: 0.15, draw: 0.35, delay: 0, uncheck: 0.15, ease: 'out' },
    toggle:   { dur: 0.35, travel: 14.66, ov1: 1, ov2: 0, track: 0, ease: 'bob' },
    shimmer:  { period: 2 },
    think:    { swap: 0.15, gap: 0.05, distance: 8, blur: 2, ease: 'inOut' },
    skeleton: { pulse: 1, pulseMin: 0.5, reveal: 0.4, blur: 2, ease: 'inOut' },
    avatar:   { lift: -4, dur: 0.32, scale: 1.05, falloff: 0.45, easeIn: 'out', easeOut: 'spring' },
    // Library additions. transitions.dev has no typing, cursor or press recipe.
    type:     { cps: 24, blink: 0.53, solidAfter: 0.5, caretTail: 1.2 },
    cursor:   { minDur: 0.45, maxDur: 1.0, settle: 0.06, press: 0.06, hold: 0.04, release: 0.12,
                pressScale: 0.9, targetScale: 0.97, ease: 'move' }
  };

  var CONFIG = { scale: 1, tempo: 1 };

  /* ======================================================================
     EASING: exact cubic-beziers. CustomEase is used when it is loaded; otherwise
     a built-in solver is used. Both agree to within 0.001, so both are exact.
     ====================================================================== */
  function cubicBezier(x1, y1, x2, y2) {
    var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    function sx(t) { return ((ax * t + bx) * t + cx) * t; }
    function sy(t) { return ((ay * t + by) * t + cy) * t; }
    function dx(t) { return (3 * ax * t + 2 * bx) * t + cx; }
    function solve(x) {
      var t = x, i, d, e;
      for (i = 0; i < 8; i++) {
        e = sx(t) - x; if (Math.abs(e) < 1e-7) return t;
        d = dx(t); if (Math.abs(d) < 1e-6) break;
        t -= e / d;
      }
      var lo = 0, hi = 1; t = x;
      for (i = 0; i < 60; i++) {
        e = sx(t); if (Math.abs(e - x) < 1e-7) return t;
        if (x > e) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return t;
    }
    return function (p) { return p <= 0 ? 0 : p >= 1 ? 1 : sy(solve(p)); };
  }

  var CE = root.CustomEase || null;
  if (CE) gsap.registerPlugin(CE);
  var EASES = { move: 'power2.inOut', linear: 'none' };
  Object.keys(BEZIER).forEach(function (k) {
    var b = BEZIER[k], id = 'kit-' + k;
    if (CE) CE.create(id, 'M0,0 C' + b[0] + ',' + b[1] + ' ' + b[2] + ',' + b[3] + ' 1,1');
    else gsap.registerEase(id, cubicBezier(b[0], b[1], b[2], b[3]));
    EASES[k] = id;
  });

  function E(name) { return typeof name === 'function' ? name : (EASES[name] || name || 'none'); }
  function EF(name) { return gsap.parseEase(E(name)); }

  /* ======================================================================
     INTERNALS
     ====================================================================== */
  function pick(a, b) { return a != null ? a : b; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function assign(a) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) a[k] = s[k]; } return a; }
  function $(x) { return typeof x === 'string' ? doc.querySelector(x) : x; }
  function $$(x) {
    if (typeof x === 'string') return Array.prototype.slice.call(doc.querySelectorAll(x));
    if (x && x.length != null && !x.nodeType) {
      var out = [];
      Array.prototype.forEach.call(x, function (it) { out.push.apply(out, $$(it)); });
      return out;
    }
    return x ? [x] : [];
  }
  function blur(px) { return 'blur(' + (Math.round(Math.max(0, px) * 1000) / 1000) + 'px)'; }
  function D(o, d) { return d * pick(o && o.tempo, CONFIG.tempo); }
  function S(el, o) {
    var s = pick(o && o.scale, CONFIG.scale);
    if (s === 'auto') s = (parseFloat(root.getComputedStyle(el).fontSize) || 16) / 16;
    return s;
  }
  function span(cls, text) { var s = doc.createElement('span'); s.className = cls; if (text != null) s.textContent = text; return s; }
  function inlineBlock(el) { if (root.getComputedStyle(el).display === 'inline') el.style.display = 'inline-block'; }

  // A seeded PRNG (mulberry32) and a string hash. Typing and streaming stay identical on every render.
  function hashStr(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function prng(seed) {
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // Build-time state, tracked in call order.
  var primed = new WeakMap();   // el -> true once its pre-animation state has been set
  var texts = new WeakMap();    // el -> text after the last scheduled text helper
  var sizes = new WeakMap();    // el -> {width,height} after the last cardResize
  var points = new WeakMap();   // cursor -> {x,y,hand} after the last move
  var pills = new WeakMap();    // tab pill -> {x,width}
  var lifts = new WeakMap();    // avatar -> {y,scale}

  function prime(el, vars) { if (el && !primed.has(el)) { primed.set(el, true); gsap.set(el, assign({}, vars)); } }
  function textOf(el) { return texts.has(el) ? texts.get(el) : el.textContent; }
  function ft(tl, el, from, to, at) {
    to.immediateRender = false;
    tl.fromTo(el, from, to, Math.max(0, at));
  }

  /**
   * drive(tl, at, duration, fn, ease?): the seek-safe per-frame primitive.
   * fn(p) runs on every render with p in [0,1]. p = 0 MUST equal the state before `at`
   * (seeking back past `at` renders p = 0). Returns at + duration.
   */
  function drive(tl, at, duration, fn, ease) {
    var v = 0;
    var proxy = { p: function (x) { if (!arguments.length) return v; v = x; fn(x); } };
    tl.fromTo(proxy, { p: 0 }, { p: 1, duration: Math.max(duration, 1e-3), ease: E(ease || 'linear'), immediateRender: false }, Math.max(0, at));
    return at + duration;
  }

  // CSS the helpers need. It is static: no transitions and no animations.
  (function injectCSS() {
    if (!doc || doc.getElementById('kit-motion-css')) return;
    var css = [
      '.km-caret{display:inline-block;width:var(--km-caret-w,2px);height:1.12em;margin-left:var(--km-caret-gap,1px);vertical-align:-0.18em;background:var(--km-caret-color,currentColor);border-radius:1px}',
      '.km-digit{display:inline-block;white-space:pre}',
      '.km-shimmer{position:relative;display:inline-block;color:var(--km-shimmer-base,#7c7c7c)}',
      '.km-shimmer::before{content:attr(data-text);position:absolute;inset:0;pointer-events:none;white-space:inherit;' +
        'background-image:linear-gradient(90deg,transparent 0%,transparent 40%,var(--km-shimmer-hi,#0d0d0d) 50%,transparent 60%,transparent 100%);' +
        'background-size:var(--km-shimmer-band,400%) 100%;background-repeat:no-repeat;background-position:var(--km-shimmer-x,100%) 0;' +
        '-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}',
      '.km-think{position:relative;display:inline-block}',
      '.km-think-sizer{display:block;visibility:hidden;white-space:nowrap}',
      '.km-think-line{position:absolute;top:0;left:0;right:0;display:block;white-space:nowrap}'
    ].join('\n');
    var st = doc.createElement('style'); st.id = 'kit-motion-css'; st.textContent = css;
    (doc.head || doc.documentElement).appendChild(st);
  })();

  var ORIGINS = {
    'top-left': '0% 0%', 'top-center': '50% 0%', 'top-right': '100% 0%',
    'bottom-left': '0% 100%', 'bottom-center': '50% 100%', 'bottom-right': '100% 100%',
    'center': '50% 50%'
  };
  function origin(o) { return ORIGINS[o] || o || '0% 0%'; }
  function pathLen(path) { var len = Math.ceil(path.getTotalLength()) + 1; path.style.strokeDasharray = String(len); return len; }

  /* ======================================================================
     ENTRANCES / EXITS
     ====================================================================== */

  /** fadeUp(tl, els, at, o): texts-reveal entrance. Rises 12px through a 3px blur over 500ms, with a 40ms stagger. */
  function fadeUp(tl, els, at, o) {
    o = o || {}; var t = T.reveal, list = $$(els);
    var dur = D(o, pick(o.duration, t.dur)), st = D(o, pick(o.stagger, t.stagger)), ease = E(o.ease || t.ease);
    list.forEach(function (el, i) {
      var s = S(el, o);
      var from = { opacity: 0, y: pick(o.distance, t.distance) * s, filter: blur(pick(o.blur, t.blur) * s) };
      prime(el, from);
      ft(tl, el, from, { opacity: 1, y: 0, filter: blur(0), duration: dur, ease: ease }, at + i * st);
    });
    return at + Math.max(0, list.length - 1) * st + dur;
  }

  /** fadeOut(tl, els, at, o): texts-reveal exit. One quiet 200ms opacity fade, with no reverse movement. */
  function fadeOut(tl, els, at, o) {
    o = o || {}; var t = T.reveal, dur = D(o, pick(o.duration, t.exit));
    $$(els).forEach(function (el) { prime(el, { opacity: 1 }); ft(tl, el, { opacity: 1 }, { opacity: 0, duration: dur, ease: E(o.ease || t.exitEase) }, at); });
    return at + dur;
  }

  /* ======================================================================
     TEXT & NUMBERS
     ====================================================================== */

  /**
   * numberPop(tl, el, {from, to, at, format, steps, every, only, dirX, dirY}):
   * Number pop-in. Each character re-enters from 8px below through a 2px blur over 500ms
   * (popDigit ease). The last two characters lag by 70ms and 140ms.
   * steps > 1 ticks through the intermediate values. When steps > 1, only changed digits re-pop.
   */
  function numberPop(tl, el, o) {
    el = $(el); o = o || {};
    var t = T.digit, at = o.at || 0, s = S(el, o);
    var fmt = o.format || function (v) { return String(v); };
    var isNum = typeof o.from === 'number' && typeof o.to === 'number';
    var steps = isNum ? Math.max(1, o.steps || 1) : 1;
    var every = D(o, pick(o.every, 0.12));
    var vals = [];
    for (var k = 1; k <= steps; k++) vals.push(isNum ? fmt(o.from + (o.to - o.from) * k / steps) : fmt(o.to));
    var start = o.from != null ? fmt(o.from) : textOf(el);
    var dist = pick(o.distance, t.distance) * s, bl = pick(o.blur, t.blur) * s;
    var dirX = pick(o.dirX, 0), dirY = pick(o.dirY, 1);
    var dur = D(o, pick(o.duration, t.dur)), stg = D(o, pick(o.stagger, t.stagger));
    var ef = EF(o.ease || t.ease);
    var changedOnly = (o.only || (steps > 1 ? 'changed' : 'all')) === 'changed';

    function build(str) {
      if (el.__kmStr === str) return;
      el.__kmStr = str;
      while (el.firstChild) el.removeChild(el.firstChild);
      for (var i = 0; i < str.length; i++) el.appendChild(span('km-digit', str[i]));
    }
    function render(str, prev, local) {
      build(str);
      var n = str.length, kids = el.children;
      for (var i = 0; i < n; i++) {
        var sp = kids[i];
        var delay = i === n - 1 ? 2 * stg : (i === n - 2 ? stg : 0);
        var j = prev != null ? prev.length - (n - i) : -1;
        var still = changedOnly && j >= 0 && prev[j] === str[i];
        var e = still ? 1 : ef(clamp01((local - delay) / dur));
        var r = 1 - e;
        sp.style.transform = r ? 'translate(' + (dist * dirX * r).toFixed(3) + 'px,' + (dist * dirY * r).toFixed(3) + 'px)' : '';
        sp.style.opacity = e >= 1 ? '' : String(Math.max(0, e));
        sp.style.filter = r > 0 ? blur(bl * r) : '';
      }
    }
    var total = (steps - 1) * every + 2 * stg + dur;
    if (!texts.has(el)) render(start, null, Infinity);
    drive(tl, at, total, function (p) {
      if (p <= 0) { render(start, null, Infinity); return; }
      var tt = p * total;
      var idx = Math.min(steps - 1, Math.floor(tt / every));
      render(vals[idx], idx ? vals[idx - 1] : start, tt - idx * every);
    });
    texts.set(el, vals[steps - 1]);
    return at + total;
  }

  /**
   * textSwap(tl, el, newText, at, o): Text states swap. The old text exits 4px up through
   * a 2px blur. The new text then enters from 4px below. Each half takes 150ms (ease-in-out).
   * Use it on a plain text element.
   */
  function textSwap(tl, el, next, at, o) {
    el = $(el); o = o || {};
    var t = T.textSwap, s = S(el, o), prev = o.from != null ? String(o.from) : textOf(el);
    var d = pick(o.distance, t.distance) * s, b = pick(o.blur, t.blur) * s;
    var dur = D(o, pick(o.duration, t.dur)), ease = E(o.ease || t.ease);
    inlineBlock(el);
    var rest = { y: 0, opacity: 1, filter: blur(0) };
    prime(el, rest);
    if (!texts.has(el)) el.textContent = prev;
    ft(tl, el, assign({}, rest), { y: -d, opacity: 0, filter: blur(b), duration: dur, ease: ease }, at);
    drive(tl, at, 2 * dur, function (p) { var v = p < 0.5 ? prev : next; if (el.textContent !== v) el.textContent = v; });
    ft(tl, el, { y: d, opacity: 0, filter: blur(b) }, { y: 0, opacity: 1, filter: blur(0), duration: dur, ease: ease }, at + dur);
    texts.set(el, next);
    return at + 2 * dur;
  }

  /**
   * typeText(tl, el, text, at, {cps, prefix, caret, caretFrom, caretUntil, placeholder, seed}):
   * Realistic typing. The rhythm varies from key to key and is seeded per string. Spaces
   * are a little slower, a pause follows punctuation, and there is an occasional
   * hesitation. The average speed is exactly `cps`. The caret stays solid while typing and
   * for 0.5s afterwards, then blinks (530ms on, 530ms off) until `caretUntil`
   * (default: 1.2s after the last key). An optional placeholder element hides on the first
   * key. Returns the time of the last keystroke.
   */
  function typeText(tl, el, text, at, o) {
    el = $(el); o = o || {}; text = String(text);
    var t = T.type, cps = pick(o.cps, t.cps), prefix = o.prefix || '';
    var n = text.length;
    var rnd = prng(hashStr(text) ^ (o.seed || 0));
    var iv = [], sum = 0, i;
    for (i = 0; i < n; i++) {
      var k = 0.55 + rnd() * 0.9;
      if (text[i] === ' ') k *= 1.2;
      if (i > 0 && /[.,!?;:]/.test(text[i - 1])) k *= 2.4;
      if (rnd() < 0.05) k *= 2.2;
      iv.push(k); if (i > 0) sum += k;
    }
    var span0 = n > 1 ? (n - 1) / cps : 0;
    var times = [0];
    for (i = 1; i < n; i++) times.push(times[i - 1] + (sum ? iv[i] * span0 / sum : 0));
    var typeDur = Math.max(times[n - 1] || 0, 1 / cps);
    var end = at + (times[n - 1] || 0);

    var typed = el.querySelector(':scope > .km-typed');
    if (!typed) { el.textContent = ''; typed = span('km-typed'); el.appendChild(typed); }
    var caret = null;
    if (o.caret !== false) {
      caret = el.querySelector(':scope > .km-caret');
      if (!caret) { caret = span('km-caret'); el.appendChild(caret); }
    }
    var ph = o.placeholder ? $(o.placeholder) : null;
    var base = texts.has(el) ? textOf(el) : prefix;
    if (!texts.has(el)) typed.textContent = base;

    function count(tt) { // number of chars typed by local time tt
      var lo = 0, hi = n;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (times[mid] < tt) lo = mid + 1; else hi = mid; }
      return lo;
    }
    drive(tl, at, typeDur, function (p) {
      var c = p <= 0 ? 0 : p >= 1 ? n : count(p * typeDur);
      var v = base + text.slice(0, c);
      if (typed.textContent !== v) typed.textContent = v;
      if (ph) ph.style.opacity = v.length ? '0' : '';
    });

    if (caret) {
      var cFrom = pick(o.caretFrom, at), cUntil = pick(o.caretUntil, end + t.caretTail);
      var solidEnd = end + t.solidAfter, blink = t.blink;
      var pre = cFrom > 1 / 60 ? 1 / 60 : 0;   // p = 0 must mean "caret not shown yet"
      var d0 = cFrom - pre, len = Math.max(cUntil - d0, 1e-3);
      if (!primed.has(caret)) { primed.set(caret, true); caret.style.opacity = pre ? '0' : '1'; }
      drive(tl, d0, len, function (p) {
        var tt = d0 + p * len, on;
        if (tt < cFrom || tt >= cUntil) on = false;
        else if (tt >= at && tt < solidEnd) on = true;
        else { var ph0 = tt < at ? cFrom : solidEnd; on = Math.floor((tt - ph0) / blink + 1e-6) % 2 === 0; }
        caret.style.opacity = on ? '1' : '0';
      });
    }
    texts.set(el, base + text);
    return end;
  }

  /**
   * streamText(tl, el, text|null, at, {wordsPerSec, fade, blur, chunks}):
   * Streaming text. The words are laid out up front, so nothing reflows. Each word then
   * resolves through opacity and a 1px blur over 350ms, one every 60ms (16.7 words/s).
   * text = null streams the element's existing markup word by word. chunks:true groups
   * words into 1–3-word token bursts (seeded).
   */
  function streamText(tl, el, text, at, o) {
    el = $(el); o = o || {};
    var t = T.stream, s = S(el, o);
    if (text != null) { el.textContent = String(text); el.__kmWords = null; }
    var words = el.__kmWords;
    if (!words) {
      words = [];
      var walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */, null), nodes = [], nd;
      while ((nd = walker.nextNode())) nodes.push(nd);
      nodes.forEach(function (node) {
        var parts = node.nodeValue.split(/(\s+)/), frag = doc.createDocumentFragment();
        parts.forEach(function (p) {
          if (!p) return;
          if (/^\s+$/.test(p)) frag.appendChild(doc.createTextNode(p));
          else { var w = span('km-w', p); frag.appendChild(w); words.push(w); }
        });
        node.parentNode.replaceChild(frag, node);
      });
      el.__kmWords = words;
    }
    var n = words.length; if (!n) return at;
    var gap = D(o, o.wordsPerSec ? 1 / o.wordsPerSec : t.gap), fade = D(o, pick(o.fade, t.fade));
    var bl = pick(o.blur, t.blur) * s, ef = EF(o.ease || t.ease);
    var offs = [], i;
    if (o.chunks) {
      var rnd = prng(hashStr(el.textContent) ^ (o.seed || 0)), tt0 = 0; i = 0;
      while (i < n) { var size = 1 + Math.floor(rnd() * 3); for (var j = 0; j < size && i < n; j++) offs[i++] = tt0; tt0 += size * gap * (0.7 + 0.6 * rnd()); }
    } else for (i = 0; i < n; i++) offs[i] = i * gap;
    var total = offs[n - 1] + fade, last = [];
    words.forEach(function (w) { if (!primed.has(w)) { primed.set(w, true); w.style.opacity = '0'; w.style.filter = blur(bl); } });
    drive(tl, at, total, function (p) {
      var tt = p * total;
      for (var k = 0; k < n; k++) {
        var lp = (tt - offs[k]) / fade, e = lp <= 0 ? 0 : lp >= 1 ? 1 : ef(lp);
        if (e === last[k]) continue; last[k] = e;
        words[k].style.opacity = e >= 1 ? '' : String(e);
        words[k].style.filter = e >= 1 ? '' : blur(bl * (1 - e));
      }
    });
    return at + total;
  }

  /**
   * shimmer(tl, el, at, until, {period}): Shimmer text. A highlight band sweeps the glyphs
   * every 2s (linear). Colours come from --km-shimmer-base and --km-shimmer-hi on the element.
   * The run is rounded up to whole cycles, so the band never vanishes mid-sweep.
   * Works on a thinkingSwap box too: every line shimmers. Returns the actual end time.
   */
  function shimmer(tl, el, at, until, o) {
    el = $(el); o = o || {};
    var period = D(o, pick(o.period, T.shimmer.period));
    var lines = el.querySelectorAll('.km-think-line');
    if (lines.length) {
      el.__kmShimmer = true;
      Array.prototype.forEach.call(lines, function (l) { l.classList.add('km-shimmer'); l.setAttribute('data-text', l.textContent); });
    } else {
      el.classList.add('km-shimmer');
      if (!el.hasAttribute('data-text')) el.setAttribute('data-text', el.textContent);
    }
    var len = Math.max(1, Math.ceil((until - at) / period - 1e-6)) * period;
    if (!el.style.getPropertyValue('--km-shimmer-x')) el.style.setProperty('--km-shimmer-x', '100.000%'); // band parked off-text
    drive(tl, at, len, function (p) {
      var ph = p <= 0 || p >= 1 ? 0 : ((p * len) % period) / period;
      el.style.setProperty('--km-shimmer-x', (100 - 100 * ph).toFixed(3) + '%');
    });
    return at + len;
  }

  /**
   * thinkingSwap(tl, box, newText, at, o): Thinking states. The status line swaps in place.
   * The old line exits 8px up through a 2px blur while the new line rises from 8px below,
   * 50ms later (150ms each, ease-in-out). The lines are stacked, so the two halves overlap.
   */
  function thinkingSwap(tl, box, next, at, o) {
    box = $(box); o = o || {};
    var t = T.think, s = S(box, o);
    var st = box.__kmThink;
    if (!st) {
      var txt = box.textContent.trim(); box.textContent = ''; box.classList.add('km-think');
      var sizer = span('km-think-sizer', txt), line0 = span('km-think-line', txt);
      box.appendChild(sizer); box.appendChild(line0);
      st = box.__kmThink = { sizer: sizer, live: line0 };
    }
    var d = pick(o.distance, t.distance) * s, b = pick(o.blur, t.blur) * s;
    var dur = D(o, pick(o.duration, t.swap)), gap = D(o, pick(o.gap, t.gap)), ease = E(o.ease || t.ease);
    var old = st.live, nu = span(old.className, next);
    if (box.__kmShimmer || old.hasAttribute('data-text')) nu.setAttribute('data-text', next);
    box.appendChild(nu);
    if (next.length > st.sizer.textContent.length) st.sizer.textContent = next;
    var rest = { y: 0, opacity: 1, filter: blur(0) }, below = { y: d, opacity: 0, filter: blur(b) };
    prime(old, rest); prime(nu, below);
    ft(tl, old, assign({}, rest), { y: -d, opacity: 0, filter: blur(b), duration: dur, ease: ease }, at);
    ft(tl, nu, assign({}, below), { y: 0, opacity: 1, filter: blur(0), duration: dur, ease: ease }, at + gap);
    st.live = nu;
    return at + gap + dur;
  }

  /* ======================================================================
     ICONS & STATUS
     ====================================================================== */

  /** iconSwap(tl, iconOut, iconIn, at, o): Icon swap. The two stacked icons cross through scale 0.25 and a 2px blur over 250ms (ease-in-out). */
  function iconSwap(tl, a, b, at, o) {
    a = $(a); b = $(b); o = o || {};
    var t = T.icon, s = S(a, o), dur = D(o, pick(o.duration, t.dur)), ease = E(o.ease || t.ease);
    var on = { opacity: 1, scale: 1, filter: blur(0), transformOrigin: '50% 50%' };
    var off = { opacity: 0, scale: pick(o.scale, t.scale), filter: blur(pick(o.blur, t.blur) * s), transformOrigin: '50% 50%' };
    prime(a, on); prime(b, off);
    ft(tl, a, assign({}, on), assign({ duration: dur, ease: ease }, off), at);
    ft(tl, b, assign({}, off), assign({ duration: dur, ease: ease }, on), at);
    return at + dur;
  }

  /**
   * successCheck(tl, target, at, o): Success check. target is the <svg> (or a wrapper),
   * or the check path itself. The wrapper fades in (500ms), unrotates from 80deg, unblurs
   * from 10px and bobs up from 40px (bob ease). The path draws over 500ms after an 80ms delay.
   */
  function successCheck(tl, target, at, o) {
    var el = $(target); o = o || {};
    var t = T.check, path, wrap;
    if (/^(path|polyline|line|circle)$/i.test(el.tagName)) { path = el; wrap = $(o.wrapper) || el.ownerSVGElement; }
    else { wrap = el; path = $(o.path) || el.querySelector('path, polyline'); }
    var s = S(wrap, o), dur = D(o, pick(o.duration, t.dur)), ease = E(o.ease || t.ease);
    var len = pathLen(path), y = pick(o.y, t.y) * s, rot = pick(o.rotate, t.rotate), bl = pick(o.blur, t.blur) * s;
    prime(wrap, { opacity: 0, rotation: rot, y: y, filter: blur(bl), transformOrigin: '50% 50%' });
    prime(path, { strokeDashoffset: len });
    ft(tl, wrap, { opacity: 0 }, { opacity: 1, duration: dur, ease: ease }, at);
    ft(tl, wrap, { rotation: rot }, { rotation: 0, duration: dur, ease: ease }, at);
    ft(tl, wrap, { filter: blur(bl) }, { filter: blur(0), duration: dur, ease: ease }, at);
    ft(tl, wrap, { y: y }, { y: 0, duration: dur, ease: E(t.bobEase) }, at);
    var pd = D(o, t.pathDelay);
    ft(tl, path, { strokeDashoffset: len }, { strokeDashoffset: 0, duration: dur, ease: ease }, at + pd);
    return at + pd + dur;
  }

  /**
   * badgeIn(tl, badge, at, {dot}): Notification badge. The wrapper slides in diagonally
   * from (-8.2px, 12.4px) over 260ms. The dot pops from scale 0 (500ms, pop ease), fades
   * in (400ms) and unblurs from 2px. The trigger never moves.
   */
  function badgeIn(tl, badge, at, o) {
    var wrap = $(badge); o = o || {};
    var t = T.badge, dot = $(o.dot) || wrap.firstElementChild || wrap, s = S(wrap, o);
    var dx = t.dx * s, dy = t.dy * s, bl = pick(o.blur, t.blur) * s;
    var pop = E(t.popEase), popF = EF(t.popEase);
    var popClamped = function (p) { return Math.min(1, popF(p)); }; // CSS clamps blur/opacity overshoot; match it
    prime(wrap, { x: dx, y: dy });
    prime(dot, { scale: 0, opacity: 0, filter: blur(bl), transformOrigin: '50% 50%' });
    ft(tl, wrap, { x: dx, y: dy }, { x: 0, y: 0, duration: D(o, t.slide), ease: E(t.slideEase) }, at);
    ft(tl, dot, { scale: 0 }, { scale: 1, duration: D(o, t.pop), ease: pop }, at);
    ft(tl, dot, { opacity: 0 }, { opacity: 1, duration: D(o, t.fade), ease: popClamped }, at);
    ft(tl, dot, { filter: blur(bl) }, { filter: blur(0), duration: D(o, t.pop), ease: popClamped }, at);
    return at + D(o, t.pop);
  }

  /** badgeOut(tl, badge, at, {dot}): the dot shrinks to 0, fades and blurs over 180ms (standard ease). */
  function badgeOut(tl, badge, at, o) {
    var wrap = $(badge); o = o || {};
    var t = T.badge, dot = $(o.dot) || wrap.firstElementChild || wrap, s = S(wrap, o), dur = D(o, t.close);
    ft(tl, dot, { scale: 1, opacity: 1, filter: blur(0) }, { scale: 0, opacity: 0, filter: blur(t.blur * s), duration: dur, ease: E(t.closeEase) }, at);
    return at + dur;
  }

  /* ======================================================================
     SURFACES
     ====================================================================== */

  /** menuOpen(tl, menu, at, {origin}): Menu dropdown. Grows from scale 0.97 and fades in over 250ms, from the trigger-side origin. */
  function menuOpen(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.menu, org = origin(o.origin), dur = D(o, pick(o.duration, t.open));
    var from = { opacity: 0, scale: pick(o.scale, t.preScale), transformOrigin: org };
    prime(el, from);
    ft(tl, el, assign({}, from), { opacity: 1, scale: 1, transformOrigin: org, duration: dur, ease: E(o.ease || t.ease) }, at);
    return at + dur;
  }

  /** menuClose(tl, menu, at, {origin}): shrinks to scale 0.99 and fades out over 150ms. */
  function menuClose(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.menu, org = origin(o.origin), dur = D(o, pick(o.duration, t.close));
    prime(el, { opacity: 1, scale: 1, transformOrigin: org });
    ft(tl, el, { opacity: 1, scale: 1, transformOrigin: org }, { opacity: 0, scale: t.closingScale, transformOrigin: org, duration: dur, ease: E(o.ease || t.ease) }, at);
    return at + dur;
  }

  /** modalOpen(tl, modal, at, {backdrop, backdropOpacity}): Modal. Scales up from 0.96 at the centre over 250ms; an optional backdrop fades with it. */
  function modalOpen(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.modal, dur = D(o, pick(o.duration, t.open)), ease = E(o.ease || t.ease);
    var from = { opacity: 0, scale: t.scale, transformOrigin: '50% 50%' };
    prime(el, from);
    ft(tl, el, assign({}, from), { opacity: 1, scale: 1, transformOrigin: '50% 50%', duration: dur, ease: ease }, at);
    if (o.backdrop) { var bd = $(o.backdrop); prime(bd, { opacity: 0 }); ft(tl, bd, { opacity: 0 }, { opacity: pick(o.backdropOpacity, 1), duration: dur, ease: ease }, at); }
    return at + dur;
  }

  /** modalClose(tl, modal, at, {backdrop}): dips to scale 0.96 and fades out over 150ms. */
  function modalClose(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.modal, dur = D(o, pick(o.duration, t.close)), ease = E(o.ease || t.ease);
    ft(tl, el, { opacity: 1, scale: 1, transformOrigin: '50% 50%' }, { opacity: 0, scale: t.closeScale, transformOrigin: '50% 50%', duration: dur, ease: ease }, at);
    if (o.backdrop) ft(tl, $(o.backdrop), { opacity: pick(o.backdropOpacity, 1) }, { opacity: 0, duration: dur, ease: ease }, at);
    return at + dur;
  }

  /** panelReveal(tl, panel, at, {distance}): Panel reveal. Rises 100px through a 2px blur and fades in over 400ms. */
  function panelReveal(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.panel, s = S(el, o), dur = D(o, pick(o.duration, t.open));
    var from = { y: pick(o.distance, t.distance) * s, opacity: 0, filter: blur(pick(o.blur, t.blur) * s) };
    prime(el, from);
    ft(tl, el, assign({}, from), { y: 0, opacity: 1, filter: blur(0), duration: dur, ease: E(o.ease || t.ease) }, at);
    return at + dur;
  }

  /** panelHide(tl, panel, at, o): the reverse of panelReveal, over 350ms. */
  function panelHide(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.panel, s = S(el, o), dur = D(o, pick(o.duration, t.close));
    ft(tl, el, { y: 0, opacity: 1, filter: blur(0) }, { y: pick(o.distance, t.distance) * s, opacity: 0, filter: blur(pick(o.blur, t.blur) * s), duration: dur, ease: E(o.ease || t.ease) }, at);
    return at + dur;
  }

  /** toastIn(tl, toast, at, o): Toast. Rises 16px from scale 0.97 through a 2px blur and fades in over 350ms. */
  function toastIn(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.toast, s = S(el, o), dur = D(o, pick(o.duration, t.open));
    var from = { y: pick(o.distance, t.distance) * s, scale: t.scale, opacity: 0, filter: blur(t.blur * s) };
    prime(el, from);
    ft(tl, el, assign({}, from), { y: 0, scale: 1, opacity: 1, filter: blur(0), duration: dur, ease: E(o.ease || t.ease) }, at);
    return at + dur;
  }

  /** toastOut(tl, toast, at, o): the reverse of toastIn, over the faster 250ms close clock. */
  function toastOut(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.toast, s = S(el, o), dur = D(o, pick(o.duration, t.close));
    ft(tl, el, { y: 0, scale: 1, opacity: 1, filter: blur(0) }, { y: pick(o.distance, t.distance) * s, scale: t.scale, opacity: 0, filter: blur(t.blur * s), duration: dur, ease: E(o.ease || t.ease) }, at);
    return at + dur;
  }

  /** tooltipIn(tl, tip, at, o): Tooltip. After an 80ms delay it fades in and grows from scale 0.98 at the bottom-centre over 150ms (ease-out). */
  function tooltipIn(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.tooltip, dur = D(o, t.in), dl = D(o, pick(o.delay, t.delay)), org = origin(o.origin || 'bottom-center');
    var from = { opacity: 0, scale: t.scale, transformOrigin: org };
    prime(el, from);
    ft(tl, el, assign({}, from), { opacity: 1, scale: 1, transformOrigin: org, duration: dur, ease: E(t.ease) }, at + dl);
    return at + dl + dur;
  }

  /** tooltipOut(tl, tip, at, o): disappears at once (50ms, no delay). */
  function tooltipOut(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.tooltip, dur = D(o, t.out), org = origin(o.origin || 'bottom-center');
    ft(tl, el, { opacity: 1, scale: 1, transformOrigin: org }, { opacity: 0, scale: t.scale, transformOrigin: org, duration: dur, ease: E(t.ease) }, at);
    return at + dur;
  }

  /**
   * pageSwap(tl, pageOut, pageIn, at, {dir}): Page side-by-side. Both pages move 8px
   * sideways through a 3px blur with a cross-fade, over 250ms. dir 1 = forward
   * (the old page leaves to the left), -1 = back.
   */
  function pageSwap(tl, a, b, at, o) {
    a = $(a); b = $(b); o = o || {};
    var t = T.page, s = S(a, o), dir = pick(o.dir, 1), dist = pick(o.distance, t.distance) * s, bl = pick(o.blur, t.blur) * s;
    var dur = D(o, pick(o.duration, t.dur)), ease = E(o.ease || t.ease);
    var rest = { x: 0, opacity: 1, filter: blur(0) }, enter = { x: dist * dir, opacity: 0, filter: blur(bl) };
    prime(a, rest); prime(b, enter);
    ft(tl, a, assign({}, rest), { x: -dist * dir, opacity: 0, filter: blur(bl), duration: dur, ease: ease }, at);
    ft(tl, b, assign({}, enter), { x: 0, opacity: 1, filter: blur(0), duration: dur, ease: ease }, at);
    return at + dur;
  }

  /** cardResize(tl, el, at, {width, height, from}): Card resize. Tweens the box to a new width and/or height over 300ms (out ease). */
  function cardResize(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.resize, dur = D(o, pick(o.duration, t.dur)), cs = root.getComputedStyle(el);
    var cur = o.from || sizes.get(el) || { width: parseFloat(cs.width), height: parseFloat(cs.height) };
    var to = { width: pick(o.width, cur.width), height: pick(o.height, cur.height) };
    prime(el, { width: cur.width, height: cur.height });
    ft(tl, el, { width: cur.width, height: cur.height }, { width: to.width, height: to.height, duration: dur, ease: E(o.ease || t.ease) }, at);
    sizes.set(el, to);
    return at + dur;
  }

  /** skeletonPulse(tl, skeleton, at, {count, targets}): the skeleton's bars dim to 0.5 and back, once per second (ease-in-out per half). */
  function skeletonPulse(tl, skel, at, o) {
    skel = $(skel); o = o || {};
    var t = T.skeleton, kids = o.targets ? $$(o.targets) : Array.prototype.slice.call(skel.children);
    var dur = D(o, pick(o.duration, t.pulse)), half = dur / 2, n = pick(o.count, 1), ease = E(t.ease);
    for (var c = 0; c < n; c++) {
      ft(tl, kids, { opacity: 1 }, { opacity: t.pulseMin, duration: half, ease: ease }, at + c * dur);
      ft(tl, kids, { opacity: t.pulseMin }, { opacity: 1, duration: half, ease: ease }, at + c * dur + half);
    }
    return at + n * dur;
  }

  /** skeletonReveal(tl, skeleton, content, at, o): Skeleton reveal. The two layers cross-fade with a matching 2px cross-blur over 400ms (ease-in-out). */
  function skeletonReveal(tl, skel, content, at, o) {
    skel = $(skel); content = $(content); o = o || {};
    var t = T.skeleton, s = S(skel, o), dur = D(o, pick(o.duration, t.reveal)), ease = E(o.ease || t.ease), bl = t.blur * s;
    prime(skel, { opacity: 1, filter: blur(0) }); prime(content, { opacity: 0, filter: blur(bl) });
    ft(tl, skel, { opacity: 1, filter: blur(0) }, { opacity: 0, filter: blur(bl), duration: dur, ease: ease }, at);
    ft(tl, content, { opacity: 0, filter: blur(bl) }, { opacity: 1, filter: blur(0), duration: dur, ease: ease }, at);
    return at + dur;
  }

  /* ======================================================================
     CONTROLS
     ====================================================================== */

  /** errorShake(tl, el, at, {message, border, errorColor, hold}): Error state shake. Legs: +6, -6, +4 (overshoot), 0px, taking 80/80/60/60ms. Optional: the border turns to the error colour (150ms), a message reveals (280ms), and both revert after `hold` seconds. */
  function errorShake(tl, el, at, o) {
    el = $(el); o = o || {};
    var t = T.shake, s = S(el, o), d = pick(o.distance, t.distance) * s, ov = pick(o.overshoot, t.overshoot) * s;
    var a = D(o, t.a), b = D(o, t.b), ease = E(t.ease);
    prime(el, { x: 0 });
    ft(tl, el, { x: 0 }, { x: d, duration: a, ease: ease }, at);
    ft(tl, el, { x: d }, { x: -d, duration: a, ease: ease }, at + a);
    ft(tl, el, { x: -d }, { x: ov, duration: b, ease: ease }, at + 2 * a);
    ft(tl, el, { x: ov }, { x: 0, duration: b, ease: ease }, at + 2 * a + b);
    var shakeEnd = at + 2 * a + 2 * b, rv = D(o, t.revert), rEase = E(t.revertEase);
    var bEl = o.errorColor ? $(o.border) || el : null, base = bEl ? root.getComputedStyle(bEl).borderColor : null;
    var msg = o.message ? $(o.message) : null;
    if (bEl) ft(tl, bEl, { borderColor: base }, { borderColor: o.errorColor, duration: D(o, t.border), ease: rEase }, at);
    if (msg) { prime(msg, { opacity: 0 }); ft(tl, msg, { opacity: 0 }, { opacity: 1, duration: rv, ease: rEase }, at); }
    if (o.hold != null) {
      var r = shakeEnd + o.hold;
      if (bEl) ft(tl, bEl, { borderColor: o.errorColor }, { borderColor: base, duration: rv, ease: rEase }, r);
      if (msg) ft(tl, msg, { opacity: 1 }, { opacity: 0, duration: rv, ease: rEase }, r);
      return r + rv;
    }
    return Math.max(shakeEnd, msg ? at + rv : 0);
  }

  /** tabSlide(tl, pill, tab, at, {prev, activeColor, mutedColor}): Tabs sliding. The pill moves to the tab's offsetLeft and offsetWidth over 250ms; the labels cross-fade colour. */
  function tabSlide(tl, pill, tab, at, o) {
    pill = $(pill); tab = $(tab); o = o || {};
    var t = T.tabs, dur = D(o, pick(o.duration, t.dur)), ease = E(o.ease || t.ease);
    var from = pills.get(pill) || o.from || { x: gsap.getProperty(pill, 'x'), width: parseFloat(root.getComputedStyle(pill).width) };
    var to = o.to || { x: tab.offsetLeft, width: tab.offsetWidth };
    prime(pill, { x: from.x, width: from.width });
    ft(tl, pill, { x: from.x, width: from.width }, { x: to.x, width: to.width, duration: dur, ease: ease }, at);
    if (o.prev && o.activeColor && o.mutedColor) {
      ft(tl, $(o.prev), { color: o.activeColor }, { color: o.mutedColor, duration: dur, ease: ease }, at);
      ft(tl, tab, { color: o.mutedColor }, { color: o.activeColor, duration: dur, ease: ease }, at);
    }
    pills.set(pill, to);
    return at + dur;
  }

  /** checkboxCheck(tl, box, at, {checked, path, from, to}): Checkbox. The box fill (CSS props from→to) runs 150ms, then the mark draws over 350ms. checked:false clears it in 150ms. */
  function checkboxCheck(tl, box, at, o) {
    box = $(box); o = o || {};
    var t = T.checkbox, ease = E(o.ease || t.ease), on = o.checked !== false;
    var path = $(o.path) || box.querySelector('path, polyline'), len = path.__kmLen || (path.__kmLen = pathLen(path));
    if (on) {
      prime(path, { strokeDashoffset: len });
      if (o.from && o.to) { prime(box, o.from); ft(tl, box, assign({}, o.from), assign({ duration: D(o, t.box), ease: ease }, o.to), at); }
      var dl = D(o, t.delay), dd = D(o, t.draw);
      ft(tl, path, { strokeDashoffset: len }, { strokeDashoffset: 0, duration: dd, ease: ease }, at + dl);
      return at + dl + dd;
    }
    var du = D(o, t.uncheck);
    if (o.from && o.to) ft(tl, box, assign({}, o.to), assign({ duration: du, ease: ease }, o.from), at);
    ft(tl, path, { strokeDashoffset: 0 }, { strokeDashoffset: len, duration: du, ease: ease }, at);
    return at + du;
  }

  /** toggle(tl, thumb, at, {on, travel, track, onColor, offColor}): Toggle. The thumb travels with a 1px overshoot (keyframe segments 55/25/20% of 350ms, bob ease on each); the track colour flips instantly. */
  function toggle(tl, thumb, at, o) {
    thumb = $(thumb); o = o || {};
    var t = T.toggle, s = S(thumb, o), on = o.on !== false;
    var tr = pick(o.travel, t.travel * s), ov1 = t.ov1 * s, ov2 = t.ov2 * s, dur = D(o, pick(o.duration, t.dur)), ease = E(o.ease || t.ease);
    var a = on ? 0 : tr, k1 = on ? tr + ov1 : -ov1, k2 = on ? tr - ov2 : ov2, z = on ? tr : 0;
    prime(thumb, { x: a });
    ft(tl, thumb, { x: a }, { x: k1, duration: dur * 0.55, ease: ease }, at);
    ft(tl, thumb, { x: k1 }, { x: k2, duration: dur * 0.25, ease: ease }, at + dur * 0.55);
    ft(tl, thumb, { x: k2 }, { x: z, duration: dur * 0.2, ease: ease }, at + dur * 0.8);
    if (o.track && o.onColor && o.offColor) {
      var tk = $(o.track), c0 = on ? o.offColor : o.onColor, c1 = on ? o.onColor : o.offColor;
      prime(tk, { backgroundColor: c0 });
      ft(tl, tk, { backgroundColor: c0 }, { backgroundColor: c1, duration: Math.max(D(o, pick(o.trackDuration, t.track)), 1e-3), ease: 'none' }, at);
    }
    return at + dur;
  }

  /** avatarLift(tl, avatars, index|null, at, o): Avatar group hover. The hovered avatar lifts 4px and scales to 1.05; its neighbours lift by 0.45^distance (320ms). index null releases them all with the spring ease. */
  function avatarLift(tl, avatars, index, at, o) {
    o = o || {}; var t = T.avatar, list = $$(avatars), dur = D(o, pick(o.duration, t.dur));
    var ease = E(o.ease || (index == null ? t.easeOut : t.easeIn));
    list.forEach(function (el, i) {
      var s = S(el, o), cur = lifts.get(el) || { y: 0, scale: 1 };
      var to = index == null ? { y: 0, scale: 1 } : { y: t.lift * s * Math.pow(t.falloff, Math.abs(i - index)), scale: i === index ? t.scale : 1 };
      prime(el, { y: cur.y, scale: cur.scale });
      ft(tl, el, { y: cur.y, scale: cur.scale }, { y: to.y, scale: to.scale, duration: dur, ease: ease }, at);
      lifts.set(el, to);
    });
    return at + dur;
  }

  /* ======================================================================
     POINTER (library addition: macOS pointer)
     ====================================================================== */

  /**
   * cursorMoveClick(tl, cursor, {x, y}, at, {duration, click, from, target, hand, hotspot}):
   * Moves a macOS pointer along a gentle arc (x on power2.inOut, y on sine.inOut). The time
   * scales with distance (0.45–1.0s). The pointer settles for 60ms, then presses (scale 0.9
   * for 60ms, hold 40ms, release 120ms). `target` gets a matching pressed state (scale 0.97).
   * hand:true switches the pointer to the hand (.is-hand) for the last 15% of the move.
   * Returns the click time (mouse-up), the moment a web UI reacts. With click:false it
   * returns the arrival time.
   */
  function cursorMoveClick(tl, cursor, pt, at, o) {
    var c = $(cursor); o = o || {};
    var t = T.cursor;
    var st = points.get(c) || (o.from ? { x: o.from.x, y: o.from.y, hand: false } : { x: gsap.getProperty(c, 'x'), y: gsap.getProperty(c, 'y'), hand: false });
    var primeVars = { x: st.x, y: st.y };
    if (o.hotspot) primeVars.transformOrigin = o.hotspot;
    prime(c, primeVars);
    var dist = Math.sqrt(Math.pow(pt.x - st.x, 2) + Math.pow(pt.y - st.y, 2));
    var dur = D(o, pick(o.duration, Math.min(t.maxDur, Math.max(t.minDur, 0.42 + dist / 2200))));
    if (dist > 0.5) {
      ft(tl, c, { x: st.x }, { x: pt.x, duration: dur, ease: E(t.ease) }, at);
      ft(tl, c, { y: st.y }, { y: pt.y, duration: dur, ease: o.arc === false ? E(t.ease) : 'sine.inOut' }, at);
    } else dur = 0;
    var hand = !!o.hand, wasHand = st.hand;
    if (hand || wasHand) {   // arrow while travelling, hand once over the target
      drive(tl, at, Math.max(dur, 1e-3), function (p) {
        var h = p <= 0 ? wasHand : (hand && p >= 0.85);
        if (c.classList.contains('is-hand') !== h) c.classList.toggle('is-hand', h);
      });
    }
    points.set(c, { x: pt.x, y: pt.y, hand: hand });
    var arrive = at + dur;
    if (o.click === false) return arrive;
    var press = arrive + D(o, t.settle), pd = D(o, t.press), hd = D(o, t.hold), rd = D(o, t.release);
    ft(tl, c, { scale: 1 }, { scale: t.pressScale, duration: pd, ease: 'power2.out' }, press);
    ft(tl, c, { scale: t.pressScale }, { scale: 1, duration: rd, ease: 'power2.out' }, press + pd + hd);
    if (o.target) {
      var tg = $(o.target), ts = pick(o.targetScale, t.targetScale);
      ft(tl, tg, { scale: 1 }, { scale: ts, duration: pd, ease: 'power2.out' }, press);
      ft(tl, tg, { scale: ts }, { scale: 1, duration: D(o, 0.15), ease: E('out') }, press + pd + hd);
    }
    return press + pd + hd;
  }

  /** cursorMove(tl, cursor, {x, y}, at, o): cursorMoveClick without the click. Returns the arrival time. */
  function cursorMove(tl, cursor, pt, at, o) { return cursorMoveClick(tl, cursor, pt, at, assign({}, o, { click: false })); }

  /* ======================================================================
     PUBLIC API
     ====================================================================== */
  root.KitMotion = {
    version: '1.0.0',
    tokens: { bezier: BEZIER, dur: DUR, transitions: T },
    easeName: E,            // KitMotion.easeName('out') -> 'kit-out' (also usable directly in tweens)
    ease: EF,               // KitMotion.ease('out')(0.5) -> eased value
    usingCustomEase: !!CE,
    config: function (c) { assign(CONFIG, c); return CONFIG; },
    drive: drive,
    // entrances / exits
    fadeUp: fadeUp, fadeOut: fadeOut,
    // text & numbers
    numberPop: numberPop, textSwap: textSwap, typeText: typeText, streamText: streamText,
    shimmer: shimmer, thinkingSwap: thinkingSwap,
    // icons & status
    iconSwap: iconSwap, successCheck: successCheck, badgeIn: badgeIn, badgeOut: badgeOut,
    // surfaces
    menuOpen: menuOpen, menuClose: menuClose, modalOpen: modalOpen, modalClose: modalClose,
    panelReveal: panelReveal, panelHide: panelHide, toastIn: toastIn, toastOut: toastOut,
    tooltipIn: tooltipIn, tooltipOut: tooltipOut, pageSwap: pageSwap, cardResize: cardResize,
    skeletonPulse: skeletonPulse, skeletonReveal: skeletonReveal,
    // controls
    errorShake: errorShake, tabSlide: tabSlide, checkboxCheck: checkboxCheck, toggle: toggle, avatarLift: avatarLift,
    // pointer
    cursorMoveClick: cursorMoveClick, cursorMove: cursorMove
  };
})(typeof window !== 'undefined' ? window : this);
