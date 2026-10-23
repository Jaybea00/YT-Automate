/**
 * Rendered transitions as ffmpeg xfade "custom" expressions: per-pixel formulas that can sample
 * either clip anywhere, so they do what the built-in set can't (ink spreading, a paper tear, a
 * film burn, a light leak, an RGB-split glitch, a motion-blurred whip pan, a zoom punch, a flash
 * with a shake). Slow (every pixel of every frame is computed), worth it at the big moments.
 *
 * In these expressions P runs from 1 to 0, so q = 1 - P is the progress. X/W and Y/H are
 * positions within the current plane, which keeps masks aligned between brightness and colour.
 * Values are written out in full rather than kept with st()/ld(): xfade evaluates the expression
 * on several threads at once, and those shared registers garble the picture.
 */

/** Samples the current plane of clip `clip` ('a' outgoing, 'b' incoming) at (x, y) in plane pixels. */
const sample = (clip: 'a' | 'b', x: string, y: string) =>
  `if(eq(PLANE,0),${clip}0(${x},${y}),if(eq(PLANE,1),${clip}1(${x},${y}),${clip}2(${x},${y})))`;
/** A plane value: brightness for plane 0, the two colour components otherwise. */
const perPlane = (y: string, u: string, v: string) => `if(eq(PLANE,0),${y},if(eq(PLANE,1),${u},${v}))`;
const cx = (e: string) => `clip(${e},0,W-1)`;
const cy = (e: string) => `clip(${e},0,H-1)`;
const q = '(1-P)';
const bell = `sin(PI*${q})`;
const mix = (a: string, b: string, m: string) => `(${a})*(1-(${m}))+(${b})*(${m})`;

function ink(): string {
  const field = '(0.5+0.25*sin(X/W*19+cos(Y/H*11)*2)+0.25*sin(Y/H*15+sin(X/W*9)*2))';
  const front = `(${q}*1.35-${field}-0.05)`;
  const m = `clip(${front}/0.06,0,1)`;
  const rim = `clip(1-abs(${front}-0.03)/0.03,0,1)`;
  return `${mix('A', 'B', m)}-${perPlane('70', '0', '0')}*${rim}`;
}

function papertear(): string {
  const u = '(X/W)';
  const edge = `(${q}*1.25-0.1+0.025*sin(Y/H*90)+0.015*sin(Y/H*233+1.3)+0.01*sin(Y/H*517))`;
  return `if(lt(${u},${edge}),B,if(lt(${u},${edge}+0.012),${perPlane('232', '128', '128')},if(lt(${u},${edge}+0.04),${perPlane('A*0.72', '128+(A-128)*0.72', '128+(A-128)*0.72')},A)))`;
}

function filmburn(): string {
  const base = mix('A', 'B', `clip((${q}-0.35)/0.3,0,1)`);
  const burn = `clip(${bell}*1.4-hypot((X/W-0.72)*1.6,Y/H-0.3)*1.5+0.12*sin(X/W*31+Y/H*17+${q}*20),0,1)`;
  return perPlane(`(${base})+${burn}*(255-(${base}))*0.95`, `(${base})*(1-0.75*${burn})+52*${burn}`, `(${base})*(1-0.75*${burn})+150*${burn}`);
}

function lightleak(): string {
  const base = mix('A', 'B', q);
  const glow = `exp(-pow((X/W+Y/H*0.6)/1.6-(${q}*1.4-0.2),2)*18)*${bell}`;
  return perPlane(`(${base})+${glow}*(255-(${base}))*0.8`, `(${base})*(1-0.6*${glow})+54*${glow}`, `(${base})*(1-0.6*${glow})+108*${glow}`);
}

function glitch(): string {
  const h = `abs(mod(sin(floor(Y/H*18)*12.9898+floor(${q}*10)*78.233)*43758.5453,1))`;
  const shift = `((${h}-0.5)*0.25*${bell}*gt(${h},0.45)+${perPlane('0', `0.02*${bell}`, `-0.02*${bell}`)})`;
  const x = cx(`X+${shift}*W`);
  return `if(lt(${q},0.5),${sample('a', x, 'Y')},${sample('b', x, 'Y')})`;
}

function whip(): string {
  const travel = `(${q}*${q}*(3-2*${q}))`;
  const blur = `(0.06*${bell})`;
  const tap = (k: number) => {
    const x = `(X/W+${travel}+${k}*${blur})`;
    return `if(lt(${x},1),${sample('a', cx(`${x}*W`), 'Y')},${sample('b', cx(`(${x}-1)*W`), 'Y')})`;
  };
  return `(${tap(-1)}+${tap(0)}+${tap(1)})/3`;
}

function zoompunch(): string {
  const zoomA = `(1+0.8*${q}*${q})`;
  const zoomB = `(1.5-0.5*${q})`;
  const at = (zoom: string) => [cx(`(0.5+(X/W-0.5)/${zoom})*W`), cy(`(0.5+(Y/H-0.5)/${zoom})*H`)] as const;
  return mix(sample('a', ...at(zoomA)), sample('b', ...at(zoomB)), `clip((${q}-0.4)/0.2,0,1)`);
}

function flashshake(): string {
  const jolt = `(0.03*sin(${q}*45)*${bell})`;
  const x = cx(`X+${jolt}*W`);
  const y = cy(`Y+${jolt}*0.6*H`);
  const picture = `if(lt(${q},0.5),${sample('a', x, y)},${sample('b', x, y)})`;
  const flash = `exp(-pow((${q}-0.5)*7,2))`;
  return perPlane(`${picture}+${flash}*(255-${picture})`, `128+(${picture}-128)*(1-${flash})`, `128+(${picture}-128)*(1-${flash})`);
}

export const CUSTOM_TRANSITIONS: Record<string, string> = {
  /** Ink spreading across the frame in organic blobs, with a dark wet edge. */
  ink: ink(),
  /** A ragged paper tear sweeping across, with a white torn edge and a shadow on the old page. */
  papertear: papertear(),
  /** The old shot burns out in a hot orange bloom that flickers, revealing the new one. */
  filmburn: filmburn(),
  /** A warm band of light sweeping diagonally across as the shots dissolve. */
  lightleak: lightleak(),
  /** Horizontal slices jump sideways and the colour channels split, switching shots mid-glitch. */
  glitch: glitch(),
  /** A fast pan: the old shot slides off, the new one slides in, smeared with motion blur. */
  whip: whip(),
  /** The old shot punches in towards the centre while the new one settles back from a zoom. */
  zoompunch: zoompunch(),
  /** A white flash on the cut with the picture jolting, for impact moments. */
  flashshake: flashshake(),
};

export const CUSTOM_TRANSITION_NAMES = Object.keys(CUSTOM_TRANSITIONS);
export const isCustomTransition = (type: string) => type in CUSTOM_TRANSITIONS;

/** The xfade options for a transition: a built-in name, or a custom expression. */
export function xfadeTransitionOption(type: string): string {
  return isCustomTransition(type) ? `transition=custom:expr='${CUSTOM_TRANSITIONS[type]}'` : `transition=${type}`;
}
