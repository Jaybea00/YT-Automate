import { DIAGRAM_LIMITS, type ShotPlan } from '@/lib/script/generate-script';
import { HELPERS, escapeHtml } from './templates';
import { baseCss, type MotionTheme } from './theme';
import { motionDocument } from './frame-renderer';

/**
 * Animated "how it works" diagrams in three layouts: a process (steps left to right), a cycle
 * (steps around a loop) and a breakdown (one thing and its parts). Each step appears as the
 * narration reaches it, with its connector drawing on just before; the newest step is
 * highlighted. Geometry is computed here so the page only animates.
 */

export type DiagramSpec = NonNullable<ShotPlan['diagram']>;

const W = 1920;
const H = 1080;
const MAX_DIAGRAM_STEPS = DIAGRAM_LIMITS.maxSteps;

const STOP = new Set(['the', 'and', 'for', 'from', 'with', 'into', 'onto', 'that', 'this', 'then', 'they', 'their', 'its', 'are', 'was', 'were', 'has', 'have']);
const contentWords = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
/** Loose match so "fills" finds "filling" and "rise" finds "rises". */
const sameWord = (a: string, b: string) => a === b || (a.length > 3 && b.length > 3 && (a.startsWith(b.slice(0, 4)) && b.startsWith(a.slice(0, 4))));

/**
 * When each step appears, in seconds into a d-second shot: as the narration (the shot's
 * `covers`) first mentions it, in order, falling back to even spacing. Steps stay at least
 * 0.45 s apart and all appear by 80% of the shot.
 */
export function diagramRevealTimes(spec: DiagramSpec, covers: string, d: number): number[] {
  const words = contentWords(covers);
  const steps = spec.steps.slice(0, MAX_DIAGRAM_STEPS);
  const n = steps.length;
  const start = Math.min(0.5, d * 0.1);
  const end = Math.max(start + 0.45 * n, d * 0.8);
  let cursor = 0;
  const fractions = steps.map((step, i) => {
    const wanted = contentWords(step.label);
    const at = words.findIndex((w, idx) => idx >= cursor && wanted.some((x) => sameWord(w, x)));
    if (at >= 0 && words.length > 1) {
      cursor = at + 1;
      return at / (words.length - 1);
    }
    return n === 1 ? 0 : i / (n - 1);
  });
  const times: number[] = [];
  fractions.forEach((f, i) => {
    const t = start + f * (end - start) * 0.85;
    times.push(Math.round(Math.max(t, i ? times[i - 1] + 0.45 : start) * 100) / 100);
  });
  return times;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Card boxes and connector paths for each layout. Connector i leads into step i. */
export function diagramLayout(spec: DiagramSpec): { cards: Box[]; links: Array<{ to: number; path: string }>; hub?: { x: number; y: number; r: number } } {
  const n = Math.min(spec.steps.length, MAX_DIAGRAM_STEPS);
  const top = spec.title ? 230 : 160;
  if (spec.kind === 'process') {
    const gap = 96;
    const w = Math.min(330, (1680 - gap * (n - 1)) / n);
    const h = 280;
    const total = n * w + (n - 1) * gap;
    const y = top + (H - top - h) / 2;
    const cards = Array.from({ length: n }, (_, i) => ({ x: (W - total) / 2 + i * (w + gap), y, w, h }));
    const links = cards.slice(1).map((c, i) => {
      const from = cards[i];
      const yy = y + h / 2;
      return { to: i + 1, path: `M${from.x + from.w + 14} ${yy} L${c.x - 18} ${yy}` };
    });
    return { cards, links };
  }

  const cx = W / 2;
  const cy = top + (H - top) / 2 - 10;
  const radius = Math.min(330, (H - top) / 2 - 150);
  const w = 300;
  const h = 150;
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const centre = (i: number) => ({ x: cx + Math.cos(angle(i)) * radius * (spec.kind === 'cycle' ? 1.45 : 1.6), y: cy + Math.sin(angle(i)) * radius });
  const cards = Array.from({ length: n }, (_, i) => {
    const c = centre(i);
    return { x: c.x - w / 2, y: c.y - h / 2, w, h };
  });

  if (spec.kind === 'cycle') {
    // Curved arrows between neighbours, bowing outward along the loop; the last closes it
    const links = cards.map((_, i) => {
      const a = centre(i);
      const b = centre((i + 1) % n);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const ox = mx - cx;
      const oy = my - cy;
      const len = Math.hypot(ox, oy) || 1;
      const bow = 70;
      const qx = mx + (ox / len) * bow;
      const qy = my + (oy / len) * bow;
      // Start and end short of the cards' centres so arrows sit between them
      const trim = (p: { x: number; y: number }, q: { x: number; y: number }, k: number) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
      const s = trim(a, { x: qx, y: qy }, 0.42);
      const e = trim(b, { x: qx, y: qy }, 0.42);
      return { to: (i + 1) % n, path: `M${s.x.toFixed(1)} ${s.y.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${e.x.toFixed(1)} ${e.y.toFixed(1)}` };
    });
    return { cards, links };
  }

  // Breakdown: spokes from the hub to each part
  const hub = { x: cx, y: cy, r: 130 };
  const links = cards.map((c, i) => {
    const t = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
    const dx = t.x - cx;
    const dy = t.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const s = { x: cx + (dx / len) * (hub.r + 10), y: cy + (dy / len) * (hub.r + 10) };
    // Stop at the card's edge (approximately), not its centre
    const stop = Math.max(0, len - Math.min(c.w / 2 / Math.max(Math.abs(dx / len), 0.01), c.h / 2 / Math.max(Math.abs(dy / len), 0.01)) - 14);
    const e = { x: cx + (dx / len) * stop, y: cy + (dy / len) * stop };
    return { to: i, path: `M${s.x.toFixed(1)} ${s.y.toFixed(1)} L${e.x.toFixed(1)} ${e.y.toFixed(1)}` };
  });
  return { cards, links, hub };
}

export function diagramTemplate(theme: MotionTheme, spec: DiagramSpec, revealTimes: number[]): string {
  const steps = spec.steps.slice(0, MAX_DIAGRAM_STEPS);
  const { cards, links, hub } = diagramLayout(spec);
  const small = spec.kind !== 'process';
  const data = JSON.stringify({ times: revealTimes, links: links.map((l) => l.to), cycle: spec.kind === 'cycle', hub: Boolean(hub) });
  return motionDocument({
    css: `${baseCss(theme)}
.stage{position:absolute;inset:0;transform-origin:50% 50%}
.title{position:absolute;left:0;right:0;top:96px;text-align:center;font-family:${theme.headingFont};font-size:56px;color:${theme.text};opacity:0}
.title .bar{display:block;margin:22px auto 0;height:8px;width:0;background:${theme.accent}}
.card{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:${small ? '14px 18px' : '26px 24px'};
  background:${theme.surface};border:3px solid transparent;border-radius:${theme.radius}px;box-shadow:0 18px 50px rgba(0,0,0,.28);opacity:0}
.card.on{border-color:${theme.accent}}
.badge{width:${small ? 40 : 54}px;height:${small ? 40 : 54}px;border-radius:50%;background:${theme.accent};color:${theme.background};font-family:${theme.numberFont};font-weight:700;
  font-size:${small ? 22 : 28}px;display:flex;align-items:center;justify-content:center;margin-bottom:${small ? 8 : 16}px}
.label{font-family:${theme.headingFont};font-weight:700;font-size:${small ? 30 : 38}px;line-height:1.15;color:${theme.text}}
.detail{margin-top:10px;font-family:${theme.bodyFont};font-size:${small ? 20 : 24}px;line-height:1.3;color:${theme.muted}}
.hub{position:absolute;border-radius:50%;background:${theme.accent};display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;
  font-family:${theme.headingFont};font-weight:700;font-size:34px;line-height:1.15;color:${theme.background};opacity:0}
svg.links{position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:visible}
svg.links path{fill:none;stroke:${theme.muted};stroke-width:5;stroke-linecap:round}
svg.links path.done{stroke:${theme.accent}}`,
    body: `<div class="bg"></div><div class="stage" id="stage">
${spec.title ? `<div class="title" id="title">${escapeHtml(spec.title)}<span class="bar" id="tbar"></span></div>` : ''}
<svg class="links"><defs><marker id="arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill:${theme.accent};stroke:none"/></marker></defs>
${links.map((l, i) => `<path id="l${i}" d="${l.path}"/>`).join('')}</svg>
${hub ? `<div class="hub" id="hub" style="left:${hub.x - hub.r}px;top:${hub.y - hub.r}px;width:${hub.r * 2}px;height:${hub.r * 2}px">${escapeHtml(spec.center ?? '')}</div>` : ''}
${steps
  .map(
    (s, i) =>
      `<div class="card" id="c${i}" style="left:${cards[i].x.toFixed(1)}px;top:${cards[i].y.toFixed(1)}px;width:${cards[i].w.toFixed(1)}px;height:${cards[i].h}px">` +
      `${spec.kind === 'breakdown' ? '' : `<div class="badge">${i + 1}</div>`}<div class="label">${escapeHtml(s.label)}</div>${s.detail && !small ? `<div class="detail">${escapeHtml(s.detail)}</div>` : ''}</div>`,
  )
  .join('\n')}
</div>`,
    script: `${HELPERS}
const D=${data};
const paths=D.links.map((_,i)=>document.getElementById('l'+i));
const lens=paths.map(p=>p.getTotalLength());
paths.forEach((p,i)=>{p.style.strokeDasharray=lens[i]+' '+lens[i];p.style.strokeDashoffset=lens[i];});
window.__frame=(t,d)=>{
  const T=document.getElementById('title');
  if(T){const a=ease(phase(t,0,0.5));T.style.opacity=a;T.style.transform='translateY('+(24*(1-a))+'px)';document.getElementById('tbar').style.width=(260*ease(phase(t,0.25,0.6)))+'px';}
  const H=document.getElementById('hub');
  if(H){const a=ease(phase(t,0.1,0.5));H.style.opacity=a;H.style.transform='scale('+(0.7+0.3*a)+')';}
  let newest=-1;
  D.times.forEach((at,i)=>{
    const c=document.getElementById('c'+i);
    const a=ease(phase(t,at,0.45));
    c.style.opacity=a;c.style.transform='translateY('+(30*(1-a))+'px) scale('+(0.94+0.06*a)+')';
    if(t>=at)newest=i;
  });
  D.times.forEach((_,i)=>document.getElementById('c'+i).classList.toggle('on',i===newest));
  // Each connector draws in the 0.4 s before the step it leads to (the cycle's closing arrow after the last)
  paths.forEach((p,i)=>{
    const to=D.links[i];
    const closing=D.cycle&&to===0;
    const at=closing?D.times[D.times.length-1]+0.5:(D.hub?D.times[to]-0.25:D.times[to]-0.4);
    const k=ease(phase(t,at,0.4));
    p.style.strokeDashoffset=lens[i]*(1-k);
    p.style.opacity=k>0?1:0;
    p.classList.toggle('done',k>=1);
    // An SVG marker draws even while its line is hidden, so the arrowhead arrives with the line's end
    if(!D.hub){if(k>=0.95)p.setAttribute('marker-end','url(#arrow)');else p.removeAttribute('marker-end');}
  });
  document.getElementById('stage').style.transform=drift(t,d);
};`,
  });
}
