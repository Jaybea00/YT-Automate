import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ShotPlan } from '@/lib/script/generate-script';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { getFfmpegPath, getFfprobePath } from '../utils/ffmpeg';
import { motionDocument } from './motion/frame-renderer';
import { HELPERS, escapeHtml } from './motion/templates';
import type { MotionTheme } from './motion/theme';

const execFileAsync = promisify(execFile);

/**
 * Annotated photos, the Vox look: the camera pushes in on one part of a still, the rest dims, a
 * hand-drawn ring draws around it and a label slides in on a leader line. The vision model finds
 * the part (and confirms the label honestly fits it in this photo); when it can't, callers render
 * the photo plainly.
 */

export type Annotation = NonNullable<ShotPlan['annotation']>;
/** Position in the photo, 0-1000 on each axis: [ymin, xmin, ymax, xmax]. */
export type TargetBox = [number, number, number, number];

/** A box this small is a speck; this large isn't "one part" of the photo. */
const MIN_BOX_AREA = 0.003;
const MAX_BOX_AREA = 0.55;
/** Copies sent to the vision model and rendered stay at most this wide. */
const VISION_WIDTH = 1280;
const RENDER_WIDTH = 2560;

const LocateSchema = z.object({
  found: z.boolean(),
  label_fits: z.boolean(),
  box: z.array(z.number()),
  reason: z.string(),
});

export function isUsableBox(box: number[]): box is TargetBox {
  if (box.length !== 4 || !box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000)) return false;
  const [ymin, xmin, ymax, xmax] = box;
  const area = ((ymax - ymin) / 1000) * ((xmax - xmin) / 1000);
  return ymax - ymin > 5 && xmax - xmin > 5 && area >= MIN_BOX_AREA && area <= MAX_BOX_AREA;
}

/** A JPEG copy of the photo at most `width` wide (photos can be several thousand pixels). */
async function scaledJpeg(sourcePath: string, outPath: string, width: number): Promise<{ path: string; width: number; height: number }> {
  await execFileAsync(getFfmpegPath(), [
    '-y', '-v', 'error', '-i', sourcePath,
    '-frames:v', '1',
    '-vf', `scale='min(${width},iw)':-2:flags=lanczos,format=yuvj420p`,
    '-q:v', '3', outPath,
  ]);
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', outPath,
  ]).catch(() => ({ stdout: '' }));
  const [w, h] = stdout.trim().split('x').map(Number);
  return { path: outPath, width: w || width, height: h || Math.round(width * 0.66) };
}

/**
 * Asks the vision model where the annotation's target is in the photo, and whether the label can
 * truthfully name that part of this particular photo. Returns null unless both hold.
 */
export async function locateTarget(
  sourcePath: string,
  annotation: Annotation,
  llm: LLMProvider,
  ctx: ProviderCallContext,
  photoTitle?: string,
): Promise<TargetBox | null> {
  const copy = await scaledJpeg(sourcePath, `${sourcePath}.vision.jpg`, VISION_WIDTH);
  try {
    // A temporary copy beside the job's sources, never bundled with the app
    const data = (await fs.readFile(/*turbopackIgnore: true*/ copy.path)).toString('base64');
    const { data: answer } = await llm.generateJson(
      {
        prompt: `This photo${photoTitle ? ` (titled "${photoTitle.slice(0, 140)}")` : ''} will be shown with one part circled and labelled "${annotation.label}"${annotation.detail ? ` (${annotation.detail})` : ''}.
Find: ${annotation.target}.
- found: true only if it is clearly visible in the photo.
- label_fits: true only if that part of THIS photo can honestly be labelled "${annotation.label}". If the photo shows something similar but evidently not it (a different person, building or place), false.
- box: [ymin, xmin, ymax, xmax] scaled 0-1000, tight around it. If several match, the most prominent. [0,0,0,0] if not found.`,
        schema: LocateSchema,
        images: [{ mimeType: 'image/jpeg', data }],
        maxTokens: 400,
      },
      ctx,
    );
    return answer.found && answer.label_fits && isUsableBox(answer.box) ? answer.box : null;
  } finally {
    await fs.rm(copy.path, { force: true }).catch(() => {});
  }
}

/** The photo as a data URI sized for rendering. */
export async function photoForRender(sourcePath: string): Promise<{ imageUrl: string; width: number; height: number }> {
  const copy = await scaledJpeg(sourcePath, `${sourcePath}.render.jpg`, RENDER_WIDTH);
  try {
    // A temporary copy beside the job's sources, never bundled with the app
    const data = (await fs.readFile(/*turbopackIgnore: true*/ copy.path)).toString('base64');
    return { imageUrl: `data:image/jpeg;base64,${data}`, width: copy.width, height: copy.height };
  } finally {
    await fs.rm(copy.path, { force: true }).catch(() => {});
  }
}

/**
 * The annotated-photo animation. The photo settles in over a blurred copy of itself, the camera
 * pushes toward the target (placing it off-centre to leave room for the label), the rest dims, a
 * ring draws on around the target, then the label slides in along a leader line.
 */
export function annotatedPhotoTemplate(
  theme: MotionTheme,
  photo: { imageUrl: string; width: number; height: number },
  box: TargetBox,
  annotation: Annotation,
): string {
  const data = JSON.stringify({ w: photo.width, h: photo.height, box });
  return motionDocument({
    css: `body{background:${theme.background}}
#bg{position:absolute;inset:-60px;background-size:cover;background-position:center;filter:blur(38px) brightness(.42);transform:scale(1.08)}
#stage{position:absolute;left:0;top:0;transform-origin:0 0}
#photo{display:block;box-shadow:0 30px 90px rgba(0,0,0,.6)}
#ring{position:absolute;left:0;top:0;overflow:visible}
#dim{fill:rgba(0,0,0,.55);fill-rule:evenodd;opacity:0}
#ring ellipse{fill:none;stroke:${theme.accent};stroke-linecap:round}
#leader{position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:visible}
#leader line{stroke:${theme.accent};stroke-width:4;stroke-linecap:round}
#label{position:absolute;left:0;top:0;padding:16px 26px 18px;background:rgba(10,10,12,.84);border-left:6px solid ${theme.accent};opacity:0;max-width:640px}
#label .name{display:block;color:#f6f3ec;font-family:${theme.headingFont};font-size:46px;font-weight:700;line-height:1.1}
#label .detail{display:block;margin-top:8px;color:#c9c4b8;font-family:${theme.bodyFont};font-size:22px;letter-spacing:3px;text-transform:uppercase}`,
    body: `<div id="bg" style="background-image:url('${photo.imageUrl}')"></div>
<div id="stage"><img id="photo" src="${photo.imageUrl}" width="${photo.width}" height="${photo.height}">
<svg id="ring" width="${photo.width}" height="${photo.height}" viewBox="0 0 ${photo.width} ${photo.height}"><ellipse id="el"/></svg></div>
<svg id="leader"><path id="dim"/><line id="ln"/></svg>
<div id="label"><span class="name">${escapeHtml(annotation.label)}</span>${annotation.detail ? `<span class="detail">${escapeHtml(annotation.detail)}</span>` : ''}</div>`,
    script: `${HELPERS}
const D=${data};
window.__ready=()=>document.getElementById('photo').decode();
const W=1920,H=1080;
const s0=Math.min(W*0.9/D.w,H*0.9/D.h);
const bx=D.box[1]/1000*D.w,by=D.box[0]/1000*D.h,bw=(D.box[3]-D.box[1])/1000*D.w,bh=(D.box[2]-D.box[0])/1000*D.h;
const ex=bx+bw/2,ey=by+bh/2,rx=bw*0.62+D.w*0.012,ry=bh*0.62+D.h*0.012;
// Close enough to read the detail, never so close the photo turns to mush
const s1=Math.max(s0*1.12,Math.min(s0*2.6,(H*0.5)/(ry*2),(W*0.4)/(rx*2)));
// The target settles off-centre, leaving the wider side for the label
const labelRight=ex/D.w<0.58;
const fx=labelRight?W*0.38:W*0.62,fy=H*0.5;
const st=document.getElementById('stage'),ph=document.getElementById('photo'),dim=document.getElementById('dim'),el=document.getElementById('el'),ln=document.getElementById('ln'),lb=document.getElementById('label');
el.setAttribute('cx',ex);el.setAttribute('cy',ey);el.setAttribute('rx',rx);el.setAttribute('ry',ry);
el.setAttribute('transform','rotate(-4 '+ex+' '+ey+')');
// Ramanujan's perimeter; the stroke overshoots a little, like a pen stroke that doesn't quite close
const per=Math.PI*(3*(rx+ry)-Math.sqrt((3*rx+ry)*(rx+3*ry)));
const len=per*1.08;
el.setAttribute('stroke-dasharray',len+' '+len);
// Everything outside the ring darkens. Drawn in screen space each frame (the frame with the
// ellipse cut out): inside the zoomed stage, Chrome fails to paint a layer that large.
// The hole is tilted like the ring (-4deg); the frame itself stays square
const TILT=-4,ct=Math.cos(TILT*Math.PI/180),sn=Math.sin(TILT*Math.PI/180);
const dimPath=(cx,cy,a,b)=>'M0 0H'+W+'V'+H+'H0Z'+
  'M'+(cx-a*ct)+' '+(cy-a*sn)+'a'+a+' '+b+' '+TILT+' 1 0 '+(2*a*ct)+' '+(2*a*sn)+'a'+a+' '+b+' '+TILT+' 1 0 '+(-2*a*ct)+' '+(-2*a*sn)+'Z';
window.__frame=(t,d)=>{
  const pushStart=Math.min(0.5,d*0.1),pushLen=Math.min(1.8,d*0.35);
  const settle=ease(phase(t,0,0.6));
  const z=easeInOut(phase(t,pushStart,pushLen));
  const s=Math.exp(Math.log(s0)+(Math.log(s1)-Math.log(s0))*z)*(1+0.02*clamp((t-d*0.6)/(d*0.4)));
  const sx0=W/2+s0*(ex-D.w/2),sy0=H/2+s0*(ey-D.h/2);
  const px=sx0+(fx-sx0)*z,py=sy0+(fy-sy0)*z;
  const X=px-s*ex,Y=py-s*ey;
  st.style.opacity=settle;
  st.style.transform='translate('+X+'px,'+(Y+30*(1-settle))+'px) scale('+s+')';
  const ringStart=pushStart+pushLen*0.75;
  const r=ease(phase(t,ringStart,0.7));
  el.setAttribute('stroke-width',(6/s).toFixed(3));
  el.setAttribute('stroke-dashoffset',(len*(1-r)).toFixed(2));
  const cx=X+s*ex,cy=Y+s*ey;
  dim.setAttribute('d',dimPath(cx,cy,s*rx,s*ry));
  dim.style.opacity=(0.9*ease(phase(t,ringStart,0.6))).toFixed(3);
  // Label: from the ring's side edge, out toward the open side
  const la=ease(phase(t,ringStart+0.45,0.5));
  const edgeX=X+s*(ex+(labelRight?rx:-rx)),edgeY=Y+s*ey;
  const lw=lb.offsetWidth,lh=lb.offsetHeight;
  const lx=clamp(labelRight?edgeX+90:edgeX-90-lw,60,W-60-lw),ly=clamp(edgeY-lh/2,70,H-70-lh);
  const ax=labelRight?lx:lx+lw,ay=ly+lh/2;
  ln.setAttribute('x1',edgeX);ln.setAttribute('y1',edgeY);
  ln.setAttribute('x2',edgeX+(ax-edgeX)*la);ln.setAttribute('y2',edgeY+(ay-edgeY)*la);
  ln.style.opacity=la>0?1:0;
  lb.style.opacity=la;
  lb.style.transform='translate('+(lx+(labelRight?-24:24)*(1-la))+'px,'+ly+'px)';
};`,
  });
}
