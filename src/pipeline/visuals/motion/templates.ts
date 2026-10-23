import { baseCss, type MotionTheme } from './theme';
import { motionDocument } from './frame-renderer';

/**
 * Motion-graphics templates. Each returns a page whose `window.__frame(t, d)` draws the graphic
 * at time t of a d-second shot. Entrances finish in the first ~45% of the shot, then a slow drift
 * keeps the frame alive until the cut. Text is HTML-escaped; all data comes from verified specs.
 */

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Animation helpers shared by every template (inlined into the page). */
export const HELPERS = `
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const ease=(x)=>1-Math.pow(1-clamp(x),3);
const easeInOut=(x)=>{x=clamp(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2};
const phase=(t,start,len)=>clamp((t-start)/len);
const fmt=(v,decimals)=>v.toLocaleString('en-US',{minimumFractionDigits:decimals,maximumFractionDigits:decimals});
const decimalsOf=(v)=>{const s=String(v);return s.includes('.')?Math.min(2,s.split('.')[1].length):0};
const drift=(t,d)=>'scale('+(1+0.025*clamp(t/d))+')';
`;

/** A themed 1920x1080 motion page: background, stage, helpers (ease, phase, drift) and window.__frame. */
export function themedPage(theme: MotionTheme, css: string, body: string, script: string): string {
  return page(theme, css, body, script);
}

function page(theme: MotionTheme, css: string, body: string, script: string): string {
  return motionDocument({
    css: `${baseCss(theme)}
.stage{position:absolute;inset:0;transform-origin:50% 50%}
h1,.heading{font-family:${theme.headingFont}}
.num{font-family:${theme.numberFont};font-variant-numeric:tabular-nums}
${css}`,
    body: `<div class="bg"></div><div class="stage" id="stage">${body}</div>`,
    script: `${HELPERS}\n${script}`,
  });
}

// --------------------------------------------------------------------------
// Stat: one big number counting up
// --------------------------------------------------------------------------

export function statTemplate(theme: MotionTheme, stat: { value: number; prefix?: string; suffix?: string; label: string }): string {
  return page(
    theme,
    `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.value{font-size:250px;font-weight:700;color:${theme.text};letter-spacing:-4px;line-height:1}
.value .affix{color:${theme.accentText}}
.rule{height:10px;background:${theme.accent};margin:34px 0 30px;width:0}
.label{font-size:52px;color:${theme.muted};max-width:1400px;text-align:center;font-family:${theme.headingFont}}`,
    `<div class="wrap"><div class="value num"><span class="affix">${escapeHtml(stat.prefix ?? '')}</span><span id="v">0</span><span class="affix">${escapeHtml(stat.suffix ?? '')}</span></div>
<div class="rule" id="rule"></div><div class="label" id="label">${escapeHtml(stat.label)}</div></div>`,
    `const target=${JSON.stringify(stat.value)},dec=decimalsOf(target);
window.__frame=(t,d)=>{
  const c=ease(phase(t,0.1,Math.min(1.6,d*0.45)));
  document.getElementById('v').textContent=fmt(target*c,dec);
  document.getElementById('rule').style.width=(560*ease(phase(t,0.5,0.6)))+'px';
  const l=ease(phase(t,0.7,0.5));const lab=document.getElementById('label');
  lab.style.opacity=l;lab.style.transform='translateY('+(30*(1-l))+'px)';
  document.getElementById('stage').style.transform=drift(t,d);
};`,
  );
}

// --------------------------------------------------------------------------
// Quote card: words revealed in reading order
// --------------------------------------------------------------------------

export function quoteTemplate(theme: MotionTheme, quote: { text: string; attribution: string }): string {
  const words = quote.text.trim().split(/\s+/).map(escapeHtml);
  return page(
    theme,
    `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 240px}
.mark{font-family:${theme.headingFont};font-size:300px;line-height:.6;color:${theme.accent};height:150px}
.quote{font-family:${theme.headingFont};font-size:${words.length > 18 ? 66 : 84}px;line-height:1.25;color:${theme.text}}
.quote span{opacity:0;display:inline-block;margin-right:.28em}
.attr{margin-top:56px;font-size:40px;color:${theme.muted};letter-spacing:2px;text-transform:uppercase;opacity:0}
.attr::before{content:'';display:inline-block;width:70px;height:4px;background:${theme.accent};vertical-align:middle;margin-right:24px}`,
    `<div class="wrap"><div class="mark" id="mark">&ldquo;</div>
<div class="quote">${words.map((w, i) => `<span id="w${i}">${w}</span>`).join('')}</div>
<div class="attr" id="attr">${escapeHtml(quote.attribution)}</div></div>`,
    `const n=${words.length};
window.__frame=(t,d)=>{
  document.getElementById('mark').style.opacity=ease(phase(t,0,0.4));
  const span=Math.max(0.8,d*0.5);
  for(let i=0;i<n;i++){const p=ease(phase(t,0.25+span*i/n,0.35));const s=document.getElementById('w'+i);s.style.opacity=p;s.style.transform='translateY('+(18*(1-p))+'px)'}
  const a=ease(phase(t,0.25+span,0.5));document.getElementById('attr').style.opacity=a;
  document.getElementById('stage').style.transform=drift(t,d);
};`,
  );
}

// --------------------------------------------------------------------------
// Charts: line (draws), bar (grows), pie (sweeps)
// --------------------------------------------------------------------------

export interface ChartData {
  chart_type: 'line' | 'bar' | 'pie';
  title: string;
  unit?: string;
  labels: string[];
  values: number[];
  /** Callouts on points or bars ("the crash"), shown once the data has drawn in. */
  annotations?: Array<{ index: number; text: string }>;
}

/** Callout boxes for annotated charts, appended to a chart page's script (needs pts or bars, and drawEnd). */
const CALLOUTS = `const ANN=(D.ann||[]).filter(a=>a.index>=0&&a.index<D.values.length);
const callouts=ANN.map((a,i)=>{const p=anchor(a.index);const up=p[1]>520;const ty=up?p[1]-170:p[1]+120;
const ln=mk('line',{x1:p[0],y1:p[1]+(up?-20:20),x2:p[0],y2:ty+(up?56:0),stroke:D.accent,'stroke-width':4,opacity:0});
const ring=mk('circle',{cx:p[0],cy:p[1],r:26,fill:'none',stroke:D.accent,'stroke-width':5,opacity:0});
const box=document.createElement('div');box.className='callout';box.textContent=a.text;box.style.left=Math.min(1560,Math.max(160,p[0]-150))+'px';box.style.top=ty+'px';document.getElementById('stage').appendChild(box);
return {ln,ring,box,i}});
const showCallouts=(t,d,drawEnd)=>{callouts.forEach(c=>{const k=ease(phase(t,drawEnd+0.15+c.i*0.35,0.4));c.ln.setAttribute('opacity',k);c.ring.setAttribute('opacity',k);c.ring.setAttribute('r',26+10*(1-k));c.box.style.opacity=k;c.box.style.transform='translateY('+(12*(1-k))+'px)'})};`;

export function chartTemplate(theme: MotionTheme, chart: ChartData, sourceNote?: string): string {
  const css = `.callout{position:absolute;width:300px;padding:12px 16px;background:${theme.accent};color:#fff;font:700 26px ${theme.bodyFont};border-radius:6px;opacity:0;box-shadow:0 8px 20px rgba(0,0,0,.3)}
.title{position:absolute;left:150px;top:100px;font-size:60px;font-family:${theme.headingFont};color:${theme.text};max-width:1500px}
.unit{position:absolute;left:150px;top:184px;font-size:30px;color:${theme.muted};letter-spacing:1px}
.source{position:absolute;left:150px;bottom:56px;font-size:24px;color:${theme.muted}}
svg{position:absolute;left:0;top:0}
.lbl{font-size:30px;fill:${theme.muted};font-family:${theme.bodyFont}}
.val{font-size:44px;fill:${theme.text};font-weight:700;font-family:${theme.numberFont}}`;
  const head = `<div class="title" id="title">${escapeHtml(chart.title)}</div>${chart.unit ? `<div class="unit">${escapeHtml(chart.unit)}</div>` : ''}${sourceNote ? `<div class="source">${escapeHtml(sourceNote)}</div>` : ''}`;
  const data = JSON.stringify({ labels: chart.labels, values: chart.values, colors: theme.series, grid: theme.muted, accent: theme.accent, text: theme.text, bg: theme.background, ann: chart.annotations ?? [] }).replace(/</g, '\\u003c');

  if (chart.chart_type === 'pie') {
    return page(theme, css, `${head}<svg width="1920" height="1080" id="svg"></svg>`, `const D=${data};
const svg=document.getElementById('svg'),NS='http://www.w3.org/2000/svg';
const total=D.values.reduce((a,b)=>a+b,0)||1,cx=760,cy=600,r=330;
const arcs=D.values.map((v,i)=>{const p=document.createElementNS(NS,'path');p.setAttribute('fill',D.colors[i%D.colors.length]);svg.appendChild(p);return p});
const legend=D.labels.map((l,i)=>{const g=document.createElementNS(NS,'text');g.setAttribute('x',1220);g.setAttribute('y',420+i*90);g.setAttribute('class','lbl');g.style.fontSize='38px';g.textContent=l+'  '+Math.round(D.values[i]/total*100)+'%';svg.appendChild(g);return g});
const arc=(a0,a1)=>{const x0=cx+r*Math.sin(a0),y0=cy-r*Math.cos(a0),x1=cx+r*Math.sin(a1),y1=cy-r*Math.cos(a1);return 'M'+cx+' '+cy+' L'+x0+' '+y0+' A'+r+' '+r+' 0 '+(a1-a0>Math.PI?1:0)+' 1 '+x1+' '+y1+' Z'};
window.__frame=(t,d)=>{const sweep=easeInOut(phase(t,0.2,Math.min(1.8,d*0.45)))*Math.PI*2;let a=0;
D.values.forEach((v,i)=>{const s=v/total*Math.PI*2;const end=Math.min(a+s,sweep);arcs[i].setAttribute('d',end>a?arc(a,end):'');legend[i].style.opacity=ease(phase(t,0.4+i*0.15,0.4));a+=s});
document.getElementById('title').style.opacity=ease(phase(t,0,0.4));document.getElementById('stage').style.transform=drift(t,d)};`);
  }

  if (chart.chart_type === 'bar') {
    return page(theme, css, `${head}<svg width="1920" height="1080" id="svg"></svg>`, `const D=${data};
const svg=document.getElementById('svg'),NS='http://www.w3.org/2000/svg';
const L=220,R=1770,T=290,B=900,n=D.values.length,max=Math.max(...D.values,0)*1.12||1;
const slot=(R-L)/n,bw=Math.min(260,slot*0.58);
const mk=(tag,attrs,text)=>{const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;svg.appendChild(e);return e};
mk('line',{x1:L,x2:R,y1:B,y2:B,stroke:D.grid,'stroke-width':3,opacity:.6});
const bars=D.values.map((v,i)=>{const x=L+slot*i+(slot-bw)/2;
  mk('text',{x:x+bw/2,y:B+56,'text-anchor':'middle',class:'lbl'},D.labels[i]);
  return {rect:mk('rect',{x,width:bw,y:B,height:0,fill:i===n-1?D.accent:D.colors[(i+1)%D.colors.length],rx:4}),
    val:mk('text',{x:x+bw/2,y:B,'text-anchor':'middle',class:'val'},''),v,x}});
bars.forEach(b=>{b.val.textContent=fmt(b.v,decimalsOf(b.v));b.val.setAttribute('y',B-(B-T)*b.v/max-22)});
const anchor=(i)=>[bars[i].x+bw/2,B-(B-T)*bars[i].v/max-80];
${CALLOUTS}
window.__frame=(t,d)=>{const grow=Math.min(1.4,d*0.4);showCallouts(t,d,0.25+n*0.18+grow);
bars.forEach((b,i)=>{const start=0.25+i*0.18;const p=ease(phase(t,start,grow));const h=(B-T)*b.v/max*p;b.rect.setAttribute('y',B-h);b.rect.setAttribute('height',h);
// The exact value fades in once its bar is up; counting would flash wrong numbers on screen
b.val.style.opacity=ease(phase(t,start+grow*0.85,0.3))});
document.getElementById('title').style.opacity=ease(phase(t,0,0.4));document.getElementById('stage').style.transform=drift(t,d)};`);
  }

  return page(theme, css, `${head}<svg width="1920" height="1080" id="svg"></svg>`, `const D=${data};
const svg=document.getElementById('svg'),NS='http://www.w3.org/2000/svg';
const L=230,R=1700,T=300,B=880,n=D.values.length;
const lo=Math.min(0,...D.values),hi=Math.max(...D.values)*1.12||1;
const X=(i)=>n===1?(L+R)/2:L+(R-L)*i/(n-1),Y=(v)=>B-(B-T)*(v-lo)/(hi-lo);
const mk=(tag,attrs,text)=>{const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;svg.appendChild(e);return e};
for(let g=0;g<=4;g++){const y=T+(B-T)*g/4;mk('line',{x1:L,x2:R,y1:y,y2:y,stroke:D.grid,'stroke-width':2,opacity:.25})}
D.labels.forEach((l,i)=>mk('text',{x:X(i),y:B+60,'text-anchor':'middle',class:'lbl'},l));
const pts=D.values.map((v,i)=>[X(i),Y(v)]);
const area=mk('path',{d:'M'+pts.map(p=>p.join(' ')).join(' L')+' L'+X(n-1)+' '+B+' L'+X(0)+' '+B+' Z',fill:D.accent,opacity:0});
const line=mk('path',{d:'M'+pts.map(p=>p.join(' ')).join(' L'),fill:'none',stroke:D.accent,'stroke-width':9,'stroke-linejoin':'round','stroke-linecap':'round'});
const len=line.getTotalLength();line.style.strokeDasharray=len;
const dots=pts.map(p=>mk('circle',{cx:p[0],cy:p[1],r:0,fill:D.bg,stroke:D.accent,'stroke-width':7}));
// Values always show their exact figure; they fade in as the line reaches each point
const vals=D.values.map((v,i)=>mk('text',{x:pts[i][0],y:pts[i][1]-34,'text-anchor':'middle',class:'val'},fmt(v,decimalsOf(v))));
const anchor=(i)=>pts[i];
${CALLOUTS}
window.__frame=(t,d)=>{const draw=easeInOut(phase(t,0.3,Math.min(2.2,d*0.5)));showCallouts(t,d,0.3+Math.min(2.2,d*0.5));line.style.strokeDashoffset=len*(1-draw);
area.setAttribute('opacity',0.12*draw);
pts.forEach((p,i)=>{const at=n===1?1:i/(n-1);const show=ease(phase(draw,at-0.12,0.12));dots[i].setAttribute('r',13*show);vals[i].style.opacity=show});
document.getElementById('title').style.opacity=ease(phase(t,0,0.4));document.getElementById('stage').style.transform=drift(t,d)};`);
}

// --------------------------------------------------------------------------
// Headline card: a labelled recreation, never a fake masthead
// --------------------------------------------------------------------------

export function headlineTemplate(theme: MotionTheme, paper: { outlet: string; date: string; headline: string }): string {
  return page(
    theme,
    `.card{position:absolute;left:260px;right:260px;top:210px;bottom:250px;background:#f3ecdc;border-radius:4px;
box-shadow:0 30px 80px rgba(0,0,0,.45);padding:110px 120px;display:flex;align-items:center;justify-content:center;
background-image:radial-gradient(rgba(120,100,60,.12) 1px,transparent 1px);background-size:6px 6px}
.headline{font-family:Georgia,"Times New Roman",serif;font-weight:700;font-size:96px;line-height:1.18;color:#1a1712;text-align:center;
text-transform:uppercase}
.mark{background-image:linear-gradient(${theme.accent},${theme.accent});background-repeat:no-repeat;background-position:0 88%;
background-size:0% 38%;-webkit-box-decoration-break:clone;box-decoration-break:clone;padding:0 8px}
.caption{position:absolute;left:260px;bottom:150px;font-size:36px;color:${theme.text};font-family:${theme.headingFont};font-style:italic}
.tag{position:absolute;right:260px;bottom:156px;font-size:22px;letter-spacing:3px;color:${theme.muted};text-transform:uppercase}`,
    `<div class="card" id="card"><div class="headline"><span class="mark" id="hl">${escapeHtml(paper.headline)}</span></div></div>
<div class="caption" id="cap">${escapeHtml(paper.outlet)}${paper.date ? `, ${escapeHtml(paper.date)}` : ''}</div>
<div class="tag" id="tag">Headline recreation</div>`,
    `window.__frame=(t,d)=>{const c=ease(phase(t,0,0.6));const card=document.getElementById('card');
card.style.opacity=c;card.style.transform='translateY('+(60*(1-c))+'px) rotate('+(-1.2*(1-c)-0.4)+'deg)';
document.getElementById('hl').style.backgroundSize=(100*ease(phase(t,0.7,0.8)))+'% 38%';
const cap=ease(phase(t,0.5,0.5));document.getElementById('cap').style.opacity=cap;document.getElementById('tag').style.opacity=cap*0.9;
document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}

// --------------------------------------------------------------------------
// Timeline, comparison, chapter title, kinetic text
// --------------------------------------------------------------------------

export function timelineTemplate(theme: MotionTheme, events: Array<{ date: string; label: string }>): string {
  const items = events.slice(0, 6);
  return page(
    theme,
    `.axis{position:absolute;left:160px;right:160px;top:540px;height:6px;background:${theme.muted};opacity:.35;transform-origin:left}
.ev{position:absolute;top:0;width:300px;margin-left:-150px;text-align:center}
.dot{position:absolute;top:526px;left:50%;width:34px;height:34px;margin-left:-17px;border-radius:50%;background:${theme.accent}}
.date{position:absolute;left:0;right:0;top:420px;font-size:56px;font-weight:700;color:${theme.text}}
.lab{position:absolute;left:0;right:0;top:600px;font-size:32px;line-height:1.3;color:${theme.muted};font-family:${theme.headingFont}}`,
    `<div class="axis" id="axis"></div>${items
      .map((e, i) => {
        const x = items.length === 1 ? 960 : 260 + (1400 * i) / (items.length - 1);
        return `<div class="ev" id="e${i}" style="left:${x}px"><div class="date num">${escapeHtml(e.date)}</div><div class="dot"></div><div class="lab">${escapeHtml(e.label)}</div></div>`;
      })
      .join('')}`,
    `const n=${items.length};window.__frame=(t,d)=>{document.getElementById('axis').style.transform='scaleX('+easeInOut(phase(t,0,Math.min(1.2,d*0.3)))+')';
const span=Math.max(0.6,d*0.55);for(let i=0;i<n;i++){const p=ease(phase(t,0.4+span*i/n,0.45));const e=document.getElementById('e'+i);e.style.opacity=p;e.style.transform='translateY('+(40*(1-p))+'px)'}
document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}

export function comparisonTemplate(
  theme: MotionTheme,
  left: { value: string; label: string },
  right: { value: string; label: string },
  title?: string,
): string {
  return page(
    theme,
    `.title{position:absolute;top:220px;left:0;right:0;text-align:center;font-size:54px;font-family:${theme.headingFont};color:${theme.text}}
.col{position:absolute;top:400px;width:700px;text-align:center}
.v{font-size:170px;font-weight:700;line-height:1;color:${theme.text}}
.col.right .v{color:${theme.accentText}}
.l{margin-top:30px;font-size:44px;color:${theme.muted};font-family:${theme.headingFont}}
.vs{position:absolute;left:910px;top:500px;width:100px;text-align:center;font-size:56px;color:${theme.muted};font-style:italic;font-family:${theme.headingFont}}`,
    `${title ? `<div class="title" id="title">${escapeHtml(title)}</div>` : ''}
<div class="col" id="a" style="left:180px"><div class="v num">${escapeHtml(left.value)}</div><div class="l">${escapeHtml(left.label)}</div></div>
<div class="vs" id="vs">vs</div>
<div class="col right" id="b" style="left:1040px"><div class="v num">${escapeHtml(right.value)}</div><div class="l">${escapeHtml(right.label)}</div></div>`,
    `window.__frame=(t,d)=>{const a=ease(phase(t,0.1,0.6)),v=ease(phase(t,0.5,0.4)),b=ease(phase(t,Math.min(d*0.35,1.2),0.6));
const A=document.getElementById('a'),B=document.getElementById('b');A.style.opacity=a;A.style.transform='translateX('+(-80*(1-a))+'px)';
B.style.opacity=b;B.style.transform='translateX('+(80*(1-b))+'px)';document.getElementById('vs').style.opacity=v;
const T=document.getElementById('title');if(T)T.style.opacity=ease(phase(t,0,0.4));document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}

export function titleTemplate(theme: MotionTheme, title: { text: string; kicker?: string }): string {
  return page(
    theme,
    `.wrap{position:absolute;left:200px;right:200px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center}
.kicker{font-size:34px;letter-spacing:8px;text-transform:uppercase;color:${theme.accentText};margin-bottom:34px}
.t{font-family:${theme.headingFont};font-size:118px;line-height:1.05;color:${theme.text}}
.bar{height:12px;background:${theme.accent};width:0;margin-top:48px}`,
    `<div class="wrap">${title.kicker ? `<div class="kicker" id="k">${escapeHtml(title.kicker)}</div>` : ''}<div class="t" id="t">${escapeHtml(title.text)}</div><div class="bar" id="bar"></div></div>`,
    `window.__frame=(t,d)=>{const k=document.getElementById('k');if(k)k.style.opacity=ease(phase(t,0,0.5));
const p=ease(phase(t,0.15,0.7));const T=document.getElementById('t');T.style.opacity=p;T.style.transform='translateY('+(50*(1-p))+'px)';
document.getElementById('bar').style.width=(420*ease(phase(t,0.6,0.7)))+'px';document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}

/**
 * Lower-third name caption, drawn on a transparent page to overlay footage. Light text on a dark
 * translucent panel reads over any footage, whatever the theme; the accent bar carries the theme.
 */
export function lowerThirdDocument(theme: MotionTheme, caption: { name: string; detail?: string }): string {
  return motionDocument({
    css: `html,body{background:transparent}
.lt{position:absolute;left:120px;bottom:130px;display:flex;align-items:stretch;filter:drop-shadow(0 8px 24px rgba(0,0,0,.35))}
.bar{width:12px;background:${theme.accent}}
.panel{background:rgba(10,10,12,.78);padding:22px 40px 24px 30px}
.name{font-family:${theme.headingFont};font-size:54px;font-weight:700;color:#f6f3ec;line-height:1.1}
.detail{margin-top:8px;font-family:${theme.bodyFont};font-size:30px;color:#c9c4b8;letter-spacing:.5px}`,
    body: `<div class="lt"><div class="bar"></div><div class="panel"><div class="name">${escapeHtml(caption.name)}</div>${
      caption.detail ? `<div class="detail">${escapeHtml(caption.detail)}</div>` : ''
    }</div></div>`,
    script: '',
  });
}

export function kineticTextTemplate(theme: MotionTheme, phrase: string, emphasis: string[] = []): string {
  const words = phrase.trim().split(/\s+/);
  const emph = new Set(emphasis.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')));
  return page(
    theme,
    `.wrap{position:absolute;left:180px;right:180px;top:0;bottom:0;display:flex;flex-wrap:wrap;align-content:center;justify-content:center;gap:10px 34px}
.w{font-family:${theme.headingFont};font-size:${words.length > 8 ? 92 : 124}px;font-weight:700;color:${theme.text};opacity:0;line-height:1.1}
.w.e{color:${theme.accentText}}`,
    `<div class="wrap">${words
      .map((w, i) => `<span class="w${emph.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) ? ' e' : ''}" id="w${i}">${escapeHtml(w)}</span>`)
      .join('')}</div>`,
    `const n=${words.length};window.__frame=(t,d)=>{const span=Math.max(0.6,d*0.45);
for(let i=0;i<n;i++){const p=ease(phase(t,0.1+span*i/n,0.3));const w=document.getElementById('w'+i);w.style.opacity=p;w.style.transform='scale('+(0.8+0.2*p)+')'}
document.getElementById('stage').style.transform=drift(t,d)};`,
  );
}
