import { escapeHtml, themedPage } from './templates';
import type { MotionTheme } from './theme';
import { motionDocument } from './frame-renderer';

/**
 * A drawing appearing as if sketched live: its lines trace in outward from the subject (focusX,
 * focusY, 0-1 of the drawing) with a ragged, hand-drawn front, on the page colour. The drawing is
 * placed exactly as the camera's first frame shows it (fitted and centred at 1920x1080), so the
 * camera move that follows joins seamlessly. Ends with the whole drawing shown.
 */
export function drawingRevealTemplate(options: { imageUrl: string; page: string; focusX: number; focusY: number }): string {
  const fx = Math.min(1, Math.max(0, options.focusX));
  const fy = Math.min(1, Math.max(0, options.focusY));
  return motionDocument({
    css: `body{background:${options.page}}canvas{position:absolute;inset:0}`,
    body: '<canvas id="c" width="1920" height="1080"></canvas>',
    script: `const W=1920,H=1080,GW=192,GH=108;
const img=new Image();img.src=${JSON.stringify(options.imageUrl)};
const main=document.getElementById('c').getContext('2d');
const art=document.createElement('canvas');art.width=W;art.height=H;const actx=art.getContext('2d');
const tmp=document.createElement('canvas');tmp.width=W;tmp.height=H;const tctx=tmp.getContext('2d');
const mask=document.createElement('canvas');mask.width=GW;mask.height=GH;const mctx=mask.getContext('2d');
const md=mctx.createImageData(GW,GH);let tmap=null;
// Seeded value noise, so a re-render draws the same way
let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647};
const LW=14,LH=9;const lat=Array.from({length:LW*LH},rnd);
const noise=(u,v)=>{const x=u*(LW-1),y=v*(LH-1),i=Math.floor(x),j=Math.floor(y),a=x-i,b=y-j;
  const g=(p,q)=>lat[Math.min(LH-1,q)*LW+Math.min(LW-1,p)];
  return g(i,j)*(1-a)*(1-b)+g(i+1,j)*a*(1-b)+g(i,j+1)*(1-a)*b+g(i+1,j+1)*a*b};
window.__ready=async()=>{await img.decode();
  const s=Math.min(W/img.naturalWidth,H/img.naturalHeight),dw=img.naturalWidth*s,dh=img.naturalHeight*s,dx=(W-dw)/2,dy=(H-dh)/2;
  actx.drawImage(img,dx,dy,dw,dh);
  // Each cell's moment to appear: its distance from the subject, roughened by noise
  const cx=(dx+${fx}*dw)/W,cy=(dy+${fy}*dh)/H;const far=Math.hypot(Math.max(cx,1-cx),Math.max(cy,1-cy)*H/W);
  tmap=new Float32Array(GW*GH);
  for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){const u=x/(GW-1),v=y/(GH-1);
    tmap[y*GW+x]=0.72*Math.hypot(u-cx,(v-cy)*H/W)/far+0.28*noise(u,v)}};
window.__frame=(t,d)=>{
  const k=Math.min(1,t/Math.max(0.01,d-1/30));const th=k*1.12;
  for(let i=0;i<GW*GH;i++){const a=Math.max(0,Math.min(1,(th-tmap[i])/0.1));md.data[i*4+3]=Math.round(a*255)}
  mctx.putImageData(md,0,0);
  tctx.globalCompositeOperation='source-over';tctx.clearRect(0,0,W,H);tctx.drawImage(art,0,0);
  tctx.globalCompositeOperation='destination-in';tctx.imageSmoothingEnabled=true;tctx.drawImage(mask,0,0,W,H);
  main.fillStyle=${JSON.stringify(options.page)};main.fillRect(0,0,W,H);main.drawImage(tmp,0,0);
};`,
  });
}

/**
 * Motion pages for the stickman styles. They use the video's doodle theme (handwriting fonts,
 * paper colours), so the cards look drawn on the same page as the creator's pictures.
 */

/**
 * A Bible verse card: the reference with a hand-drawn underline, then the verse words appearing in
 * reading order on a slightly tilted paper card, with the translation named small beneath.
 * `text` must be the translation's own words (fetched by reference), never paraphrase.
 */
export function verseTemplate(theme: MotionTheme, verse: { reference: string; text: string; translation: string }): string {
  const words = verse.text.trim().split(/\s+/).map(escapeHtml);
  const size = words.length > 55 ? 44 : words.length > 35 ? 52 : words.length > 20 ? 62 : 74;
  return themedPage(
    theme,
    `.card{position:absolute;left:210px;right:210px;top:130px;bottom:130px;background:${theme.surface};border:4px solid ${theme.text};border-radius:${theme.radius}px;
box-shadow:10px 12px 0 ${theme.text}22;transform:rotate(-1.2deg);padding:70px 100px;display:flex;flex-direction:column;justify-content:center;opacity:0}
.ref{font-family:${theme.headingFont};font-size:70px;color:${theme.accentText};line-height:1}
.line{display:block;margin:18px 0 44px}
.line path{fill:none;stroke:${theme.accent};stroke-width:12;stroke-linecap:round}
.text{font-family:${theme.bodyFont};font-size:${size}px;line-height:1.35;color:${theme.text}}
.text span{opacity:0;display:inline-block;margin-right:.26em}
.tr{margin-top:40px;font-family:${theme.bodyFont};font-size:30px;color:${theme.muted};opacity:0}`,
    `<div class="card" id="card"><div class="ref">${escapeHtml(verse.reference)}</div>
<svg class="line" width="560" height="30" viewBox="0 0 560 30"><path id="ul" d="M6 18 C 120 6, 260 26, 380 14 S 520 10, 554 16"/></svg>
<div class="text">${words.map((w, i) => `<span id="w${i}">${w}</span>`).join('')}</div>
<div class="tr" id="tr">${escapeHtml(verse.translation)}</div></div>`,
    `const n=${words.length};const ul=document.getElementById('ul');const len=ul.getTotalLength();ul.style.strokeDasharray=len;
window.__frame=(t,d)=>{
  const c=ease(phase(t,0,0.35));const card=document.getElementById('card');
  card.style.opacity=c;card.style.transform='rotate(-1.2deg) translateY('+(40*(1-c))+'px)';
  ul.style.strokeDashoffset=len*(1-ease(phase(t,0.25,0.5)));
  const span=Math.max(0.8,d*0.55);
  for(let i=0;i<n;i++){const p=ease(phase(t,0.45+span*i/n,0.3));const s=document.getElementById('w'+i);s.style.opacity=p;s.style.transform='translateY('+(14*(1-p))+'px)'}
  document.getElementById('tr').style.opacity=ease(phase(t,0.45+span,0.5));
  document.getElementById('stage').style.transform=drift(t,d);
};`,
  );
}
