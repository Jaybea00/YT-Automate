import { escapeHtml, themedPage } from './templates';
import type { MotionTheme } from './theme';

/** More signature shots (see signature-templates.ts): spec cards, money visuals, the Vox paper collage. */

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

// --------------------------------------------------------------------------
// Car / Tech review: spec card
// --------------------------------------------------------------------------

export interface SpecCardSpec {
  title: string;
  subject?: string;
  rows: Array<{ label: string; value: string }>;
}

/** A spec sheet: the subject on the left, its figures sliding in row by row with an accent rule. */
export function specCardTemplate(theme: MotionTheme, spec: SpecCardSpec): string {
  const rowH = Math.min(118, 620 / spec.rows.length);
  return themedPage(
    theme,
    `.kick{position:absolute;left:150px;top:300px;font:700 26px ${theme.bodyFont};letter-spacing:6px;color:${theme.accentText};text-transform:uppercase;opacity:0}
.name{position:absolute;left:150px;top:350px;width:640px;font:800 82px/1.05 ${theme.headingFont};color:${theme.text};opacity:0}
.rule{position:absolute;left:150px;top:600px;height:8px;width:0;background:${theme.accent}}
.rows{position:absolute;left:900px;right:150px;top:${540 - (rowH * spec.rows.length) / 2}px}
.row{height:${rowH}px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid rgba(127,127,127,.25);opacity:0}
.lab{font:500 32px ${theme.bodyFont};color:${theme.muted};text-transform:uppercase;letter-spacing:2px}
.val{font:800 52px ${theme.numberFont};color:${theme.text}}`,
    `<div class="kick" id="kick">${escapeHtml(spec.subject ?? 'Spec sheet')}</div><div class="name" id="name">${escapeHtml(spec.title)}</div><div class="rule" id="rule"></div><div class="rows">${spec.rows
      .map((r, i) => `<div class="row" id="r${i}"><span class="lab">${escapeHtml(r.label)}</span><span class="val">${escapeHtml(r.value)}</span></div>`)
      .join('')}</div>`,
    `const n=${spec.rows.length};window.__frame=(t,d)=>{document.getElementById('kick').style.opacity=ease(phase(t,0,0.4));
const nm=document.getElementById('name');const k=ease(phase(t,0.1,0.5));nm.style.opacity=k;nm.style.transform='translateX('+(-40*(1-k))+'px)';
document.getElementById('rule').style.width=(220*ease(phase(t,0.4,0.6)))+'px';
for(let i=0;i<n;i++){const r=document.getElementById('r'+i);const p=ease(phase(t,0.5+i*Math.min(0.35,d*0.5/n),0.4));r.style.opacity=p;r.style.transform='translateX('+(60*(1-p))+'px)'}
document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}

// --------------------------------------------------------------------------
// Finance: money growing or shrinking
// --------------------------------------------------------------------------

export interface MoneySpec {
  /** growth: a pile of notes building up (compounding); shrink: a note losing value (inflation). */
  kind: 'growth' | 'shrink';
  from: number;
  to: number;
  currency: string;
  label: string;
}

/** Money you can see: notes stacking up as the figure counts from `from` to `to`, or one note shrinking to what it's worth. */
export function moneyTemplate(theme: MotionTheme, money: MoneySpec): string {
  const note = `<div class="note"><div class="inner"><span class="cur">${escapeHtml(money.currency)}</span><span class="seal"></span></div></div>`;
  return themedPage(
    theme,
    `.label{position:absolute;left:0;right:0;top:110px;text-align:center;font:600 46px ${theme.headingFont};color:${theme.text};opacity:0}
.count{position:absolute;left:0;right:0;top:180px;text-align:center;font:800 120px ${theme.numberFont};color:${theme.accentText}}
.note{position:absolute;width:420px;height:200px;border-radius:12px;background:linear-gradient(135deg,#3f7d4f,#2a5a37);box-shadow:0 10px 24px rgba(0,0,0,.4);padding:14px}
.inner{width:100%;height:100%;border:3px solid rgba(255,255,255,.35);border-radius:8px;display:flex;align-items:center;justify-content:space-between;padding:0 30px}
.cur{font:800 80px Georgia,serif;color:rgba(255,255,255,.85)}
.seal{width:90px;height:90px;border-radius:50%;border:4px solid rgba(255,255,255,.4);background:radial-gradient(circle,rgba(255,255,255,.2),transparent 70%)}
.ghost{position:absolute;left:750px;top:560px;width:420px;height:200px;border:4px dashed rgba(127,127,127,.5);border-radius:12px}`,
    `<div class="label" id="label">${escapeHtml(money.label)}</div><div class="count" id="count"></div>${
      money.kind === 'shrink'
        ? `<div class="ghost"></div><div id="one" style="position:absolute;left:750px;top:560px;width:420px;height:200px;transform-origin:50% 50%">${note.replace('class="note"', 'class="note" style="left:0;top:0"')}</div>`
        : '<div id="pile"></div>'
    }`,
    `const M=${json(money)};const pile=document.getElementById('pile');const notes=[];
if(pile){const count=Math.min(28,Math.max(4,Math.round(Math.log2(Math.max(1.01,M.to/Math.max(1e-9,M.from)))*6)));
for(let i=0;i<count;i++){const w=document.createElement('div');w.innerHTML=${json(note)};const nn=w.firstChild;nn.style.left=(330+(i%5)*270+(Math.floor(i/5)%2)*60)+'px';nn.style.top=(820-Math.floor(i/5)*46)+'px';nn.style.transform='rotate('+(((i*53)%13)-6)+'deg)';nn.style.opacity=0;pile.appendChild(nn);notes.push(nn)}}
const fmtMoney=(v)=>M.currency+fmt(v,Math.abs(v)<100?2:0);
window.__frame=(t,d)=>{document.getElementById('label').style.opacity=ease(phase(t,0,0.4));
const p=easeInOut(phase(t,0.4,Math.max(0.8,d*0.6)));const v=M.kind==='growth'?M.from*Math.pow(M.to/M.from,p):M.from+(M.to-M.from)*p;
document.getElementById('count').textContent=fmtMoney(p>=1?M.to:v);
notes.forEach((nn,i)=>{const at=(i+1)/notes.length;const k=ease(phase(p,at-0.08,0.08));nn.style.opacity=k;nn.style.marginTop=(-40*(1-k))+'px'});
const one=document.getElementById('one');if(one){const s=Math.sqrt(Math.max(0.02,M.to/M.from));one.style.transform='scale('+(1-(1-s)*p)+')'}
document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}

// --------------------------------------------------------------------------
// Vox: photos as a paper collage
// --------------------------------------------------------------------------

/** A ragged edge for torn paper, the same every time for a given seed. */
export function tornPolygon(seed: number): string {
  const rnd = (i: number) => {
    const x = Math.sin(seed * 97.13 + i * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const jag = (i: number) => Math.round(rnd(i) * 160) / 100;
  const pts: string[] = [];
  for (let i = 0; i <= 20; i++) pts.push(`${i * 5}% ${jag(i)}%`);
  for (let i = 0; i <= 20; i++) pts.push(`${100 - jag(i + 40)}% ${i * 5}%`);
  for (let i = 20; i >= 0; i--) pts.push(`${i * 5}% ${100 - jag(i + 80)}%`);
  for (let i = 20; i >= 0; i--) pts.push(`${jag(i + 120)}% ${i * 5}%`);
  return `polygon(${pts.join(',')})`;
}

/**
 * A photo cut out and stuck on paper, the Vox look: a torn white border, tape, a scrap of colour
 * behind it, settling in and then drifting slowly. `n` varies the tilt per shot.
 */
export function collagePhotoTemplate(theme: MotionTheme, photo: { imageUrl: string; width: number; height: number }, n: number): string {
  const tilt = [-3.5, 2.5, -1.5, 3][n % 4];
  const aspect = photo.width / Math.max(1, photo.height);
  const h = Math.min(760, 1300 / aspect);
  const w = h * aspect;
  return themedPage(
    theme,
    `.bg{background:#efe9dc!important}
.paper{position:absolute;inset:0;background-image:radial-gradient(rgba(120,100,70,.10) 1px,transparent 1.4px),radial-gradient(rgba(120,100,70,.07) 1px,transparent 1.2px);background-size:7px 7px,13px 13px;background-position:0 0,4px 6px}
.scrap{position:absolute;left:${960 - w / 2 - 120}px;top:${540 - h / 2 + 60}px;width:${w * 0.55}px;height:${h * 0.5}px;background:${theme.accent};clip-path:${tornPolygon(n + 7)};opacity:0}
.piece{position:absolute;left:${960 - w / 2 - 18}px;top:${540 - h / 2 - 18}px;width:${w + 36}px;height:${h + 36}px;padding:18px;background:#fbfaf6;clip-path:${tornPolygon(n)};opacity:0}
.shadow{position:absolute;inset:0;filter:drop-shadow(0 12px 18px rgba(0,0,0,.28))}
.piece img{width:${w}px;height:${h}px;object-fit:cover;display:block;filter:saturate(.9) contrast(1.05)}
.tape{position:absolute;width:220px;height:56px;background:rgba(250,240,200,.75);box-shadow:0 2px 4px rgba(0,0,0,.12);opacity:0}`,
    `<div class="paper"></div><div class="scrap" id="scrap"></div><div class="shadow"><div class="piece" id="piece"><img src="${photo.imageUrl}"></div></div><div class="tape" id="tape" style="left:${960 - 110}px;top:${540 - h / 2 - 46}px;transform:rotate(${-tilt * 1.5}deg)"></div>`,
    `const tilt=${tilt};window.__frame=(t,d)=>{const k=ease(phase(t,0,0.45));const pc=document.getElementById('piece');
pc.style.opacity=k;pc.style.transform='translateY('+(40*(1-k))+'px) rotate('+(tilt*(0.6+0.4*k))+'deg) scale('+(1.04-0.04*k)+')';
const s=document.getElementById('scrap');s.style.opacity=ease(phase(t,0.1,0.4));s.style.transform='rotate('+(-tilt*2)+'deg)';
document.getElementById('tape').style.opacity=ease(phase(t,0.35,0.25));
document.getElementById('stage').style.transform='scale('+(1+0.06*clamp(t/d))+') translateX('+(-12*clamp(t/d))+'px)'};`,
  );
}
