import { escapeHtml, themedPage } from './templates';
import type { MotionTheme } from './theme';

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export interface BarRaceSpec {
  title: string;
  unit: string;
  frames: Array<{ year: number; values: Record<string, number> }>;
}

/** Bars shown at once; the rest wait below the frame. */
const MAX_BARS = 10;

/**
 * A bar-chart race: the years tick by and the bars grow and overtake one another, each country
 * keeping its colour, a big year counter in the corner. Values and ranks are eased between
 * years, so the bars glide rather than jump.
 */
export function barRaceTemplate(theme: MotionTheme, race: BarRaceSpec): string {
  const names = [...new Set(race.frames.flatMap((f) => Object.keys(f.values)))];
  const shown = Math.min(MAX_BARS, names.length);
  const rowH = Math.min(78, 640 / shown);
  return themedPage(
    theme,
    `.title{position:absolute;left:150px;top:90px;font-size:58px;font-family:${theme.headingFont};color:${theme.text}}
.unit{position:absolute;left:150px;top:168px;font-size:28px;color:${theme.muted}}
.year{position:absolute;right:150px;bottom:110px;font:800 190px ${theme.numberFont};color:${theme.text};opacity:.22;font-variant-numeric:tabular-nums}
.row{position:absolute;left:150px;width:1620px;height:${rowH * 0.78}px;will-change:transform}
.lab{position:absolute;left:0;top:0;width:300px;height:100%;display:flex;align-items:center;justify-content:flex-end;padding-right:20px;font:600 ${Math.round(rowH * 0.4)}px ${theme.bodyFont};color:${theme.text};white-space:nowrap;overflow:hidden}
.bar{position:absolute;left:310px;top:0;height:100%;border-radius:6px}
.val{position:absolute;top:50%;transform:translateY(-50%);font:700 ${Math.round(rowH * 0.38)}px ${theme.numberFont};color:${theme.text};white-space:nowrap;font-variant-numeric:tabular-nums}`,
    `<div class="title" id="title">${escapeHtml(race.title)}</div><div class="unit" id="unit">${escapeHtml(race.unit)}</div><div class="year" id="year"></div>${names
      .map((n, i) => `<div class="row" id="r${i}"><div class="lab">${escapeHtml(n)}</div><div class="bar" id="b${i}"></div><div class="val" id="v${i}"></div></div>`)
      .join('')}`,
    `const F=${json(race.frames)},N=${json(names)},C=${json(theme.series)},A=${json(theme.accent)},ROW=${rowH},SHOWN=${shown},W=1250;
// Each country its own colour: the theme's while they last, then evenly spread hues
N.forEach((n,i)=>{document.getElementById('b'+i).style.background=N.length<=C.length+1?(i===0?A:C[(i-1)%C.length]):'hsl('+Math.round(i*360/N.length+200)%360+',62%,58%)'});
const at=(k,n)=>F[Math.max(0,Math.min(F.length-1,k))].values[n]??0;
const ranks=F.map(f=>{const s=[...N].sort((a,b)=>(f.values[b]??-Infinity)-(f.values[a]??-Infinity));const r={};s.forEach((n,i)=>r[n]=i);return r});
window.__frame=(t,d)=>{
  document.getElementById('title').style.opacity=ease(phase(t,0,0.4));document.getElementById('unit').style.opacity=ease(phase(t,0.15,0.4));
  // The years play out between a short hold at the start and a longer one on the final year
  const start=0.6,span=Math.max(1,d-start-1.2),pos=clamp((t-start)/span)*(F.length-1);
  const k=Math.floor(pos),f=easeInOut(pos-k);
  document.getElementById('year').textContent=F[Math.min(F.length-1,Math.round(pos))].year;
  const vals=N.map(n=>at(k,n)+(at(k+1,n)-at(k,n))*f);
  const max=Math.max(...vals.map((v,i)=>{const r=ranks[Math.min(F.length-1,k)][N[i]];return r<SHOWN?v:0}),1e-9);
  const grow=easeInOut(phase(t,0.2,0.6));
  N.forEach((n,i)=>{const r0=ranks[Math.min(F.length-1,k)][n],r1=ranks[Math.min(F.length-1,k+1)][n],r=r0+(r1-r0)*f;
    const row=document.getElementById('r'+i);row.style.transform='translateY('+(250+r*ROW)+'px)';row.style.opacity=clamp(SHOWN-r);
    const w=Math.max(0,vals[i]/max)*W*grow;document.getElementById('b'+i).style.width=w+'px';
    const v=document.getElementById('v'+i);v.style.left=(310+w+16)+'px';v.textContent=fmt(vals[i],decimalsOf(F[F.length-1].values[n]??0))});
  document.getElementById('stage').style.transform=drift(t,d);
};`,
  );
}
