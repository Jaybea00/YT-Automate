import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { MotionTheme } from './motion/theme';
import { escapeHtml } from './motion/templates';

/**
 * The label or speech bubble on a stickman drawing, drawn as a transparent 3840x2160 layer in the
 * drawing's page coordinates, so the camera moves it exactly with the drawing. Laid out in the
 * browser, where the text can be measured: a label sits in whichever corner around its target has
 * room (clear of the captions at the bottom) with a curved hand-drawn arrow to it; a bubble sits
 * above the speaker's head, or beside it, with a tail pointing at them.
 */

export const LAYER_WIDTH = 3840;
export const LAYER_HEIGHT = 2160;

/** A box on the page, in pixels: [ymin, xmin, ymax, xmax]. */
export type PageBox = [number, number, number, number];

export interface NoteLayerSpec {
  label?: { text: string; target: PageBox };
  bubble?: { text: string; speaker: PageBox };
}

export function noteLayerHtml(spec: NoteLayerSpec, theme: MotionTheme): string {
  const label = spec.label ? { text: escapeHtml(spec.label.text), box: spec.label.target } : null;
  const bubble = spec.bubble ? { text: escapeHtml(spec.bubble.text), box: spec.bubble.speaker } : null;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${LAYER_WIDTH}px;height:${LAYER_HEIGHT}px;background:transparent;overflow:hidden}
.label{position:absolute;font-family:${theme.headingFont};font-size:138px;font-weight:700;line-height:1.05;color:${theme.accentText};
  -webkit-text-stroke:26px #fff;paint-order:stroke fill;white-space:nowrap;padding:0 8px}
.bubble{position:absolute;max-width:1250px;padding:44px 64px;background:#fff;border:9px solid #1d1d1d;border-radius:90px;
  font-family:${theme.bodyFont};font-size:86px;line-height:1.18;color:#1d1d1d;text-align:center}
svg{position:absolute;inset:0;overflow:visible}
</style></head><body>
<svg id="ink" width="${LAYER_WIDTH}" height="${LAYER_HEIGHT}"></svg>
${label ? `<div class="label" id="label">${label.text}</div>` : ''}
${bubble ? `<div class="bubble" id="bubble">${bubble.text}</div>` : ''}
<script>document.fonts.ready.then(()=>{
const W=${LAYER_WIDTH},H=${LAYER_HEIGHT},M=120,CAPTIONS=H*0.8;const NS='http://www.w3.org/2000/svg';const ink=document.getElementById('ink');
const label=${JSON.stringify(label)},bubble=${JSON.stringify(bubble)};
const fits=(x,y,w,h,bottom)=>x>=M&&y>=M&&x+w<=W-M&&y+h<=bottom;
const overlaps=(x,y,w,h,b)=>!(x+w<b[1]||x>b[3]||y+h<b[0]||y>b[2]);
const path=(d,stroke,width)=>{const p=document.createElementNS(NS,'path');p.setAttribute('d',d);p.setAttribute('fill','none');p.setAttribute('stroke',stroke);
  p.setAttribute('stroke-width',width);p.setAttribute('stroke-linecap','round');p.setAttribute('stroke-linejoin','round');ink.appendChild(p)};
const taken=[];
if(label){const el=document.getElementById('label');const w=el.offsetWidth,h=el.offsetHeight,b=label.box,gap=200;
  const cx=(b[1]+b[3])/2,cy=(b[0]+b[2])/2;
  const spots=[[b[1]-w-gap*0.4,b[0]-h-gap],[b[3]+gap*0.4,b[0]-h-gap],[b[3]+gap,cy-h/2],[b[1]-w-gap,cy-h/2],[cx-w/2,b[0]-h-gap],[b[1]-w-gap*0.4,b[2]+gap*0.6],[b[3]+gap*0.4,b[2]+gap*0.6]];
  let pick=spots.find(([x,y])=>fits(x,y,w,h,CAPTIONS)&&!overlaps(x,y,w,h,b))||spots.map(([x,y])=>[Math.min(W-M-w,Math.max(M,x)),Math.min(CAPTIONS-h,Math.max(M,y))]).find(([x,y])=>!overlaps(x,y,w,h,b))||[M,M];
  const [x,y]=pick;el.style.left=x+'px';el.style.top=y+'px';taken.push([y,x,y+h,x+w]);
  // Arrow from the label's nearest edge to just short of the target, bowed like a hand-drawn line
  const sx=Math.min(x+w,Math.max(x,cx)),sy=y+h<b[0]?y+h+14:y>b[2]?y-14:cy;const fromX=sy===cy?(x+w<b[1]?x+w+14:x-14):sx;
  const tx=Math.min(b[3]-30,Math.max(b[1]+30,fromX)),ty=Math.min(b[2]-30,Math.max(b[0]+30,sy));
  const dx=tx-fromX,dy=ty-sy,len=Math.hypot(dx,dy)||1;const ex=tx-dx/len*40,ey=ty-dy/len*40;
  const qx=(fromX+ex)/2-dy/len*len*0.18,qy=(sy+ey)/2+dx/len*len*0.18;
  const d='M'+fromX+' '+sy+' Q'+qx+' '+qy+' '+ex+' '+ey;
  const ang=Math.atan2(ey-qy,ex-qx),a1=ang+2.6,a2=ang-2.6,hl=70;
  const head='M'+(ex+Math.cos(a1)*hl)+' '+(ey+Math.sin(a1)*hl)+' L'+ex+' '+ey+' L'+(ex+Math.cos(a2)*hl)+' '+(ey+Math.sin(a2)*hl);
  for(const [c,wd] of [["#fff",44],[${JSON.stringify(theme.accentText)},18]]){path(d,c,wd);path(head,c,wd)}}
if(bubble){const el=document.getElementById('bubble');const w=el.offsetWidth,h=el.offsetHeight,b=bubble.box;
  const headX=(b[1]+b[3])/2,headY=b[0];const tail=170;
  const spots=[[headX-w/2,headY-h-tail],[b[3]+tail*0.6,headY-h*0.6],[b[1]-w-tail*0.6,headY-h*0.6],[headX-w/2+w*0.35,headY-h-tail],[headX-w/2-w*0.35,headY-h-tail]];
  const clear=(x,y)=>!taken.some((t)=>overlaps(x,y,w,h,t));
  let pick=spots.find(([x,y])=>fits(x,y,w,h,CAPTIONS)&&clear(x,y))||spots.map(([x,y])=>[Math.min(W-M-w,Math.max(M,x)),Math.min(CAPTIONS-h,Math.max(M,y))]).find(([x,y])=>clear(x,y))||[M,M];
  const [x,y]=pick;el.style.left=x+'px';el.style.top=y+'px';
  // Tail: from inside the bubble's edge nearest the speaker to just above their head, or onto the
  // top of the head when the bubble had to sit level with it
  const tipX=headX,tipY=y+h<=headY+40?Math.max(headY-20,y+h+70):headY+(b[2]-b[0])*0.1;
  const baseX=Math.min(x+w-110,Math.max(x+110,tipX)),baseY=Math.min(y+h-50,Math.max(y+50,tipY));
  const ang=Math.atan2(tipY-baseY,tipX-baseX),nx=-Math.sin(ang)*55,ny=Math.cos(ang)*55;
  const poly=document.createElementNS(NS,'polygon');poly.setAttribute('points',(baseX+nx)+','+(baseY+ny)+' '+(baseX-nx)+','+(baseY-ny)+' '+tipX+','+tipY);
  poly.setAttribute('fill','#fff');poly.setAttribute('stroke','#1d1d1d');poly.setAttribute('stroke-width','9');poly.setAttribute('stroke-linejoin','round');ink.appendChild(poly)}
window.__laidOut=true;});
</script></body></html>`;
}

/** Renders the layer to a transparent PNG. */
export async function renderNoteLayer(spec: NoteLayerSpec, theme: MotionTheme, outputPath: string, browser?: Browser): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const own = browser ?? (await chromium.launch({ headless: true }));
  const context = await own.newContext({ viewport: { width: LAYER_WIDTH, height: LAYER_HEIGHT }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(noteLayerHtml(spec, theme), { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts?.ready;
    });
    await page.waitForFunction(() => (window as unknown as { __laidOut?: boolean }).__laidOut === true);
    await page.screenshot({ path: outputPath, type: 'png', omitBackground: true });
    return outputPath;
  } finally {
    await context.close().catch(() => {});
    if (!browser) await own.close().catch(() => {});
  }
}
