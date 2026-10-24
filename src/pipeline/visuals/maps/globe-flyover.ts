import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { feature, mesh } from 'topojson-client';
import type { Browser } from 'playwright';
import { renderMotionClip, FRAME_HEIGHT, FRAME_WIDTH } from '../motion/frame-renderer';
import { escapeHtml } from '../motion/templates';
import type { MotionTheme } from '../motion/theme';
import type { ResolvedPlace } from './places';

// Resolved from the project (as places.ts does), so it works the same in the worker and the app
const req = () => createRequire(path.join(/* turbopackIgnore: true */ process.cwd(), 'package.json'));

/**
 * Globe flyovers: the Earth as a globe turning to the place and the camera diving in, then
 * landing on real satellite imagery of it (Sentinel-2 cloudless by EOX, CC BY 4.0), with its
 * name pinned. Without the imagery (offline) it ends on the globe, close in.
 */

export const SATELLITE_CREDIT =
  'Sentinel-2 cloudless (https://s2maps.eu) by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0';
const TILE_URL = (z: number, x: number, y: number) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`;
const TILE = 256;
/** The imagery covers a little more than the frame, so the final push has room. */
const COVER_W = 2300;
const COVER_H = 1300;

const tileCache = () => process.env.TILE_CACHE_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'data-cache', 's2cloudless');

/** Web Mercator pixel position of a point at a zoom level. */
export function mercatorPx(lng: number, lat: number, z: number): { x: number; y: number } {
  const world = TILE * 2 ** z;
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * world, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world };
}

/** How close to land for a place: towns close in, countries wide enough to see their shape. */
export function landingZoom(place: ResolvedPlace): number {
  if (place.kind === 'city') return 11;
  if (place.kind === 'continent') return 4;
  const [w, s, e, n] = place.bbox ?? [place.lng - 5, place.lat - 3, place.lng + 5, place.lat + 3];
  const span = Math.max((e >= w ? e - w : e + 360 - w) / 360, (n - s) / 170);
  const z = Math.floor(Math.log2(1500 / (TILE * Math.max(span, 1e-4))));
  return Math.max(3, Math.min(place.kind === 'country' ? 8 : 10, z));
}

/** The tiles covering the landing view, each with its offset from the place (pixels). */
export function landingTiles(place: ResolvedPlace, z: number): Array<{ x: number; y: number; dx: number; dy: number }> {
  const c = mercatorPx(place.lng, place.lat, z);
  const max = 2 ** z;
  const x0 = Math.floor((c.x - COVER_W / 2) / TILE);
  const x1 = Math.floor((c.x + COVER_W / 2) / TILE);
  const y0 = Math.max(0, Math.floor((c.y - COVER_H / 2) / TILE));
  const y1 = Math.min(max - 1, Math.floor((c.y + COVER_H / 2) / TILE));
  const tiles: Array<{ x: number; y: number; dx: number; dy: number }> = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      tiles.push({ x: ((tx % max) + max) % max, y: ty, dx: tx * TILE - c.x, dy: ty * TILE - c.y });
    }
  }
  return tiles;
}

async function fetchTile(z: number, x: number, y: number, fetcher: typeof fetch): Promise<Buffer> {
  const file = path.join(tileCache(), String(z), String(x), `${y}.jpg`);
  try {
    return await fs.readFile(file);
  } catch {
    // not cached
  }
  const res = await fetcher(TILE_URL(z, x, y), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`satellite tile ${z}/${x}/${y}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return bytes;
}

/** The landing imagery as positioned tiles (data URIs), or null when it can't be had. */
export async function landingImagery(place: ResolvedPlace, fetcher: typeof fetch = fetch): Promise<{ zoom: number; tiles: Array<{ dx: number; dy: number; src: string }> } | null> {
  const zoom = landingZoom(place);
  const want = landingTiles(place, zoom);
  try {
    const tiles: Array<{ dx: number; dy: number; src: string }> = [];
    for (let i = 0; i < want.length; i += 6) {
      const batch = await Promise.all(want.slice(i, i + 6).map((t) => fetchTile(zoom, t.x, t.y, fetcher)));
      batch.forEach((bytes, j) => tiles.push({ dx: want[i + j].dx, dy: want[i + j].dy, src: `data:image/jpeg;base64,${bytes.toString('base64')}` }));
    }
    return { zoom, tiles };
  } catch (err) {
    console.warn(`[Globe] Satellite imagery unavailable (${err instanceof Error ? err.message.slice(0, 120) : err}); ending on the globe`);
    return null;
  }
}

let worldData: { land: unknown; borders: unknown } | null = null;
async function world(): Promise<{ land: unknown; borders: unknown }> {
  if (worldData) return worldData;
  const read = async (name: string) => JSON.parse(await fs.readFile(req().resolve(`world-atlas/${name}`), 'utf-8'));
  const land = await read('land-50m.json');
  const countries = await read('countries-110m.json');
  worldData = {
    land: feature(land, land.objects.land),
    borders: mesh(countries, countries.objects.countries, (a: unknown, b: unknown) => a !== b),
  };
  return worldData;
}

/** The flyover page: d3-geo draws the globe on a canvas each frame; the imagery lands at the end. */
export async function globeDocument(theme: MotionTheme, place: ResolvedPlace, imagery: Awaited<ReturnType<typeof landingImagery>>): Promise<string> {
  // The browser builds (not reachable through the packages' exports)
  const dist = (pkg: string) => path.join(/* turbopackIgnore: true */ process.cwd(), 'node_modules', pkg, 'dist', `${pkg}.min.js`);
  const d3 = [await fs.readFile(dist('d3-array'), 'utf-8'), await fs.readFile(dist('d3-geo'), 'utf-8')];
  const data = await world();
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px;overflow:hidden;background:#05070d}
canvas{position:absolute;inset:0}
.pin{position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:${theme.accent};box-shadow:0 0 0 8px rgba(255,255,255,.35),0 6px 18px rgba(0,0,0,.6);opacity:0}
.name{position:absolute;left:50%;top:50%;transform:translate(36px,-50%);font:800 54px ${theme.headingFont};color:#fbf8f1;background:rgba(10,10,12,.78);border-left:10px solid ${theme.accent};padding:12px 28px;border-radius:6px;white-space:nowrap;opacity:0}
</style><script>${d3.join('\n')}</script></head><body><canvas id="c" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}"></canvas><canvas id="s" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" style="opacity:0"></canvas><div class="pin" id="pin"></div><div class="name" id="name">${escapeHtml(place.label)}</div>
<script>(()=>{
const LAND=${json(data.land)},BORDERS=${json(data.borders)},P=${json({ lng: place.lng, lat: place.lat })},IMG=${json(imagery?.tiles ?? [])},M=${json(theme.map)},A=${json(theme.accent)};
const W=${FRAME_WIDTH},H=${FRAME_HEIGHT},c=document.getElementById('c'),g=c.getContext('2d'),s=document.getElementById('s'),sg=s.getContext('2d');
const clamp=(x)=>Math.max(0,Math.min(1,x)),ease=(x)=>{x=clamp(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2},phase=(t,a,b)=>clamp((t-a)/b);
const proj=d3.geoOrthographic().translate([W/2,H/2]).clipAngle(90).precision(0.4),path=d3.geoPath(proj,g),grat=d3.geoGraticule10();
const imgs=IMG.map(t=>{const i=new Image();i.src=t.src;return {i,dx:t.dx,dy:t.dy}});
window.__ready=()=>Promise.all(imgs.map(t=>t.i.decode().catch(()=>{})));
const start=[-(P.lng+75),-(P.lat*0.3)],end=[-P.lng,-P.lat];
window.__frame=(t,d)=>{
  const hasImg=imgs.length>0,dive=ease(phase(t,0,d*(hasImg?0.62:0.85)));
  // Turn the shortest way round to the place
  let dl=end[0]-start[0];dl=((dl+540)%360)-180;
  proj.rotate([start[0]+dl*dive,start[1]+(end[1]-start[1])*dive,0]).scale(430*Math.pow(hasImg?9:14,dive));
  g.fillStyle='#05070d';g.fillRect(0,0,W,H);
  const r=proj.scale();const glow=g.createRadialGradient(W/2,H/2,r*0.9,W/2,H/2,r*1.18);glow.addColorStop(0,'rgba(120,170,255,.35)');glow.addColorStop(1,'rgba(120,170,255,0)');
  g.fillStyle=glow;g.beginPath();g.arc(W/2,H/2,r*1.18,0,Math.PI*2);g.fill();
  g.beginPath();path({type:'Sphere'});g.fillStyle=M.water;g.fill();
  g.beginPath();path(grat);g.strokeStyle='rgba(255,255,255,.07)';g.lineWidth=1;g.stroke();
  g.beginPath();path(LAND);g.fillStyle=M.land;g.fill();
  g.beginPath();path(BORDERS);g.strokeStyle=M.border;g.lineWidth=1;g.stroke();
  const shade=g.createRadialGradient(W/2-r*0.35,H/2-r*0.35,r*0.1,W/2,H/2,r);shade.addColorStop(0,'rgba(255,255,255,.08)');shade.addColorStop(1,'rgba(0,0,0,.35)');
  g.beginPath();path({type:'Sphere'});g.fillStyle=shade;g.fill();
  // Landing: the satellite view fades in and the camera keeps settling
  const land=hasImg?ease(phase(t,d*0.55,d*0.18)):0;
  if(hasImg){const k=0.82+0.24*ease(phase(t,d*0.55,d*0.45));sg.fillStyle='#000';sg.fillRect(0,0,W,H);
    sg.save();sg.translate(W/2,H/2);sg.scale(k,k);for(const t2 of imgs)sg.drawImage(t2.i,t2.dx,t2.dy,256,256);sg.restore();
    s.style.opacity=land;}
  const pinAt=hasImg?d*0.7:d*0.8;
  document.getElementById('pin').style.opacity=ease(phase(t,pinAt,0.35));
  const nm=document.getElementById('name');const nl=ease(phase(t,pinAt+0.2,0.45));nm.style.opacity=nl;nm.style.transform='translate('+(36+20*(1-nl))+'px,-50%)';
};
})();</script></body></html>`;
}

export async function renderGlobeFlyover(options: { place: ResolvedPlace; theme: MotionTheme; durationSec: number; outputPath: string; browser?: Browser; fetcher?: typeof fetch }): Promise<{ satellite: boolean }> {
  const imagery = await landingImagery(options.place, options.fetcher);
  const html = await globeDocument(options.theme, options.place, imagery);
  await renderMotionClip({ html, durationSec: options.durationSec, outputPath: options.outputPath, browser: options.browser });
  return { satellite: Boolean(imagery) };
}
