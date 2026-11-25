// Canvas views of the sprite sheets for the flat (Canvas 2D) renderer: it draws the same prop and
// character instances as the lit renderer, unlit, plus sheared silhouette shadows.
import { bakeAtlas, bakeStep } from './bake/index';
import { CHAR_H, CHAR_W, charAtlas } from './bake/charAtlas';
import { ctx2d, makeCanvas } from './util';

let atlasC: HTMLCanvasElement | null = null, shadowC: HTMLCanvasElement | null = null, atlasVer = -1;
let charC: HTMLCanvasElement | null = null, charShadowC: HTMLCanvasElement | null = null, charVer = -1;

/** flat path rim darkening (set from the outline graphics setting) */
export let flatOutline = 0.35;
export function setFlatOutline(k: number) { if (k !== flatOutline) { flatOutline = k; atlasC = null; charC = null; } }

function toCanvas(rgba: Uint8ClampedArray, w: number, h: number, black: boolean): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const data = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue;
    if (black) { data[i] = 8; data[i + 1] = 6; data[i + 2] = 24; }
    else {
      const p = i >> 2, x = p % w, y = (p / w) | 0;
      const edge = flatOutline > 0 && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !rgba[i - 1] || !rgba[i + 7] || !rgba[i - w * 4 + 3] || !rgba[i + w * 4 + 3]);
      const k = edge ? 1 - flatOutline : 1;
      data[i] = rgba[i] * k; data[i + 1] = rgba[i + 1] * k; data[i + 2] = rgba[i + 2] * k;
    }
    data[i + 3] = 255;
  }
  ctx2d(c).putImageData(new ImageData(data, w, h), 0, 0);
  return c;
}

export function atlasCanvases(): { img: HTMLCanvasElement; shadow: HTMLCanvasElement } {
  const s0 = bakeAtlas();
  bakeStep(4);
  if (!atlasC || atlasVer !== (s0.version || 0)) {
    atlasVer = s0.version || 0;
    const s = s0;
    atlasC = toCanvas(s.albedo, s.w, s.h, false);
    shadowC = toCanvas(s.albedo, s.w, s.h, true);
  }
  return { img: atlasC, shadow: shadowC! };
}

export function charCanvases(): { img: HTMLCanvasElement; shadow: HTMLCanvasElement } {
  const ca = charAtlas();
  if (!charC || charVer !== ca.version) {
    charC = toCanvas(ca.albedo, CHAR_W, CHAR_H, false);
    charShadowC = toCanvas(ca.albedo, CHAR_W, CHAR_H, true);
    charVer = ca.version;
  }
  return { img: charC, shadow: charShadowC! };
}

const tinted = new Map<string, HTMLCanvasElement>();
let tintedVer = -1;
/** the atlas with MAT.TINT pixels (building roofs, NPC clothes) multiplied by a colour */
export function atlasTinted(r: number, g: number, b: number): HTMLCanvasElement {
  const s = bakeAtlas();
  if (tintedVer !== (s.version || 0)) { tinted.clear(); tintedVer = s.version || 0; }
  const key = `${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)}`;
  let c = tinted.get(key);
  if (c) return c;
  const src = new Uint8ClampedArray(s.albedo);
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] && s.emissive[i + 3] === 6) { src[i] *= r; src[i + 1] *= g; src[i + 2] *= b; }
  }
  c = toCanvas(src, s.w, s.h, false);
  tinted.set(key, c);
  return c;
}
