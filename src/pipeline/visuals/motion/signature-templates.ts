import { escapeHtml, themedPage } from './templates';
import type { MotionTheme } from './theme';

/**
 * Signature shots: graphics particular to a style, each offered only to its style's director
 * (see StylePack.signatureShots). Like every template, `window.__frame(t, d)` draws time t of a
 * d-second shot; all text and numbers come from verified specs.
 */

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

// --------------------------------------------------------------------------
// Sport: pitch reconstruction (Tifo style)
// --------------------------------------------------------------------------

export interface PitchSpec {
  title?: string;
  /** Positions are 0-100 along the pitch (x, left to right) and across it (y, top to bottom). */
  players: Array<{ label: string; x: number; y: number; team: 'a' | 'b'; to?: { x: number; y: number } }>;
  ball: Array<{ x: number; y: number }>;
  outcome?: 'goal' | 'save' | 'miss' | null;
}

/**
 * A top-down pitch: players appear as dots (and may make a run), then the ball travels along its
 * path leaving a trail, ending in the outcome. Labelled a reconstruction: positions are drawn
 * from the narration, not tracking data.
 */
export function pitchTemplate(theme: MotionTheme, pitch: PitchSpec): string {
  const W = 1360;
  const H = 880;
  const X0 = (1920 - W) / 2;
  const Y0 = 150;
  const outcomeText = pitch.outcome === 'goal' ? 'GOAL' : pitch.outcome === 'save' ? 'SAVED' : pitch.outcome === 'miss' ? 'WIDE' : '';
  return themedPage(
    theme,
    `.title{position:absolute;left:${X0}px;top:50px;font-size:52px;font-family:${theme.headingFont};color:${theme.text}}
.tag{position:absolute;right:${X0}px;top:66px;font:600 22px ${theme.bodyFont};letter-spacing:4px;color:${theme.muted}}
.out{position:absolute;left:0;right:0;top:420px;text-align:center;font:900 190px ${theme.headingFont};color:#fff;letter-spacing:12px;opacity:0;text-shadow:0 10px 40px rgba(0,0,0,.5)}
svg{position:absolute;left:0;top:0}
.pl{font:700 24px ${theme.bodyFont};fill:#fff;paint-order:stroke;stroke:rgba(0,0,0,.55);stroke-width:5px}`,
    `${pitch.title ? `<div class="title" id="title">${escapeHtml(pitch.title)}</div>` : ''}<div class="tag">RECONSTRUCTION</div><svg width="1920" height="1080" id="svg"></svg><div class="out" id="out">${outcomeText}</div>`,
    `const P=${json(pitch)},X0=${X0},Y0=${Y0},W=${W},H=${H},A=${json(theme.accent)},B=${json(theme.series[1] ?? '#f2f2f2')};
const svg=document.getElementById('svg'),NS='http://www.w3.org/2000/svg';
const mk=(tag,a,parent)=>{const e=document.createElementNS(NS,tag);for(const k in a)e.setAttribute(k,a[k]);(parent||svg).appendChild(e);return e};
const px=(x)=>X0+W*x/100,py=(y)=>Y0+H*y/100;
const field=mk('g',{opacity:0});
for(let i=0;i<12;i++)mk('rect',{x:X0+W*i/12,y:Y0,width:W/12+1,height:H,fill:i%2?'#2f7d3b':'#348a41'},field);
const line=(a)=>mk(a.tag||'rect',Object.assign({fill:'none',stroke:'rgba(255,255,255,.85)','stroke-width':4},a),field);
line({x:X0,y:Y0,width:W,height:H});line({tag:'line',x1:X0+W/2,x2:X0+W/2,y1:Y0,y2:Y0+H});line({tag:'circle',cx:X0+W/2,cy:Y0+H/2,r:H*0.134});
for(const side of [0,1]){const bx=side?X0+W-W*0.157:X0;line({x:bx,y:Y0+H*0.2,width:W*0.157,height:H*0.6});const sx=side?X0+W-W*0.052:X0;line({x:sx,y:Y0+H*0.37,width:W*0.052,height:H*0.26});
line({x:side?X0+W:X0-14,y:Y0+H*0.45,width:14,height:H*0.1})}
const trail=mk('path',{fill:'none',stroke:'#fff','stroke-width':5,'stroke-dasharray':'14 12',opacity:.9});
const pts=P.ball.map(p=>[px(p.x),py(p.y)]);trail.setAttribute('d','M'+pts.map(p=>p.join(' ')).join(' L'));
const tlen=trail.getTotalLength();trail.style.strokeDasharray=tlen;trail.style.strokeDashoffset=tlen;
const players=P.players.map(p=>{const g=mk('g',{opacity:0});mk('circle',{r:24,fill:p.team==='a'?A:B,stroke:'#111','stroke-width':3},g);
const t=mk('text',{y:52,'text-anchor':'middle',class:'pl'},g);t.textContent=p.label;return {g,p}});
const ball=mk('circle',{r:13,fill:'#fff',stroke:'#111','stroke-width':3,opacity:0});
const segs=[];let total=0;for(let i=1;i<pts.length;i++){const l=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);segs.push(l);total+=l}
const at=(f)=>{let d=f*total;for(let i=0;i<segs.length;i++){if(d<=segs[i]||i===segs.length-1){const k=segs[i]?Math.min(1,d/segs[i]):1;return [pts[i][0]+(pts[i+1][0]-pts[i][0])*k,pts[i][1]+(pts[i+1][1]-pts[i][1])*k]}d-=segs[i]}return pts[pts.length-1]};
window.__frame=(t,d)=>{field.setAttribute('opacity',ease(phase(t,0,0.5)));const ti=document.getElementById('title');if(ti)ti.style.opacity=ease(phase(t,0.1,0.4));
const start=0.9,end=Math.max(start+0.8,d*0.8),run=easeInOut(phase(t,start,end-start));
players.forEach((o,i)=>{o.g.setAttribute('opacity',ease(phase(t,0.3+i*0.05,0.35)));const to=o.p.to||o.p;const x=px(o.p.x+(to.x-o.p.x)*run),y=py(o.p.y+(to.y-o.p.y)*run);o.g.setAttribute('transform','translate('+x+' '+y+')')});
const b=at(run);ball.setAttribute('cx',b[0]);ball.setAttribute('cy',b[1]);ball.setAttribute('opacity',ease(phase(t,0.7,0.3)));trail.style.strokeDashoffset=tlen*(1-run);
const o=document.getElementById('out');const hit=phase(t,end,0.35);o.style.opacity=ease(hit)*(P.outcome?1:0);o.style.transform='scale('+(1.3-0.3*ease(hit))+')';
document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}

// --------------------------------------------------------------------------
// Mystery / True Crime: evidence board
// --------------------------------------------------------------------------

export interface EvidenceSpec {
  title?: string;
  items: Array<{ kind: 'photo' | 'note' | 'clipping' | 'place'; label: string; detail?: string }>;
  /** Pairs of item indexes joined by red string, in the order they're drawn. */
  links: Array<[number, number]>;
}

const BOARD_SLOTS: Record<number, Array<[number, number, number]>> = {
  3: [[460, 380, -4], [1000, 560, 3], [1460, 340, -2]],
  4: [[420, 350, -4], [900, 300, 2], [1400, 380, -3], [940, 760, 3]],
  5: [[380, 330, -4], [860, 280, 3], [1380, 330, -2], [620, 760, 2], [1220, 760, -3]],
  6: [[360, 320, -4], [860, 270, 2], [1400, 320, -3], [380, 770, 3], [900, 760, -2], [1420, 780, 4]],
};

/** A board of pinned clues joined by red string; the camera visits each clue in turn, then pulls back. */
export function evidenceBoardTemplate(theme: MotionTheme, board: EvidenceSpec): string {
  const slots = BOARD_SLOTS[Math.max(3, Math.min(6, board.items.length))];
  const items = board.items.slice(0, slots.length).map((it, i) => {
    const [x, y, r] = slots[i];
    const detail = it.detail ? `<div class="d">${escapeHtml(it.detail)}</div>` : '';
    const inner =
      it.kind === 'photo'
        ? `<div class="ph"><div class="sil"></div></div><div class="cap">${escapeHtml(it.label)}</div>${detail}`
        : it.kind === 'clipping'
          ? `<div class="np">${escapeHtml(it.label)}</div>${detail}<div class="cols"></div>`
          : it.kind === 'place'
            ? `<div class="pin-ic">⌖</div><div class="cap">${escapeHtml(it.label)}</div>${detail}`
            : `<div class="hand">${escapeHtml(it.label)}</div>${detail}`;
    return `<div class="it ${it.kind}" id="it${i}" style="left:${x}px;top:${y}px;--r:${r}deg"><span class="tack"></span>${inner}</div>`;
  });
  return themedPage(
    theme,
    `.bg{background:radial-gradient(ellipse at 50% 40%,#7a5a3c,#4a3422 75%)!important}
.board{position:absolute;inset:0;background-image:radial-gradient(rgba(0,0,0,.18) 1px,transparent 1.5px);background-size:9px 9px}
.title{position:absolute;left:120px;top:60px;font:700 40px ${theme.headingFont};color:#f4ead8;letter-spacing:2px;text-transform:uppercase;opacity:.85}
svg{position:absolute;left:0;top:0}
.it{position:absolute;transform:translate(-50%,-50%) rotate(var(--r));opacity:0;box-shadow:0 14px 28px rgba(0,0,0,.45)}
.tack{position:absolute;left:50%;top:-12px;width:26px;height:26px;margin-left:-13px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#ff6b6b,#a50f0f);box-shadow:0 3px 5px rgba(0,0,0,.5);z-index:2}
.photo{background:#f7f5ef;padding:18px 18px 16px;width:330px}
.ph{height:230px;background:linear-gradient(160deg,#5c6670,#2c3238);position:relative;overflow:hidden;filter:grayscale(1)}
.sil{position:absolute;left:50%;bottom:-20px;width:150px;height:200px;margin-left:-75px;background:radial-gradient(circle at 50% 28%,#1b1f23 32px,transparent 33px),radial-gradient(ellipse at 50% 100%,#1b1f23 70px,transparent 71px)}
.cap{font:600 30px 'Segoe Script','Ink Free','Segoe Print',cursive;color:#222;margin-top:12px;text-align:center}
.d{font:400 22px ${theme.bodyFont};color:#444;text-align:center;margin-top:4px}
.note{background:#f6e27a;width:320px;min-height:220px;padding:34px 26px 24px}
.hand{font:600 34px 'Segoe Script','Ink Free','Segoe Print',cursive;color:#2a2a2a;line-height:1.3}
.clipping{background:#efe8d6;width:380px;padding:26px 26px 22px}
.np{font:900 34px Georgia,'Times New Roman',serif;color:#1d1d1d;line-height:1.15;text-transform:uppercase}
.cols{height:70px;margin-top:12px;background:repeating-linear-gradient(#bbb 0 3px,transparent 3px 11px)}
.place{background:#e9f0f3;width:300px;padding:24px;text-align:center}
.pin-ic{font-size:70px;color:#b3261e;line-height:1}`,
    `<div class="board"></div>${board.title ? `<div class="title">${escapeHtml(board.title)}</div>` : ''}<svg width="1920" height="1080" id="svg"></svg>${items.join('')}`,
    `const S=${json(slots.slice(0, items.length))},L=${json(board.links.filter(([a, b]) => a < items.length && b < items.length))};
const svg=document.getElementById('svg'),NS='http://www.w3.org/2000/svg';
const strings=L.map(([a,b])=>{const p=document.createElementNS(NS,'path');const [x1,y1]=S[a],[x2,y2]=S[b];const sag=Math.min(80,Math.hypot(x2-x1,y2-y1)*0.12);
p.setAttribute('d','M'+x1+' '+(y1-110)+' Q'+((x1+x2)/2)+' '+((y1+y2)/2-110+sag)+' '+x2+' '+(y2-110));p.setAttribute('fill','none');p.setAttribute('stroke','#c4161c');p.setAttribute('stroke-width','5');
svg.appendChild(p);const l=p.getTotalLength();p.style.strokeDasharray=l;p.style.strokeDashoffset=l;return {p,l}});
const n=S.length;
window.__frame=(t,d)=>{const visit=Math.max(1.2,d*0.75);
for(let i=0;i<n;i++){const e=document.getElementById('it'+i);const k=ease(phase(t,0.15+i*0.18,0.35));e.style.opacity=k;e.style.transform='translate(-50%,-50%) rotate(var(--r)) scale('+(1.15-0.15*k)+')'}
strings.forEach((s,i)=>{s.p.style.strokeDashoffset=s.l*(1-easeInOut(phase(t,0.6+i*(visit/Math.max(1,strings.length))*0.8,0.6)))});
// The camera moves clue to clue, then pulls back to the whole board
const f=clamp(t/visit)*n;const i=Math.min(n-1,Math.floor(f));const j=Math.min(n-1,i+1);const k=easeInOut(f-i);
const cx=S[i][0]+(S[j][0]-S[i][0])*k,cy=S[i][1]+(S[j][1]-S[i][1])*k;const out=ease(phase(t,visit,Math.max(0.4,d-visit)));const z=1.35-0.35*out;
const tx=(960-cx)*(1-out),ty=(540-cy)*(1-out);document.getElementById('stage').style.transform='translate('+tx+'px,'+ty+'px) scale('+z+')'};`,
  );
}

// --------------------------------------------------------------------------
// History: a letter revealed line by line
// --------------------------------------------------------------------------

export interface LetterSpec {
  writer: string;
  recipient?: string;
  date?: string;
  /** Words the narration or research quotes from the letter. */
  text: string;
}

/** An aged letter on a desk; its words ink in line by line, then the signature. */
export function letterTemplate(theme: MotionTheme, letter: LetterSpec): string {
  const words = letter.text.trim().split(/\s+/).length;
  const size = words > 45 ? 34 : words > 28 ? 40 : 46;
  return themedPage(
    theme,
    `.bg{background:radial-gradient(ellipse at 50% 45%,#3a2c20,#140f0a 80%)!important}
.paper{position:absolute;left:410px;top:90px;width:1100px;height:900px;transform:rotate(-1.5deg);background:radial-gradient(ellipse at 30% 20%,#f3e7c9,#e2cfa2 70%,#c9b07c);box-shadow:0 30px 70px rgba(0,0,0,.6);padding:80px 100px;opacity:0}
.paper:after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(transparent 0 ${size * 1.55 - 1}px,rgba(110,80,40,.12) ${size * 1.55 - 1}px ${size * 1.55}px);pointer-events:none}
.date{text-align:right;font:500 30px 'Segoe Script','Ink Free','Segoe Print',cursive;color:#3b2a18;margin-bottom:30px}
.to{font:600 ${size}px 'Segoe Script','Ink Free','Segoe Print',cursive;color:#2b1d10;margin-bottom:18px}
.body{font:500 ${size}px/${(size * 1.55).toFixed(0)}px 'Segoe Script','Ink Free','Segoe Print',cursive;color:#2b1d10}
.w{opacity:0}
.sig{margin-top:30px;text-align:right;font:600 ${size + 6}px 'Segoe Script','Ink Free','Segoe Print',cursive;color:#2b1d10;opacity:0}`,
    `<div class="paper" id="paper">${letter.date ? `<div class="date">${escapeHtml(letter.date)}</div>` : ''}${letter.recipient ? `<div class="to">${escapeHtml(letter.recipient)},</div>` : ''}<div class="body">${letter.text
      .trim()
      .split(/\s+/)
      .map((w) => `<span class="w">${escapeHtml(w)} </span>`)
      .join('')}</div><div class="sig" id="sig">${escapeHtml(letter.writer)}</div></div>`,
    `const ws=Array.from(document.querySelectorAll('.w'));
window.__frame=(t,d)=>{document.getElementById('paper').style.opacity=ease(phase(t,0,0.5));
const span=Math.max(0.8,d*0.7-0.6);ws.forEach((w,i)=>{w.style.opacity=ease(phase(t,0.5+span*i/ws.length,0.25))});
document.getElementById('sig').style.opacity=ease(phase(t,0.5+span,0.4));document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}

// --------------------------------------------------------------------------
// Car / Tech review: race bars
// --------------------------------------------------------------------------

export interface RaceSpec {
  title: string;
  unit?: string;
  /** True for times (0-60 in 3.2 s beats 4.1 s); false for scores. */
  lower_is_better: boolean;
  items: Array<{ label: string; value: number }>;
}

/**
 * Horizontal bars racing. For times, each bar finishes after a time proportional to its value,
 * so the fastest crosses first; for scores, bars grow to their value together. The winner lights up.
 */
export function raceBarsTemplate(theme: MotionTheme, race: RaceSpec): string {
  const n = race.items.length;
  const best = race.lower_is_better ? Math.min(...race.items.map((i) => i.value)) : Math.max(...race.items.map((i) => i.value));
  const rowH = Math.min(150, 640 / n);
  return themedPage(
    theme,
    `.title{position:absolute;left:150px;top:100px;font-size:58px;font-family:${theme.headingFont};color:${theme.text}}
.unit{position:absolute;left:150px;top:180px;font-size:28px;color:${theme.muted}}
.row{position:absolute;left:150px;width:1620px;height:${rowH * 0.7}px}
.lab{position:absolute;left:0;top:0;width:340px;height:100%;display:flex;align-items:center;font:600 34px ${theme.bodyFont};color:${theme.text}}
.track{position:absolute;left:360px;right:260px;top:0;height:100%;background:rgba(127,127,127,.12);border-radius:8px}
.bar{position:absolute;left:0;top:0;height:100%;width:0;border-radius:8px;background:${theme.series[1] ?? theme.muted}}
.bar.win{background:${theme.accent}}
.val{position:absolute;top:50%;transform:translateY(-50%);font:800 38px ${theme.numberFont};color:${theme.text};opacity:0;white-space:nowrap}
.flag{margin-left:14px;font:700 22px ${theme.bodyFont};letter-spacing:3px;color:${theme.accentText}}`,
    `<div class="title" id="title">${escapeHtml(race.title)}</div>${race.unit ? `<div class="unit">${escapeHtml(race.unit)}</div>` : ''}${race.items
      .map(
        (it, i) =>
          `<div class="row" style="top:${300 + i * rowH}px"><div class="lab">${escapeHtml(it.label)}</div><div class="track"><div class="bar${it.value === best ? ' win' : ''}" id="b${i}"></div><div class="val" id="v${i}"></div></div></div>`,
      )
      .join('')}`,
    `const R=${json(race)},best=${best},max=Math.max(...R.items.map(i=>i.value))||1;
const vals=R.items.map((it,i)=>{const v=document.getElementById('v'+i);v.innerHTML=fmt(it.value,decimalsOf(it.value))+(it.value===best?'<span class="flag">'+(R.lower_is_better?'FASTEST':'TOP')+'</span>':'');return v});
window.__frame=(t,d)=>{document.getElementById('title').style.opacity=ease(phase(t,0,0.4));
const start=0.5,span=Math.max(0.8,d*0.6);
R.items.forEach((it,i)=>{let p;if(R.lower_is_better){const finish=span*it.value/max;p=clamp(phase(t,start,finish))}else{p=easeInOut(phase(t,start,span))}
const w=R.lower_is_better?p:p*it.value/max;const bar=document.getElementById('b'+i);bar.style.width=(w*100)+'%';
vals[i].style.left='calc('+(w*100)+'% + 18px)';vals[i].style.opacity=ease(phase(p,0.97,0.03)+ (R.lower_is_better?0:phase(t,start+span,0.3)))});
document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}

// --------------------------------------------------------------------------
// Space: scale comparison
// --------------------------------------------------------------------------

export interface ScaleSpec {
  title?: string;
  /** Sizes in one unit; drawn as circles to true relative scale, smallest first. */
  items: Array<{ label: string; size: number; unit: string }>;
}

/** Things shown side by side at true relative size; the camera pulls back as each larger one arrives. */
export function scaleTemplate(theme: MotionTheme, scale: ScaleSpec): string {
  const items = [...scale.items].sort((a, b) => a.size - b.size);
  return themedPage(
    theme,
    `.title{position:absolute;left:150px;top:90px;font-size:54px;font-family:${theme.headingFont};color:${theme.text};z-index:2}
svg{position:absolute;left:0;top:0}
.lb{font:700 30px ${theme.bodyFont};fill:${theme.text};text-anchor:middle}
.sz{font:500 24px ${theme.numberFont};fill:${theme.muted};text-anchor:middle}`,
    `${scale.title ? `<div class="title" id="title">${escapeHtml(scale.title)}</div>` : ''}<svg width="1920" height="1080"><g id="world"></g></svg>`,
    `const I=${json(items)},C=${json(theme.series)},A=${json(theme.accent)};
const world=document.getElementById('world'),NS='http://www.w3.org/2000/svg';
// Circles sit on one baseline, each after the last with a gap; positions in "size" units
let x=0;const pos=I.map((it,i)=>{const r=it.size/2;const cx=x+r;x+=it.size+Math.max(it.size*0.25,I[0].size*0.6);return {cx,r}});
const nodes=I.map((it,i)=>{const g=document.createElementNS(NS,'g');g.setAttribute('opacity',0);
const c=document.createElementNS(NS,'circle');c.setAttribute('fill',i===I.length-1?A:C[i%C.length]);g.appendChild(c);
const lb=document.createElementNS(NS,'text');lb.setAttribute('class','lb');lb.textContent=it.label;g.appendChild(lb);
const sz=document.createElementNS(NS,'text');sz.setAttribute('class','sz');sz.textContent=fmt(it.size,decimalsOf(it.size))+' '+it.unit;g.appendChild(sz);world.appendChild(g);return {g,c,lb,sz}});
window.__frame=(t,d)=>{const ti=document.getElementById('title');if(ti)ti.style.opacity=ease(phase(t,0,0.4));
const step=Math.max(0.6,(d*0.85-0.3)/I.length);const f=clamp((t-0.3)/step,0,I.length-1+0.999);const k=Math.floor(f);const e=easeInOut(f-k);
// The view fits everything shown so far, easing from one item's fit to the next's
const fit=(j)=>{const right=pos[j].cx+pos[j].r,height=pos[j].r*2;return Math.min(1500/right,600/height)};
const s=fit(k)+(fit(Math.min(I.length-1,k+1))-fit(k))*e;const base=820;
nodes.forEach((n,i)=>{const p=pos[i];const r=p.r*s;n.c.setAttribute('cx',210+p.cx*s);n.c.setAttribute('cy',base-r);n.c.setAttribute('r',Math.max(0.6,r));
const show=ease(phase(t,0.3+step*i,0.4));n.g.setAttribute('opacity',show);
// Above the circle when there's room, otherwise inside it
const ly=base-2*r-24>=230?base-2*r-24:base-r;n.lb.setAttribute('x',210+p.cx*s);n.lb.setAttribute('y',ly);n.sz.setAttribute('x',210+p.cx*s);n.sz.setAttribute('y',base+44);
// Things too small to label beside them go in a legend under the title, a bullet in their colour
const tiny=r<30;n.lb.textContent=tiny?I[i].label+' · '+fmt(I[i].size,decimalsOf(I[i].size))+' '+I[i].unit:I[i].label;n.sz.setAttribute('opacity',tiny?0:1);
if(tiny){const order=I.slice(0,i+1).filter((_,j)=>pos[j].r*s<30).length-1;n.lb.setAttribute('x',150);n.lb.setAttribute('y',250+order*46);n.lb.style.textAnchor='start';n.lb.textContent='● '+n.lb.textContent;n.lb.style.fill=n.c.getAttribute('fill')}else{n.lb.style.textAnchor='middle';n.lb.style.fill=''}});document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}
