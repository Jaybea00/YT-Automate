/*!
 * Look: the finishing layer of the GTA 6 component library (craft v2).
 *
 * KitMotion (assets/kit/motion/motion.js) moves UI. Look makes it feel shot, lit and graded rather than
 * pasted on: film grain, vignette, bloom, directional motion blur, blur-in entrances, masked type reveals,
 * impact frames (flash + shake + RGB split), light leaks, gradient fills with a specular sheen, and count-ups.
 *
 * Every helper ADDS seekable tweens to the paused GSAP timeline you pass, at an ABSOLUTE time, and returns
 * its end time. Per-frame effects run through Look.drive (a getter/setter proxy that GSAP renders on every
 * seek, including suppressEvents seeks), never onUpdate. No Math.random, no Date, no timers: noise comes
 * from a hash of the frame number. For each element, call the helpers in time order.
 *
 *   <link rel="stylesheet" href="assets/kit/look/look.css" />
 *   <script src="assets/kit/look/look.js"></script>
 */
(function (root) {
  'use strict';
  var gsap = root.gsap;
  if (!gsap) throw new Error('Look: load gsap before look.js');
  var doc = root.document, NS = 'http://www.w3.org/2000/svg', FPS = 30, uid = 0, defs = null;

  function $(el) { return typeof el === 'string' ? doc.querySelector(el) : el; }
  function $$(el) {
    if (typeof el === 'string') return Array.prototype.slice.call(doc.querySelectorAll(el));
    if (el && el.length !== undefined && !el.nodeType) return Array.prototype.slice.call(el);
    return [el];
  }
  function hash(n) { // integer hash -> [0,1)
    n = n | 0; n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296;
  }
  function ease(e) { return typeof e === 'function' ? e : gsap.parseEase(e || 'none'); }
  function svgDefs() {
    if (defs) return defs;
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
    defs = doc.createElementNS(NS, 'defs'); svg.appendChild(defs); doc.body.appendChild(svg); return defs;
  }
  function node(tag, attrs, parent) {
    var n = doc.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n); return n;
  }
  function filterShell(id) {
    return node('filter', { id: id, x: '-60%', y: '-60%', width: '220%', height: '220%', 'color-interpolation-filters': 'sRGB' }, svgDefs());
  }

  /** drive(tl, at, dur, fn): fn(p) runs on every render with p in [0,1]; fn(0) is applied at build time. */
  function drive(tl, at, dur, fn) {
    var o = {}, v = 0;
    Object.defineProperty(o, 'p', { get: function () { return v; }, set: function (x) { v = x; fn(x); } });
    fn(0);
    tl.fromTo(o, { p: 0 }, { p: 1, duration: Math.max(dur, 1 / 120), ease: 'none', immediateRender: false }, at);
    return at + dur;
  }

  /**
   * install(tl, {root:'#root', duration, grain:.16, grainSize:384, vignette:.5, enabled:true, z:90})
   * Adds the finishing stack on top of everything: animated film grain + vignette.
   * Pass enabled:false for bg:"none" renders (a transparent overlay must not carry grain or vignette).
   */
  function install(tl, o) {
    o = o || {}; if (o.enabled === false) return null;
    var host = $(o.root || '#root'), D = o.duration || tl.duration() || 8;
    var wrap = doc.createElement('div'); wrap.className = 'lk-overlay'; wrap.style.zIndex = String(o.z || 90);
    var vig = null, grain = null;
    if ((o.vignette == null ? 0.5 : o.vignette) > 0) {
      vig = doc.createElement('div'); vig.className = 'lk-vignette'; vig.style.opacity = String(o.vignette == null ? 0.5 : o.vignette); wrap.appendChild(vig);
    }
    if ((o.grain == null ? 0.16 : o.grain) > 0) {
      var gs = o.grainSize || 384;
      grain = doc.createElement('div'); grain.className = 'lk-grain'; grain.style.opacity = String(o.grain == null ? 0.16 : o.grain);
      grain.style.backgroundSize = gs + 'px ' + gs + 'px'; wrap.appendChild(grain);
      var last = -1;
      drive(tl, 0, D, function (p) {
        var f = Math.floor(p * D * FPS + 1e-6); if (f === last) return; last = f;
        grain.style.backgroundPosition = Math.floor(hash(f * 2 + 1) * gs) + 'px ' + Math.floor(hash(f * 2 + 7919) * gs) + 'px';
      });
    }
    host.appendChild(wrap);
    return { el: wrap, vignette: vig, grain: grain };
  }

  /** bloom(el, {color:'#FE8E4E', strength:1, core:true}): soft light around bright type or shapes (static style). */
  function bloom(el, o) {
    o = o || {}; var c = o.color || '#ffffff', s = o.strength == null ? 1 : o.strength;
    var rgb = hexToRgb(c), a = function (x) { return 'rgba(' + rgb + ',' + Math.min(1, x * s).toFixed(3) + ')'; };
    var sh = (o.core === false ? '' : '0 0 1px rgba(255,255,255,' + (0.35 * s).toFixed(3) + '), ') +
      '0 0 14px ' + a(0.42) + ', 0 0 42px ' + a(0.28) + ', 0 0 110px ' + a(0.16);
    $$(el).forEach(function (n) { n.style.textShadow = sh; });
    return sh;
  }
  function hexToRgb(h) {
    h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16); return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }

  /** split(el, {by:'chars'|'words', mask:false}) -> {words:[], chars:[], inners:[]}. Masked words rise from a clip line. */
  function split(el, o) {
    o = o || {}; el = $(el); var text = el.textContent, words = [], chars = [], inners = [];
    el.textContent = '';
    text.split(/(\s+)/).forEach(function (tok) {
      if (!tok) return;
      if (/^\s+$/.test(tok)) { el.appendChild(doc.createTextNode(' ')); return; }
      var w = doc.createElement('span'); w.className = o.mask ? 'lk-mask' : 'lk-w';
      var inner = w;
      if (o.mask) { inner = doc.createElement('span'); inner.className = 'lk-in'; w.appendChild(inner); inners.push(inner); }
      if (o.by === 'chars') {
        tok.split('').forEach(function (ch) { var c = doc.createElement('span'); c.className = 'lk-c'; c.textContent = ch; inner.appendChild(c); chars.push(c); });
      } else inner.textContent = tok;
      el.appendChild(w); words.push(w);
    });
    return { words: words, chars: chars, inners: inners };
  }

  /**
   * enter(tl, el, at, {from:'blur'|'up'|'down'|'left'|'right'|'scale', dur:.55, dist:80, blur:14, scale:1.08, ease:'expo.out', stagger:0})
   * The premium entrance: transform + opacity + blur together. Directional entrances carry a matching
   * directional motion blur (SVG), so fast moves smear like a real camera instead of sliding crisp.
   */
  function enter(tl, el, at, o) {
    o = o || {}; var els = $$(el), from = o.from || 'blur', dur = o.dur || 0.55, e = o.ease || 'expo.out', st = o.stagger || 0;
    var dist = o.dist == null ? 80 : o.dist, bl = o.blur == null ? 14 : o.blur;
    els.forEach(function (n, i) {
      var t = at + i * st;
      if (from === 'blur' || from === 'scale') {
        var sc = o.scale == null ? (from === 'scale' ? 0.86 : 1.08) : o.scale;
        gsap.set(n, { opacity: 0, scale: sc, filter: from === 'blur' ? 'blur(' + bl + 'px)' : 'blur(0px)' });
        tl.fromTo(n, { opacity: 0, scale: sc, filter: from === 'blur' ? 'blur(' + bl + 'px)' : 'blur(0px)' },
          { opacity: 1, scale: 1, filter: 'blur(0px)', duration: dur, ease: e, immediateRender: false }, t);
        tl.set(n, { filter: 'none' }, t + dur);
      } else {
        var dx = from === 'left' ? -dist : from === 'right' ? dist : 0, dy = from === 'up' ? dist : from === 'down' ? -dist : 0;
        gsap.set(n, { opacity: 0, x: dx, y: dy });
        tl.fromTo(n, { opacity: 0, x: dx, y: dy }, { opacity: 1, x: 0, y: 0, duration: dur, ease: e, immediateRender: false }, t);
        mblur(tl, n, t, dur * 0.7, { x: dx ? bl * 1.6 : 0, y: dy ? bl * 1.6 : 0, ease: 'power2.out' });
      }
    });
    return at + (els.length - 1) * st + dur;
  }

  /** exit(tl, el, at, {to:'blur'|'up'|'down'|'left'|'right', dur:.35, dist:60, blur:12, ease:'power3.in', stagger:0}) */
  function exit(tl, el, at, o) {
    o = o || {}; var els = $$(el), to = o.to || 'blur', dur = o.dur || 0.35, e = o.ease || 'power3.in', st = o.stagger || 0;
    var dist = o.dist == null ? 60 : o.dist, bl = o.blur == null ? 12 : o.blur;
    els.forEach(function (n, i) {
      var t = at + i * st;
      if (to === 'blur') {
        tl.fromTo(n, { opacity: 1, scale: 1, filter: 'blur(0px)' }, { opacity: 0, scale: o.scale || 1.04, filter: 'blur(' + bl + 'px)', duration: dur, ease: e, immediateRender: false }, t);
      } else {
        var dx = to === 'left' ? -dist : to === 'right' ? dist : 0, dy = to === 'up' ? -dist : to === 'down' ? dist : 0;
        tl.fromTo(n, { opacity: 1, x: 0, y: 0 }, { opacity: 0, x: dx, y: dy, duration: dur, ease: e, immediateRender: false }, t);
      }
    });
    return at + (els.length - 1) * st + dur;
  }

  /** reveal(tl, el, at, {by:'words'|'chars', dur:.6, stagger:.06, ease:'expo.out', from:110}): masked line rise (text must be plain). */
  function reveal(tl, el, at, o) {
    o = o || {}; var parts = split(el, { by: o.by || 'words', mask: true }), dur = o.dur || 0.6, st = o.stagger == null ? 0.06 : o.stagger;
    var targets = o.by === 'chars' ? parts.chars : parts.inners;
    gsap.set(targets, { yPercent: o.from || 115 });
    tl.fromTo(targets, { yPercent: o.from || 115 }, { yPercent: 0, duration: dur, ease: o.ease || 'expo.out', stagger: st, immediateRender: false }, at);
    return at + dur + st * (targets.length - 1);
  }

  /** mblur(tl, el, at, dur, {x:24, y:0, ease:'power2.out', to:[0,0]}): directional motion blur that resolves to sharp. */
  function mblur(tl, el, at, dur, o) {
    o = o || {}; var n = $(el), id = 'lk-mb-' + (++uid), f = filterShell(id);
    var g = node('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '0 0' }, f);
    var fx = o.x || 0, fy = o.y || 0, tx = (o.to || [0, 0])[0], ty = (o.to || [0, 0])[1], E = ease(o.ease || 'power2.out');
    var prev = n.style.filter;
    return drive(tl, at, dur, function (p) {
      if (p <= 0 || p >= 1) {
        var sx = p <= 0 ? 0 : tx, sy = p <= 0 ? 0 : ty;
        g.setAttribute('stdDeviation', sx + ' ' + sy); n.style.filter = (sx || sy) ? 'url(#' + id + ')' : prev; return;
      }
      var k = E(p); g.setAttribute('stdDeviation', (fx + (tx - fx) * k).toFixed(2) + ' ' + (fy + (ty - fy) * k).toFixed(2));
      n.style.filter = 'url(#' + id + ')';
    });
  }

  /**
   * impact(tl, at, {shake:'#shake', amp:10, dur:.32, flash:.5, flashColor:'#fff', host:'#root', zoom:1.03})
   * A beat hit: a 2-4 frame exposure flash, a decaying deterministic shake and an optional punch-zoom on the
   * shake target (wrap your footage in a dedicated element, e.g. <div id="shake">, so this never fights other tweens).
   */
  function impact(tl, at, o) {
    o = o || {}; var dur = o.dur || 0.32, amp = o.amp == null ? 10 : o.amp;
    if (o.flash !== 0) {
      var fl = doc.createElement('div'); fl.className = 'lk-flash'; fl.style.background = o.flashColor || '#fff';
      $(o.host || '#root').appendChild(fl); fl.style.zIndex = String(o.z || 80);
      tl.fromTo(fl, { opacity: o.flash == null ? 0.5 : o.flash }, { opacity: 0, duration: 0.2, ease: 'power2.out', immediateRender: false }, at);
      tl.set(fl, { opacity: 0 }, 0);
    }
    if (o.shake) {
      var s = $(o.shake), z = o.zoom || 1, seed = (++uid) * 101;
      drive(tl, at, dur, function (p) {
        if (p <= 0 || p >= 1) { gsap.set(s, { x: 0, y: 0, scale: 1 }); return; }
        var f = Math.floor(p * dur * FPS), env = Math.pow(1 - p, 2);
        gsap.set(s, { x: (hash(seed + f * 3) * 2 - 1) * amp * env, y: (hash(seed + f * 3 + 1) * 2 - 1) * amp * env, scale: 1 + (z - 1) * env });
      });
    }
    return at + dur;
  }

  /**
   * expose(tl, at, {target:'#shake', peak:1.85, hold:2/30, dur:.32, saturate:1.12, ease:'power2.out'})
   * The payoff LIGHT hit: an exposure pulse on the footage (CSS brightness/saturate filter on the target).
   * Highlights blow out and colours bloom while blacks stay black, so it reads as a lit hit and not the grey veil
   * that a white overlay flash gives. 1-frame attack, a 2-frame hold at peak (a 1-frame peak reads as flicker), then decay.
   * Use with Look.impact(tl, at, {flash:0, ...}) for the shake/punch. Target a dedicated wrapper that you don't filter yourself.
   */
  function expose(tl, at, o) {
    o = o || {}; var ts = $$(o.target || '#shake'), peak = o.peak || 1.85, sat = o.saturate == null ? 1.12 : o.saturate;
    var hold = o.hold == null ? 2 / FPS : o.hold, dur = o.dur || 0.32, E = ease(o.ease || 'power2.out'), a = 1 / FPS, total = a + hold + dur;
    drive(tl, at, total, function (p) {
      var t = p * total, k = 0;
      if (p > 0 && p < 1) k = t < a ? t / a : (t < a + hold ? 1 : 1 - E((t - a - hold) / dur));
      var f = k > 0.002 ? 'brightness(' + (1 + (peak - 1) * k).toFixed(3) + ') saturate(' + (1 + (sat - 1) * k).toFixed(3) + ')' : '';
      for (var i = 0; i < ts.length; i++) ts[i].style.filter = f;
    });
    return at + total;
  }

  /** chroma(tl, el, at, dur, {px:10, ease:'power2.out'}): RGB split that decays to zero (for impacts and glitches). Keep px <= 6 and dur <= .2: bigger reads as a stock rainbow glitch. */
  function chroma(tl, el, at, dur, o) {
    o = o || {}; var n = $(el), id = 'lk-ch-' + (++uid), f = filterShell(id), px = o.px == null ? 10 : o.px, E = ease(o.ease || 'power2.out');
    node('feColorMatrix', { in: 'SourceGraphic', type: 'matrix', values: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', result: 'r' }, f);
    var ro = node('feOffset', { in: 'r', dx: '0', dy: '0', result: 'ro' }, f);
    node('feColorMatrix', { in: 'SourceGraphic', type: 'matrix', values: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', result: 'g' }, f);
    node('feColorMatrix', { in: 'SourceGraphic', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0', result: 'b' }, f);
    var bo = node('feOffset', { in: 'b', dx: '0', dy: '0', result: 'bo' }, f);
    node('feBlend', { in: 'ro', in2: 'g', mode: 'screen', result: 'rg' }, f);
    node('feBlend', { in: 'rg', in2: 'bo', mode: 'screen' }, f);
    var prev = n.style.filter;
    return drive(tl, at, dur, function (p) {
      if (p <= 0 || p >= 1) { n.style.filter = prev; return; }
      var d = px * (1 - E(p)); ro.setAttribute('dx', (-d).toFixed(2)); bo.setAttribute('dx', d.toFixed(2)); n.style.filter = 'url(#' + id + ')';
    });
  }

  /** leak(tl, at, dur, {host:'#root', colors:['#FE8E4E','#F84FA4'], opacity:.5, y:.35, from:-.4, to:1.4, size:1500}): a light leak sweeping across. */
  function leak(tl, at, dur, o) {
    o = o || {}; var c = o.colors || ['#FE8E4E', '#F84FA4'], sz = o.size || 1500, el = doc.createElement('div');
    el.className = 'lk-leak'; el.style.width = sz + 'px'; el.style.height = sz + 'px'; el.style.zIndex = String(o.z || 70);
    el.style.background = 'radial-gradient(closest-side, rgba(' + hexToRgb(c[0]) + ',.95), rgba(' + hexToRgb(c[0]) + ',0) 70%),' +
      'radial-gradient(closest-side at 70% 60%, rgba(' + hexToRgb(c[1] || c[0]) + ',.8), rgba(' + hexToRgb(c[1] || c[0]) + ',0) 75%)';
    $(o.host || '#root').appendChild(el);
    var W = 1080, H = 1920, y = (o.y == null ? 0.35 : o.y) * H - sz / 2, x0 = (o.from == null ? -0.4 : o.from) * W - sz / 2, x1 = (o.to == null ? 1.4 : o.to) * W - sz / 2, pk = o.opacity == null ? 0.5 : o.opacity;
    gsap.set(el, { x: x0, y: y, opacity: 0 });
    tl.fromTo(el, { x: x0 }, { x: x1, duration: dur, ease: 'sine.inOut', immediateRender: false }, at);
    tl.fromTo(el, { opacity: 0 }, { opacity: pk, duration: dur * 0.35, ease: 'sine.out', immediateRender: false }, at);
    tl.fromTo(el, { opacity: pk }, { opacity: 0, duration: dur * 0.45, ease: 'sine.in', immediateRender: false }, at + dur * 0.55);
    return at + dur;
  }

  /**
   * fill(container, gradientCss, {sheen:false}) -> leaves
   * Gradient-filled type that survives splitting and passes the HyperFrames text lint: the gradient is put on every
   * LEAF text element (char / word / the element itself), sized to the whole container and offset per leaf, so it reads
   * as one continuous sweep across the words. Call AFTER split/reveal and after fonts are ready.
   * sheen:true adds a white specular band layer that Look.sheen() sweeps across.
   */
  var SHEEN = 'linear-gradient(105deg, rgba(255,255,255,0) 38%, rgba(255,255,255,.92) 50%, rgba(255,255,255,0) 62%)';
  function leavesOf(c) {
    var out = [];
    (function walk(n) {
      var kids = Array.prototype.filter.call(n.children, function (k) { return !k.classList.contains('lk-glint'); });
      if (!kids.length) { if (n.textContent.trim()) out.push(n); return; }
      kids.forEach(walk);
    })(c);
    return out;
  }
  function relPos(n, c) {
    var x = 0, y = 0, el = n;
    while (el && el !== c) { x += el.offsetLeft; y += el.offsetTop; var op = el.offsetParent; if (!op || !c.contains(op) && op !== c) break; el = op; }
    return [x, y];
  }
  function fill(container, grad, o) {
    o = o || {}; var c = $(container);
    if (getComputedStyle(c).position === 'static') c.style.position = 'relative';
    var W = c.offsetWidth, H = c.offsetHeight, leaves = leavesOf(c);
    leaves.forEach(function (n) {
      var p = relPos(n, c);
      n.style.backgroundImage = (o.sheen ? SHEEN + ', ' : '') + grad;
      n.style.backgroundRepeat = 'no-repeat';
      n.style.backgroundSize = (o.sheen ? W * 3 + 'px ' + H + 'px, ' : '') + W + 'px ' + H + 'px';
      n.style.backgroundPosition = (o.sheen ? (W * 1.6) + 'px 0px, ' : '') + (-p[0]) + 'px ' + (-p[1]) + 'px';
      n.style.webkitBackgroundClip = 'text'; n.style.backgroundClip = 'text';
      n.style.color = 'transparent'; n.style.webkitTextFillColor = 'transparent';
      n.style.textShadow = 'none'; // a text-shadow under a clipped background muddies the gradient: lift the CONTAINER with filter:drop-shadow instead
      n.__lk = { x: -p[0], y: -p[1], W: W, H: H, sheen: !!o.sheen };
    });
    return leaves;
  }
  /** sheen(tl, container, at, {dur:.9, ease:'power2.inOut'}): sweep the specular band of a fill(...,{sheen:true}) across the type. */
  function sheen(tl, container, at, o) {
    o = o || {}; var leaves = leavesOf($(container)).filter(function (n) { return n.__lk && n.__lk.sheen; });
    var dur = o.dur || 0.9, E = ease(o.ease || 'power2.inOut');
    return drive(tl, at, dur, function (p) {
      leaves.forEach(function (n) {
        var L = n.__lk, from = L.W * 1.6, to = -L.W * 3.2, bx = from + (to - from) * E(p);
        n.style.backgroundPosition = (bx + L.x) + 'px ' + L.y + 'px, ' + L.x + 'px ' + L.y + 'px';
      });
    });
  }

  /** push(tl, el, at, dur, {from:1, to:1.06, x:0, y:0}): slow camera push on footage (gives a held plate life). */
  function push(tl, el, at, dur, o) {
    o = o || {}; gsap.set(el, { scale: o.from || 1, transformOrigin: o.origin || '50% 45%' });
    tl.fromTo(el, { scale: o.from || 1, x: 0, y: 0 }, { scale: o.to || 1.06, x: o.x || 0, y: o.y || 0, duration: dur, ease: o.ease || 'none', immediateRender: false }, at);
    return at + dur;
  }

  /** count(tl, el, at, dur, from, to, {ease:'expo.out', format:fn}): rolling number (tabular figures recommended). */
  function count(tl, el, at, dur, from, to, o) {
    o = o || {}; var n = $(el), E = ease(o.ease || 'expo.out'), fmt = o.format || function (v) { return Math.round(v).toLocaleString('en-US'); };
    return drive(tl, at, dur, function (p) { n.textContent = fmt(from + (to - from) * E(p)); });
  }

  root.Look = { drive: drive, hash: hash, install: install, bloom: bloom, split: split, enter: enter, exit: exit, reveal: reveal,
    mblur: mblur, impact: impact, expose: expose, chroma: chroma, leak: leak, fill: fill, sheen: sheen, push: push, count: count, FPS: FPS };
})(window);
