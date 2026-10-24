import { escapeHtml, themedPage } from './templates';
import type { MotionTheme } from './theme';

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * Tifo-style shot maps: a team's shots on the attacking half, each a dot sized by its chance
 * quality (xG), goals lit in the accent colour, with the totals counting up. The totals are
 * real (stated in the narration or research); shots the narration describes are placed where it
 * says; the rest are placed by distance and angle like real shots, and marked as illustrative.
 */

export interface ShotMapSpec {
  title: string;
  team: string;
  shots: number;
  goals: number;
  xg?: number | null;
  on_target?: number | null;
  /** Shots the narration describes; x runs 0-100 along the pitch toward the goal at 100, y 0-100 across it. */
  key_shots?: Array<{ label: string; x: number; y: number; outcome: 'goal' | 'saved' | 'missed' | 'blocked'; xg?: number | null }>;
}

export interface ShotDot {
  x: number;
  y: number;
  xg: number;
  outcome: 'goal' | 'saved' | 'missed' | 'blocked';
  label?: string;
  illustrative: boolean;
}

const PITCH_L = 105;
const PITCH_W = 68;

/** A small seeded random generator, so the same map comes out every render. */
function rng(seedText: string): () => number {
  let s = 2166136261;
  for (const ch of seedText) s = Math.imul(s ^ ch.charCodeAt(0), 16777619);
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A rough chance quality from where a shot is taken (closer and more central is better). */
export function xgAt(x: number, y: number): number {
  const dx = ((100 - x) / 100) * PITCH_L;
  const dy = ((y - 50) / 100) * PITCH_W;
  const d = Math.hypot(dx, dy);
  const angle = Math.abs(Math.atan2(dy, Math.max(0.5, dx)));
  return Math.max(0.02, Math.min(0.85, 0.85 * Math.exp(-d / 7.5) * Math.cos(angle * 0.8)));
}

/** Every dot on the map: the described shots, then the rest placed like real shots. */
export function shotMapDots(spec: ShotMapSpec): ShotDot[] {
  const rand = rng(`${spec.title}|${spec.team}|${spec.shots}`);
  const keys: ShotDot[] = (spec.key_shots ?? []).slice(0, Math.max(0, spec.shots)).map((k) => {
    const x = Math.max(50, Math.min(99.5, k.x));
    const y = Math.max(2, Math.min(98, k.y));
    return { x, y, xg: k.xg ?? xgAt(x, y), outcome: k.outcome, label: k.label, illustrative: false };
  });
  const rest = Math.max(0, spec.shots - keys.length);
  const goalsLeft = Math.max(0, spec.goals - keys.filter((k) => k.outcome === 'goal').length);
  const onTarget = spec.on_target ?? Math.round(spec.shots * 0.35);
  const savedLeft = Math.max(0, onTarget - spec.goals - keys.filter((k) => k.outcome === 'saved').length);
  const fill: ShotDot[] = [];
  for (let i = 0; i < rest; i++) {
    const outcome: ShotDot['outcome'] = i < goalsLeft ? 'goal' : i < goalsLeft + savedLeft ? 'saved' : i % 3 === 0 ? 'blocked' : 'missed';
    // Goals mostly come from close in; the rest from anywhere around the box
    const d = outcome === 'goal' ? 6 + rand() * 11 : 8 + rand() * 22;
    const a = (rand() - 0.5) * (outcome === 'goal' ? 1.1 : 1.7);
    const x = 100 - ((d * Math.cos(a)) / PITCH_L) * 100;
    const y = 50 + ((d * Math.sin(a)) / PITCH_W) * 100;
    fill.push({ x: Math.max(52, x), y: Math.max(4, Math.min(96, y)), xg: xgAt(x, y), outcome, illustrative: true });
  }
  // When the total xG is known, the unlabelled shots share what the described ones leave
  if (spec.xg != null && fill.length) {
    const keyXg = keys.reduce((n, k) => n + k.xg, 0);
    const left = Math.max(0.02 * fill.length, spec.xg - keyXg);
    const sum = fill.reduce((n, f) => n + f.xg, 0) || 1;
    for (const f of fill) f.xg = Math.max(0.02, Math.min(0.95, (f.xg * left) / sum));
  }
  return [...keys, ...fill];
}

/** The animated map: the half-pitch with the goal at the top, dots dropping in, totals counting up. */
export function shotMapTemplate(theme: MotionTheme, spec: ShotMapSpec): string {
  const dots = shotMapDots(spec);
  const illustrative = dots.some((d) => d.illustrative);
  const W = 900;
  const H = Math.round((W * 52.5) / PITCH_W);
  const X0 = 170;
  const Y0 = (1080 - H) / 2 + 20;
  const stat = (label: string, value: number | null | undefined, id: string, dec = 0) =>
    value == null ? '' : `<div class="st"><div class="v" id="${id}" data-to="${value}" data-dec="${dec}">0</div><div class="k">${label}</div></div>`;
  return themedPage(
    theme,
    `.title{position:absolute;left:${X0 + W + 90}px;top:${Y0}px;width:${1920 - X0 - W - 160}px;font-size:54px;font-family:${theme.headingFont};color:${theme.text};line-height:1.1}
.team{position:absolute;left:${X0 + W + 90}px;top:${Y0 + 140}px;font:700 26px ${theme.bodyFont};letter-spacing:4px;text-transform:uppercase;color:${theme.accentText}}
.stats{position:absolute;left:${X0 + W + 90}px;top:${Y0 + 200}px;display:grid;grid-template-columns:repeat(2,230px);gap:26px 20px}
.st .v{font:800 78px ${theme.numberFont};color:${theme.text};font-variant-numeric:tabular-nums;line-height:1}
.st .k{font:600 22px ${theme.bodyFont};letter-spacing:3px;text-transform:uppercase;color:${theme.muted};margin-top:6px}
.legend{position:absolute;left:${X0 + W + 90}px;top:${Y0 + H - 90}px;font:500 22px ${theme.bodyFont};color:${theme.muted};display:flex;gap:26px;align-items:center}
.legend i{display:inline-block;width:20px;height:20px;border-radius:50%;margin-right:8px;vertical-align:-3px}
.note{position:absolute;left:${X0}px;top:${Y0 + H + 18}px;font:400 18px ${theme.bodyFont};color:${theme.muted}}
svg{position:absolute;left:0;top:0}
.lab{font:700 22px ${theme.bodyFont};fill:#fff;paint-order:stroke;stroke:rgba(0,0,0,.6);stroke-width:5px}`,
    `<svg width="1920" height="1080" id="svg"></svg><div class="title" id="title">${escapeHtml(spec.title)}</div><div class="team" id="team">${escapeHtml(spec.team)}</div>
<div class="stats" id="stats">${stat('Shots', spec.shots, 's1')}${stat('Goals', spec.goals, 's2')}${stat('xG', spec.xg, 's3', 1)}${stat('On target', spec.on_target, 's4')}</div>
<div class="legend" id="legend"><span><i style="background:${theme.accent}"></i>Goal</span><span><i style="background:#fff"></i>Saved</span><span><i style="background:rgba(255,255,255,.35)"></i>Missed / blocked</span></div>
${illustrative ? '<div class="note" id="note">Dot size: chance quality (xG). Unlabelled shot positions are illustrative.</div>' : ''}`,
    `const D=${json(dots)},X0=${X0},Y0=${Y0},W=${W},H=${H},A=${json(theme.accent)};
const svg=document.getElementById('svg'),NS='http://www.w3.org/2000/svg';
const mk=(tag,a,parent)=>{const e=document.createElementNS(NS,tag);for(const k in a)e.setAttribute(k,a[k]);(parent||svg).appendChild(e);return e};
// Attacking half, goal at the top: x 50-100 runs bottom to top, y 0-100 left to right
const px=(y)=>X0+W*y/100,py=(x)=>Y0+H*(100-x)/50;
const field=mk('g',{opacity:0});
for(let i=0;i<8;i++)mk('rect',{x:X0,y:Y0+H*i/8,width:W,height:H/8+1,fill:i%2?'#2f7d3b':'#348a41'},field);
const line=(a)=>mk(a.tag||'rect',Object.assign({fill:'none',stroke:'rgba(255,255,255,.85)','stroke-width':4},a),field);
line({x:X0,y:Y0,width:W,height:H});
const bw=W*40.3/68,bh=H*16.5/52.5,sw=W*18.3/68,sh=H*5.5/52.5;
line({x:X0+(W-bw)/2,y:Y0,width:bw,height:bh});line({x:X0+(W-sw)/2,y:Y0,width:sw,height:sh});
line({tag:'circle',cx:X0+W/2,cy:Y0+H*11/52.5,r:3,fill:'rgba(255,255,255,.85)'});
line({tag:'path',d:'M'+(X0+W/2-W*9.15/68*0.8)+' '+(Y0+bh)+' A '+(W*9.15/68)+' '+(H*9.15/52.5)+' 0 0 0 '+(X0+W/2+W*9.15/68*0.8)+' '+(Y0+bh)});
line({x:X0+(W-W*7.32/68)/2,y:Y0-16,width:W*7.32/68,height:16});
// The centre circle's half on the halfway line (the bottom edge)
const cr=W*9.15/68,crv=H*9.15/52.5;line({tag:'path',d:'M'+(X0+W/2-cr)+' '+(Y0+H)+' A '+cr+' '+crv+' 0 0 1 '+(X0+W/2+cr)+' '+(Y0+H)});
const dots=D.map(d=>{const g=mk('g',{opacity:0});const r=10+Math.sqrt(d.xg)*42;
  const fill=d.outcome==='goal'?A:d.outcome==='saved'?'#ffffff':'rgba(255,255,255,.35)';
  mk('circle',{cx:px(d.y),cy:py(d.x),r,fill,stroke:d.outcome==='goal'?'#fff':'rgba(0,0,0,.55)','stroke-width':d.outcome==='goal'?4:2,'fill-opacity':d.outcome==='goal'?0.95:0.85},g);
  if(d.label){const t=mk('text',{x:px(d.y)+r+8,y:py(d.x)+7,class:'lab'},g);t.textContent=d.label}
  return {g,d}});
const order=dots.map((o,i)=>i).sort((a,b)=>(D[a].outcome==='goal')-(D[b].outcome==='goal')||a-b);
window.__frame=(t,d)=>{field.setAttribute('opacity',ease(phase(t,0,0.5)));
  for(const id of ['title','team'])document.getElementById(id).style.opacity=ease(phase(t,0.15,0.4));
  const span=Math.max(0.8,d*0.55),step=span/Math.max(1,order.length);
  order.forEach((i,n)=>{const p=phase(t,0.6+n*step,0.3);const o=dots[i];o.g.setAttribute('opacity',ease(p));
    const k=0.4+0.6*ease(p);const c=o.g.firstChild;o.g.setAttribute('transform','translate('+c.getAttribute('cx')*(1-k)+' '+c.getAttribute('cy')*(1-k)+') scale('+k+')')});
  const count=ease(phase(t,0.6,span));document.querySelectorAll('.st .v').forEach(v=>{const to=+v.dataset.to,dec=+v.dataset.dec;v.textContent=fmt(to*count,dec)});
  document.getElementById('stats').style.opacity=ease(phase(t,0.4,0.4));document.getElementById('legend').style.opacity=ease(phase(t,0.8,0.4));
  const n=document.getElementById('note');if(n)n.style.opacity=ease(phase(t,1,0.4))*0.85;
  document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}
