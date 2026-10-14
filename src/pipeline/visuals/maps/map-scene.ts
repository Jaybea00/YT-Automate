import {
  geoBounds,
  geoCentroid,
  geoContains,
  geoGraticule10,
  geoMercator,
  geoNaturalEarth1,
  geoPath,
  type GeoProjection,
} from 'd3-geo';
import type { Feature, MultiPoint } from 'geojson';
import { FRAME_HEIGHT as H, FRAME_WIDTH as W, motionDocument } from '../motion/frame-renderer';
import { HELPERS, escapeHtml } from '../motion/templates';
import type { MotionTheme } from '../motion/theme';
import { loadCountries, mainland, type CountryFeature, type ResolvedPlace } from './places';

export type MapMode = 'route' | 'spread' | 'locate';

/** Spans wider than this use a world projection; Mercator stretches too much beyond it. */
const WIDE_LNG_SPAN = 70;
const WIDE_LAT_SPAN = 50;
/** Narrower than this, 1:50m coastlines look blocky, so 1:10m is used. */
const CLOSE_UP_LNG_SPAN = 25;
const PAD_X = 230;
const PAD_Y = 170;

type Pt = [number, number];

/** Points that must be in frame for a place: its outline/box, or a small circle around a city. */
function framingPoints(place: ResolvedPlace, cityRadiusDeg: number): Pt[] {
  if (place.kind === 'country' && place.countryId) {
    const country = loadCountries().find((c) => c.id === place.countryId);
    if (country) return mainland(country).geometry.coordinates[0] as Pt[];
  }
  if (place.bbox) {
    const [w, s, e, n] = place.bbox;
    const midLng = w <= e ? (w + e) / 2 : (w + e + 360) / 2;
    return [[w, s], [w, n], [e, s], [e, n], [midLng, s], [midLng, n], [place.lng, place.lat]];
  }
  const r = cityRadiusDeg;
  const k = Math.cos((place.lat * Math.PI) / 180) || 1;
  return [[place.lng - r / k, place.lat], [place.lng + r / k, place.lat], [place.lng, place.lat - r * 0.6], [place.lng, place.lat + r * 0.6]];
}

/**
 * Chooses and fits the projection: rotated to the places' longitude (so nothing is cut at the
 * date line), Mercator for regional views and Natural Earth for continental or world views.
 */
export function fitProjection(
  places: ResolvedPlace[],
  mode: MapMode,
): { projection: GeoProjection; wide: boolean; closeUp: boolean } {
  // A lone city is shown with its surrounding region for context
  const cityRadius = mode === 'locate' && places.length === 1 ? 4.5 : 0.8;
  const target: Feature<MultiPoint> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPoint', coordinates: places.flatMap((p) => framingPoints(p, cityRadius)) },
  };
  const [[w, s], [e, n]] = geoBounds(target);
  const lngSpan = e >= w ? e - w : e + 360 - w;
  const wide = lngSpan > WIDE_LNG_SPAN || n - s > WIDE_LAT_SPAN;
  const [centerLng] = geoCentroid(target);
  const projection = (wide ? geoNaturalEarth1() : geoMercator()).rotate([-centerLng, 0]);
  projection.fitExtent([[PAD_X, PAD_Y], [W - PAD_X, H - PAD_Y]], target);
  return { projection, wide, closeUp: lngSpan < CLOSE_UP_LNG_SPAN && n - s < CLOSE_UP_LNG_SPAN };
}

/** How far the camera starts zoomed out: wider for a single place, never beyond the whole world. */
function startZoomOut(projection: GeoProjection, wide: boolean, mode: MapMode): number {
  const wanted = mode === 'locate' ? 2.6 : 1.8;
  const worldWidth = projection.scale() * (wide ? 5.44 : 2 * Math.PI);
  return Math.max(1, Math.min(wanted, worldWidth / W));
}

/** A gently curved arc between two screen points, bowing upward like a flight path. */
function arcPath(a: Pt, b: Pt): string {
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular, pointing up the screen
  let [px, py] = [-dy / len, dx / len];
  if (py > 0) [px, py] = [-px, -py];
  const bow = Math.min(220, len * 0.2);
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M${r(a[0])} ${r(a[1])} Q${r(mx + px * bow)} ${r(my + py * bow)} ${r(b[0])} ${r(b[1])}`;
}

const boundsCache = new WeakMap<CountryFeature, [[number, number], [number, number]]>();

/**
 * For close-ups (Mercator, never wide): whether a country's bounding box overlaps the area the
 * camera can see, so the thousands of 1:10m points of countries out of view are never projected.
 */
function viewFilter(projection: GeoProjection, marginX: number, marginY: number): (c: CountryFeature) => boolean {
  const corners: Pt[] = [
    [W / 2 - marginX, H / 2 - marginY],
    [W / 2 + marginX, H / 2 - marginY],
    [W / 2 - marginX, H / 2 + marginY],
    [W / 2 + marginX, H / 2 + marginY],
  ];
  const geo = corners.map((p) => projection.invert!(p)!).filter(Boolean);
  const lngs = geo.map((g) => g[0]);
  const lats = geo.map((g) => g[1]);
  // Measure longitudes relative to the view's centre so the date line never splits the range
  const [centerLng] = projection.invert!([W / 2, H / 2])!;
  const rel = (lng: number) => ((((lng - centerLng) % 360) + 540) % 360) - 180;
  const halfSpan = Math.max(...lngs.map((l) => Math.abs(rel(l))));
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  return (c) => {
    let b = boundsCache.get(c);
    if (!b) boundsCache.set(c, (b = geoBounds(c)));
    const [[w, s], [e, n]] = b;
    if (n < south || s > north) return false;
    // A box crossing the date line (w > e), or wider than the view, is kept to be safe
    if (w > e || e - w > 180) return true;
    const [rw, re] = [rel(w), rel(e)];
    return rw > re || (re >= -halfSpan && rw <= halfSpan);
  };
}

/** True for light colors (#rrggbb), whose maps need a gentler vignette. */
function isLight(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

export interface MapSceneSpec {
  places: ResolvedPlace[];
  mode: MapMode;
  theme: MotionTheme;
}

export interface MapScene {
  /** The static map (land, borders, graticule) as SVG, sized baseWidth x baseHeight. */
  baseSvg: string;
  baseWidth: number;
  baseHeight: number;
  background: string;
  /** The animated page, given the base map rasterised to an image URL. */
  page: (baseImageUrl: string) => string;
}

/** Builds the map scene: every frame drawn by `window.__frame(t, d)`, no network access. */
export function buildMapScene({ places, mode: requestedMode, theme }: MapSceneSpec): MapScene {
  if (places.length === 0) throw new Error('No places to map');
  const mode: MapMode = places.length === 1 ? 'locate' : requestedMode;
  const { projection, wide, closeUp } = fitProjection(places, mode);
  const k = startZoomOut(projection, wide, mode);
  // Draw everything the zoomed-out camera can see, and nothing more
  const marginX = (W * k) / 2 + 40;
  const marginY = (H * k) / 2 + 40;
  projection.clipExtent([[W / 2 - marginX, H / 2 - marginY], [W / 2 + marginX, H / 2 + marginY]]);
  const path = geoPath(projection).digits(1);

  const countries = loadCountries(closeUp ? '10m' : '50m');
  /** A country too small on screen to hold its name gets a pin and a side label instead. */
  const isSmallOnScreen = (p: ResolvedPlace) => {
    const country = p.countryId ? countries.find((c) => c.id === p.countryId) : null;
    if (!country) return false;
    const [[x0, y0], [x1, y1]] = path.bounds(mainland(country));
    return x1 - x0 < 260 || y1 - y0 < 110;
  };
  const inView = closeUp ? viewFilter(projection, marginX, marginY) : () => true;
  const countryPaths = countries
    .filter(inView)
    .map((c) => ({ id: String(c.id), d: path(c) ?? '' }))
    .filter((c) => c.d.length > 0);

  // Countries to highlight: named countries, and the country around each named city
  const highlight: Array<{ id: string; order: number; strong: boolean }> = [];
  places.forEach((p, order) => {
    if (p.countryId) highlight.push({ id: p.countryId, order, strong: true });
    else if (p.kind === 'city') {
      const home = countries.find((c) => geoContains(c, [p.lng, p.lat]));
      if (home && !highlight.some((h) => h.id === home.id)) highlight.push({ id: String(home.id), order, strong: false });
    }
  });

  const points = places.map((p) => {
    const xy = (projection([p.lng, p.lat]) ?? [W / 2, H / 2]) as Pt;
    return { label: p.label, kind: p.kind, x: Math.round(xy[0]), y: Math.round(xy[1]), pinned: p.kind === 'city' || isSmallOnScreen(p) };
  });
  const arcs =
    mode === 'route'
      ? points.slice(1).map((p, i) => ({ from: i, to: i + 1, d: arcPath([points[i].x, points[i].y], [p.x, p.y]) }))
      : mode === 'spread'
        ? points.slice(1).map((p, i) => ({ from: 0, to: i + 1, d: arcPath([points[0].x, points[0].y], [p.x, p.y]) }))
        : [];

  const m = theme.map;
  const data = JSON.stringify({ mode, k, points, arcs, highlight });

  // The static map (land, borders, graticule) covers everything the zoomed-out camera sees, at
  // 1:1 pixels for the final framing. It is rasterised once to an image; each frame only scales
  // that bitmap, which is far cheaper than re-drawing thousands of border paths.
  const baseW = Math.ceil(W * k);
  const baseH = Math.ceil(H * k);
  const offX = (baseW - W) / 2;
  const offY = (baseH - H) / 2;
  const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${baseW}" height="${baseH}" viewBox="${-offX} ${-offY} ${baseW} ${baseH}">
<style>.land{fill:${m.land};stroke:${m.border};stroke-width:1.2}.grat{fill:none;stroke:${m.border};stroke-width:0.8;opacity:.35}.sphere{fill:${m.water}}</style>
${wide ? `<path class="sphere" d="${path({ type: 'Sphere' }) ?? ''}"/>` : ''}
<path class="grat" d="${path(geoGraticule10()) ?? ''}"/>
${countryPaths.map((c) => `<path class="land" d="${c.d}"/>`).join('')}
</svg>`;

  const css = `body{background:${m.water}}
#base{position:absolute;left:${-offX}px;top:${-offY}px;width:${baseW}px;height:${baseH}px;transform-origin:50% 50%}
svg{position:absolute;left:0;top:0;overflow:visible}
.hl{fill:${m.highlight};stroke:none}
.arc{fill:none;stroke:${m.highlight};stroke-width:6;stroke-linecap:round;vector-effect:non-scaling-stroke}
.vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,${isLight(m.water) ? 0.08 : 0.28}) 100%);pointer-events:none}
.pin{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:${m.highlight};border:5px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,.4);opacity:0}
.ring{position:absolute;border-radius:50%;border:4px solid ${m.highlight};opacity:0}
.head{position:absolute;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:#fff;box-shadow:0 0 18px ${m.highlight};opacity:0}
.label{position:absolute;white-space:nowrap;font-family:${theme.headingFont};font-size:44px;font-weight:700;color:${theme.text};opacity:0;
text-shadow:0 0 6px ${m.water},0 0 12px ${m.water},0 0 20px ${m.water}}
.label.area{font-size:40px;letter-spacing:6px;text-transform:uppercase}`;

  const svg = (baseImageUrl: string) => `<img id="base" src="${baseImageUrl}"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g id="cam">
${highlight.map((h, i) => `<path class="hl" id="hl${i}" d="${countryPaths.find((c) => c.id === h.id)?.d ?? ''}" opacity="0"/>`).join('')}
${arcs.map((a, i) => `<path class="arc" id="arc${i}" d="${a.d}"/>`).join('')}
</g></svg>`;
  const overlay = `<div class="vignette"></div>${points
    .map(
      (p, i) =>
        `<div class="ring" id="ring${i}"></div><div class="pin" id="pin${i}"></div><div class="label${p.pinned ? '' : ' area'}" id="lab${i}">${escapeHtml(p.label)}</div>`,
    )
    .join('')}<div class="head" id="head"></div>`;

  const script = `${HELPERS}
const D=${data};
window.__ready=()=>document.getElementById('base').decode();
const cam=document.getElementById('cam'),base=document.getElementById('base');
const arcs=D.arcs.map((a,i)=>{const el=document.getElementById('arc'+i);const len=el.getTotalLength();el.style.strokeDasharray=len;el.style.strokeDashoffset=len;return {...a,el,len}});
const labels=D.points.map((p,i)=>document.getElementById('lab'+i));

// Final label boxes (camera at rest): right of a pin, or left when that runs off the frame;
// centred on an area. Overlapping labels are pushed down, in order, until they are clear.
const boxes=D.points.map((p,i)=>{const r=labels[i].getBoundingClientRect();
  if(!p.pinned)return {dx:-r.width/2,dy:-r.height/2,w:r.width,h:r.height};
  const right=p.x+30+r.width<${W - 40};return {dx:right?30:-30-r.width,dy:-r.height/2,w:r.width,h:r.height}});
const placed=[];
boxes.forEach((b,i)=>{const p=D.points[i];let y=p.y+b.dy;
  for(let guard=0;guard<20;guard++){const x=p.x+b.dx;const hit=placed.find(q=>x<q.x+q.w+12&&x+b.w+12>q.x&&y<q.y+q.h&&y+b.h>q.y);if(!hit)break;y=hit.y+hit.h+4}
  b.dy=y-p.y;placed.push({x:p.x+b.dx,y,w:b.w,h:b.h})});

const screen=(x,y,s)=>[${W / 2}+(x-${W / 2})*s,${H / 2}+(y-${H / 2})*s];
const frac=(x)=>x-Math.floor(x);

window.__frame=(t,d)=>{
  const camEnd=Math.min(2.4,d*0.55);
  const s=(1/D.k)+(1-1/D.k)*easeInOut(phase(t,0,camEnd))+0.03*clamp((t-camEnd)/Math.max(0.1,d-camEnd));
  base.style.transform='scale('+s+')';
  cam.setAttribute('transform','translate(${W / 2} ${H / 2}) scale('+s+') translate(${-W / 2} ${-H / 2})');

  // When each place appears
  const n=D.points.length;const appear=new Array(n).fill(0);
  const head=document.getElementById('head');let drawing=false;
  if(D.mode==='locate'){appear.fill(camEnd*0.6)}
  else{
    appear[0]=0.3;
    const span=Math.max(0.6,d*0.82-camEnd*0.5);
    arcs.forEach((a,i)=>{const start=camEnd*0.5+span*i/arcs.length;const len=span/arcs.length;
      const p=easeInOut(phase(t,start,len*0.8));a.el.style.strokeDashoffset=a.len*(1-p);appear[a.to]=start+len*0.8;
      // A bright head leads the line while it draws (routes only)
      if(D.mode==='route'&&p>0&&p<1){const pt=a.el.getPointAtLength(a.len*p);const [hx,hy]=screen(pt.x,pt.y,s);
        head.style.left=hx+'px';head.style.top=hy+'px';drawing=true}});
  }
  head.style.opacity=drawing?1:0;

  D.highlight.forEach((h,i)=>{const at=D.mode==='locate'?camEnd*0.45:appear[h.order];
    document.getElementById('hl'+i).setAttribute('opacity',(h.strong?0.85:0.18)*ease(phase(t,at,0.6)))});

  D.points.forEach((p,i)=>{const [x,y]=screen(p.x,p.y,s);const a=ease(phase(t,appear[i],0.35));
    const pin=document.getElementById('pin'+i),ring=document.getElementById('ring'+i),lab=labels[i],b=boxes[i];
    if(p.pinned){pin.style.left=x+'px';pin.style.top=y+'px';pin.style.opacity=a;pin.style.transform='scale('+(0.4+0.6*a)+')';
      const age=t-appear[i];if(age>0){const f=frac(age/1.6),r=13+60*f;ring.style.left=(x-r)+'px';ring.style.top=(y-r)+'px';ring.style.width=ring.style.height=(2*r)+'px';ring.style.opacity=0.9*(1-f)}}
    const la=ease(phase(t,appear[i]+0.15,0.4));lab.style.left=(x+b.dx)+'px';lab.style.top=(y+b.dy+14*(1-la))+'px';lab.style.opacity=la});
};`;

  return {
    baseSvg,
    baseWidth: baseW,
    baseHeight: baseH,
    background: m.water,
    page: (baseImageUrl) => motionDocument({ css, body: svg(baseImageUrl) + overlay, script }),
  };
}
