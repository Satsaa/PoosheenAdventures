// Canvas views of the sprite sheets for the flat (Canvas 2D) renderer: it draws the same prop and
// character instances as the lit renderer, unlit, plus sheared silhouette shadows.
import { bakeAtlas } from './bake/index';
import { CHAR_H, CHAR_W, charAtlas } from './bake/charAtlas';
import { ctx2d, makeCanvas } from './util';

let atlasC: HTMLCanvasElement | null = null, shadowC: HTMLCanvasElement | null = null;
let charC: HTMLCanvasElement | null = null, charShadowC: HTMLCanvasElement | null = null, charVer = -1;

function toCanvas(rgba: Uint8ClampedArray, w: number, h: number, black: boolean): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const data = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue;
    if (black) { data[i] = 8; data[i + 1] = 6; data[i + 2] = 24; }
    else { data[i] = rgba[i]; data[i + 1] = rgba[i + 1]; data[i + 2] = rgba[i + 2]; }
    data[i + 3] = 255;
  }
  ctx2d(c).putImageData(new ImageData(data, w, h), 0, 0);
  return c;
}

export function atlasCanvases(): { img: HTMLCanvasElement; shadow: HTMLCanvasElement } {
  if (!atlasC) {
    const s = bakeAtlas();
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
