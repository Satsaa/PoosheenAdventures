// GLSL for the lit pipeline. Convention: every offscreen buffer is "y-down": gl_FragCoord.y == pixel row.
// Only the final composite flips to the canvas.

export const MAX_LIGHTS = 32;

const HDR = `#version 300 es
precision highp float;
precision highp int;
`;

export const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- the shape of raised ground
// Walls and cliffs are not boxes: toward lower ground they slope, with a run that depends on the
// side. Under this renderer's projection (a point at height z is drawn z further up the screen) a
// slope that rises away from the viewer shows a long face, one that rises toward the viewer a short
// one, and with the right runs every side of a room shows its wall. The same function shapes the
// drawn terrain and the height map that shadows are cast over, so light and picture agree.
//   uLift: R = lift of the tile in px, G = kind (0 ground, 1 void, 2 liquid; +4 lip; +8 has slopes; +16 walkable; +32 corner cut at 45 degrees),
//          B, A = how much the tile's faces are scaled sideways / up-down so a top is always left
//   uWallP / uWallL: the pattern and its "lip" variant: (south, unused, north, sideways), how far
//   into the raised ground each face reaches, in px.
const TERRAIN_SHAPE = `
uniform sampler2D uLift;
uniform vec4 uWallP, uWallL;
float nbL[25];
float nbK[25];
vec2 nbFit;
void loadNb(ivec2 t) {
  ivec2 sz = textureSize(uLift, 0);
  nbFit = texelFetch(uLift, clamp(t, ivec2(0), sz - 1), 0).ba;
  for (int j = 0; j < 5; j++) for (int i = 0; i < 5; i++) {
    ivec2 q = t + ivec2(i - 2, j - 2);
    float L = 0.0, K = 1.0;
    if (q.x >= 0 && q.y >= 0 && q.x < sz.x && q.y < sz.y) { vec4 v = texelFetch(uLift, q, 0); L = v.r * 255.0; K = floor(v.g * 255.0 + 0.5); }
    nbL[j * 5 + i] = L; nbK[j * 5 + i] = K;
  }
}
float runOf(bool sideways, bool south, float kq, float dL, bool lip, bool walk) {
  if (kq > 1.5 && dL <= 4.0) return 4.0;   // a bank into water or lava on its own level
  if (walk) return 0.0;
  vec4 W = lip ? uWallL : uWallP;
  return min(32.0, sideways ? W.w : south ? W.x : W.z);
}
// Surface lift (px) at point p (px, relative to the centre tile's corner) of the loaded tile.
// dir: 0 top, 1 faces south, 2 faces north, 3 faces west, 4 faces east, 5..8 a 45 degree cut that
// faces NE, SE, SW, NW; lowL: the ground it rises from.
// (the twin of rawSurface() in core/shape.ts. How much a tile's faces are scaled so that a top
// is always left is worked out there, once per tile, and arrives in the lift texture.)
float terrH(vec2 p, out int dir, out float lowL, out float run) {
  float L = nbL[12], K = nbK[12];
  dir = 0; lowL = L; run = 0.0;
  if (mod(K, 4.0) > 0.5) return L;
  bool walk = mod(K, 32.0) >= 15.5;   // walkable ground: only banks into liquid beside it
  bool lip = mod(K, 8.0) >= 3.5;
  float sx = nbFit.x, sy = nbFit.y;
  float h = L;
  for (int j = 0; j < 5; j++) for (int i = 0; i < 5; i++) {
    int n = j * 5 + i;
    if (n == 12) continue;
    float kq = mod(nbK[n], 4.0);
    if ((kq > 0.5 && kq < 1.5) || (walk && kq < 1.5)) continue;
    float Lq = nbL[n];
    if (Lq >= L || (walk && L - Lq > 4.0)) continue;
    float dL = L - Lq;
    float ox = float(i - 2) * 16.0, oy = float(j - 2) * 16.0;
    float gx = max(max(ox - p.x, p.x - (ox + 16.0)), 0.0);
    float gy = max(max(oy - p.y, p.y - (oy + 16.0)), 0.0);
    float rx = runOf(true, false, kq, dL, lip, walk) * sx;
    float ry = runOf(false, j > 2, kq, dL, lip, walk) * sy;
    float dx = gx <= 0.0 ? 0.0 : (rx < 0.25 ? 9.0 : gx / rx);
    float dy = gy <= 0.0 ? 0.0 : (ry < 0.25 ? 9.0 : gy / ry);
    float hq = Lq + dL * min(max(dx, dy), 1.0);
    if (hq < h) {
      h = hq; lowL = Lq;
      if (dx >= dy) { dir = i < 2 ? 3 : 4; run = rx; } else { dir = j > 2 ? 1 : 2; run = ry; }
    }
  }
  if (K >= 31.5) {
    // a corner cut at 45 degrees (the twin of the CUT lows in core/shape.ts)
    for (int c = 0; c < 4; c++) {
      int sx = c < 2 ? 1 : -1, sy = (c == 1 || c == 2) ? 1 : -1;
      int na = 12 + sx, nb = 12 + sy * 5;
      float ka = mod(nbK[na], 4.0), kb = mod(nbK[nb], 4.0);
      // (a bank into water or lava is not a wall: it is never cut)
      if ((ka > 0.5 && ka < 1.5) || (kb > 0.5 && kb < 1.5) || nbL[na] >= L - (ka > 1.5 ? 4.0 : 0.0) || nbL[nb] >= L - (kb > 1.5 ? 4.0 : 0.0)) continue;
      float Lq = max(nbL[na], nbL[nb]);
      vec2 cp = vec2(sx > 0 ? 16.0 : 0.0, sy > 0 ? 16.0 : 0.0);
      float hq = Lq + (L - Lq) * min((abs(p.x - cp.x) + abs(p.y - cp.y)) / 16.0, 1.0);
      if (hq < h) { h = hq; lowL = Lq; dir = 5 + c; run = 11.3; }
    }
  }
  return h;
}
`;

// ---------------------------------------------------------------- sprite instances -> G-buffer
export const SPRITE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iDst;   // x, y, w, h (source px)
layout(location=2) in vec4 iSrc;   // atlas x, y, mask x, mask y (mask x < 0: none)
layout(location=3) in vec4 iInst;  // zBase, tileX, tileY, flags
layout(location=4) in vec4 iTint;
uniform vec2 uOff;    // target px = src px * uK + uOff
uniform float uK;
uniform vec2 uTarget;
out vec2 vLocal;
flat out vec4 vSrc;
flat out vec4 vInst;
flat out vec4 vTint;
flat out vec2 vSize;
void main() {
  vec2 p = (iDst.xy + aCorner * iDst.zw) * uK + uOff;
  gl_Position = vec4(p / uTarget * 2.0 - 1.0, 0.0, 1.0);
  vLocal = aCorner * iDst.zw;
  vSrc = iSrc; vInst = iInst; vTint = iTint; vSize = iDst.zw;
}`;

export const SPRITE_FS = HDR + `
uniform sampler2D uA, uN, uE;
uniform sampler2D uOcc;          // terrain tile ids of the screen (copied)
uniform int uOccOn;
` + TERRAIN_SHAPE + `
uniform float uFade;             // detail fade (dithered)
uniform float uMip;              // 1: average the texels under a screen pixel when zoomed out
uniform float uBlock;            // texels of the sprite per drawn sprite pixel (1 = as baked)
uniform float uS;                // texels per px of the sprites in this draw (terrain pieces: 1)
uniform float uK;
uniform float uDepthOn;
uniform vec3 uOutline;          // rim strength: creatures, objects, props
in vec2 vLocal;
flat in vec4 vSrc;
flat in vec4 vInst;
flat in vec4 vTint;
flat in vec2 vSize;
layout(location=0) out vec4 oA;
layout(location=1) out vec4 oN;
layout(location=2) out vec4 oE;
layout(location=3) out vec4 oT;
void main() {
  ivec2 lp = clamp(ivec2(floor(vLocal)), ivec2(0), ivec2(vSize) - 1);
  int flags = int(vInst.w + 0.5);
  if (vSrc.z < -2.5) {
    // ---- the sloped sides of raised ground. The instance covers everything this tile's surface can
    // project to; for each pixel, walk down from the tile's top until the sight line meets the surface.
    loadNb(ivec2(int(vInst.y + 0.5), int(vInst.z + 0.5)));
    float L = nbL[12], lowest = vTint.r;
    // (px of the tile grid, with the texel's own sub-px position when the terrain is baked finer)
    vec2 tc = (floor(vLocal * uS) + 0.5) / uS;
    float ys = tc.y - L, px = tc.x;
    float stepH = 0.5 / uS;
    bool southOpen = mod(nbK[17], 4.0) < 0.5 || mod(nbK[17], 4.0) > 1.5;
    int dir = 0; float lowL = L, run = 0.0, hh = -99.0;
    bool wasSouth = false, was = false;
    for (int s2 = 0; s2 <= 1200; s2++) {
      float h2 = L - float(s2) * stepH;
      if (h2 < lowest - 0.5) break;
      float py = ys + h2;
      if (py < 0.0) break;
      if (py >= 16.0) { wasSouth = true; continue; }
      int d2; float l2, r2;
      float H = terrH(vec2(px, py), d2, l2, r2);
      if (H >= h2 - 0.3) {
        if (!was && !wasSouth) break;                       // the top itself: its own sprite draws that
        if (!was) {                                         // came in over the south edge: an upright face
          // (also where the tile to the south is as high but its own faces start lower there:
          // neighbours can fit their faces differently, and the step between them is drawn here.
          // Where that tile really is higher it is drawn later and covers this.)
          if (!southOpen) break;
          d2 = 1; l2 = nbL[17] < L ? nbL[17] : L - 48.0; r2 = 0.0;
          if (h2 < l2) break;
        }
        hh = h2; dir = d2 == 0 ? 1 : d2; lowL = l2; run = r2;
        break;
      }
      was = true;
    }
    if (hh < -90.0) discard;
    float dL = max(L - lowL, 0.01);
    float frac = clamp((hh - lowL) / dL, 0.0, 1.0);
    // how long the face is on screen, to lay the texture down it at an even scale
    int cutDir = dir;                              // 5 NE, 6 SE, 7 SW, 8 NW: laid out like the south or north face they lean toward
    if (dir >= 5) dir = (dir == 6 || dir == 7) ? 1 : 2;
    float ext = dir == 1 ? run + dL : dir == 2 ? max(run - dL, 3.0) : max(run, dL);
    float down = (1.0 - frac) * ext;
    float py2 = ys + hh;
    float uF = clamp(dir <= 2 ? px : py2, 0.0, 15.999);
    float vF = down;
    if (vF >= 48.0) vF = 4.0 + mod(vF - 4.0, 44.0);
    ivec2 st2 = ivec2(vSrc.xy) + ivec2(floor(vec2(uF, vF) * uS));
    vec4 a2 = texelFetch(uA, st2, 0);
    vec4 n2 = texelFetch(uN, st2, 0);
    vec4 e2 = texelFetch(uE, st2, 0);
    vec3 alb2 = a2.rgb;
    if (down < 1.5) alb2 = min(alb2 * 1.35 + 0.06, 1.0);          // the coping along the top edge
    else if (down < 2.5 && ext > 6.0) alb2 *= 0.7;
    if (frac * ext < 1.5) alb2 *= 0.72;                           // where it meets the floor
    vec3 pn = dir == 1 ? vec3(0.0, dL, run) : dir == 2 ? vec3(0.0, -dL, run) : dir == 3 ? vec3(-dL, 0.0, run) : vec3(dL, 0.0, run);
    if (cutDir >= 5) pn = vec3((cutDir <= 6 ? 0.707 : -0.707) * dL, ((cutDir == 6 || cutDir == 7) ? 0.707 : -0.707) * dL, run);
    vec3 det = (n2.rgb * 2.0 - 1.0) - vec3(0.0, 1.0, 0.0);
    det = dir == 1 ? det : dir == 2 ? vec3(-det.x, -det.y, det.z) : dir == 3 ? vec3(-det.y, det.x, det.z) : vec3(det.y, -det.x, det.z);
    vec3 nn2 = normalize(normalize(pn) + det * 0.6);
    oA = vec4(alb2, 1.0);
    oN = vec4(nn2 * 0.5 + 0.5, clamp((hh / 16.0 + 1.0) * 40.0 / 255.0, 0.0, 1.0));
    oE = vec4(e2.rgb, e2.a);
    int tx2 = int(vInst.y + 0.5), ty2 = int(vInst.z + 0.5);
    oT = vec4(float(tx2 & 255), float(ty2 & 255), float((tx2 >> 8) + (ty2 >> 8) * 16), 0.0) / 255.0;
    return;
  }
  bool face = (flags & 1) != 0;
  bool flip = (flags & 128) != 0;
  // from here on in the sprite's own texels: a sprite baked finer than the tile grid has uS of them per px
  vec2 tLocal = vLocal * uS;
  ivec2 tSize = ivec2(vSize * uS + 0.5);
  lp = clamp(ivec2(floor(tLocal)), ivec2(0), tSize - 1);
  if ((flags & 16) != 0 && !face) {
    // the top of a tile with sloped sides: only where the surface really is at the top
    loadNb(ivec2(int(vInst.y + 0.5), int(vInst.z + 0.5)));
    int d3; float l3, r3;
    if (terrH((floor(vLocal * uS) + 0.5) / uS, d3, l3, r3) < nbL[12] - 0.3) discard;
  }
  ivec2 lq = flip ? ivec2(tSize.x - 1 - lp.x, lp.y) : lp;
  ivec2 st = ivec2(vSrc.xy) + lq;
  int iS = int(uS + 0.5);
  if (face && lp.y >= 48 * iS) st = ivec2(vSrc.xy) + ivec2(lp.x, 4 * iS + (lp.y - 4 * iS) % (44 * iS));
  vec4 a = texelFetch(uA, st, 0);
  // Mipmapping for sprites, on all three of their textures (colour, normal + height, emission).
  // A sheet's stock mipmaps would bleed neighbouring sprites into each other, so each screen
  // pixel averages the texels of ITS sprite that fall on it: the same result as a mip level
  // made for that sprite alone. Only texels that are part of the sprite count.
  // The area averaged is whichever is larger: what one screen pixel covers when zoomed out, or
  // one block of the sprite's own grid when the sprite resolution is set below what it was baked at.
  bool mipd = false; vec4 nM = vec4(0.0); vec4 eM = vec4(0.0);
  // Silhouette rim: the bake marks a sprite's edge texels (albedo alpha below full), one px of the
  // tile grid wide at any resolution. They are darkened as they are read, so the mip average below
  // is taken of the finished, outlined sprite.
  float rimK = (flags & 512) != 0 ? uOutline.x : (flags & 1024) != 0 ? uOutline.y : (flags & 2048) != 0 ? uOutline.z : 0.0;
  if (face || uOccOn != 1) rimK = 0.0;
  vec3 rimMul = vec3(1.0 - rimK, 1.0 - rimK, 1.0 - rimK * 0.85);
  float fMip = uMip > 0.5 ? uS / uK : 1.0;
  float foot = max(fMip, uBlock);
  if (uBlock > 1.001 && uBlock >= fMip && !face) {
    // sprite resolution below the bake: one texel stands for its whole block (crisp, not blurred)
    ivec2 q = clamp(ivec2(floor((floor(tLocal / uBlock) + 0.5) * uBlock)), ivec2(0), tSize - 1);
    lp = q;
    lq = flip ? ivec2(tSize.x - 1 - q.x, q.y) : q;
    st = ivec2(vSrc.xy) + lq;
    a = texelFetch(uA, st, 0);
  } else if (foot > 1.001 && !face) {
    vec2 org = tLocal - 0.5 * foot;
    int nS = foot > 3.3 ? 4 : foot > 2.2 ? 3 : 2;
    vec3 sum = vec3(0.0); float cov = 0.0; bool gotMat = false;
    for (int sy = 0; sy < 4; sy++) for (int sx = 0; sx < 4; sx++) {
      if (sx >= nS || sy >= nS) continue;
      ivec2 q = clamp(ivec2(floor(org + (vec2(float(sx), float(sy)) + 0.5) / float(nS) * foot)), ivec2(0), tSize - 1);
      if (flip) q.x = tSize.x - 1 - q.x;
      ivec2 sq = ivec2(vSrc.xy) + q;
      vec4 t = texelFetch(uA, sq, 0);
      if (t.a < 0.5) continue;
      if (t.a < 0.9) t.rgb *= rimMul;
      vec4 tn = texelFetch(uN, sq, 0), te = texelFetch(uE, sq, 0);
      sum += t.rgb; nM += tn; eM.rgb += te.rgb; cov += 1.0;
      if (!gotMat) { eM.a = te.a; gotMat = true; }   // a material id cannot be averaged: the first texel's stands
    }
    if (cov < float(nS * nS) * 0.34) discard;
    a = vec4(sum / cov, 1.0);
    nM /= cov; eM.rgb /= cov;
    mipd = true;
  }
  if (a.a < 0.5) discard;
  if (!mipd && a.a < 0.9) a.rgb *= rimMul;
  float fadeA = uFade * (vSrc.z < -1.5 ? vSrc.w : 1.0);   // per-instance fade (hidden / done changes)
  if (fadeA < 1.0) {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    if ((float(m[(p.y & 3) * 4 + (p.x & 3)]) + 0.5) / 16.0 >= fadeA) discard;
  }
  int myRow = int(vInst.z + 0.5);
  if (uOccOn == 1) {
    // hidden behind raised ground further south (row order + elevation)
    ivec3 tb = ivec3(texelFetch(uOcc, ivec2(gl_FragCoord.xy), 0).rgb * 255.0 + 0.5);
    ivec2 tt = ivec2(tb.x + (tb.z & 15) * 256, tb.y + (tb.z >> 4) * 256);
    if (tt.y > myRow && texelFetch(uLift, tt, 0).r * 255.0 > vInst.x * 16.0 + 0.5) discard;
  }
  if (uDepthOn > 0.5) gl_FragDepth = 1.0 - (float(myRow) * 2.0 + ((flags & 64) != 0 ? 1.0 : 0.0) + 2.0) / 16384.0;
  if (vSrc.z >= 0.0 && texelFetch(uA, ivec2(vSrc.zw) + lq, 0).a < 0.5) discard;
  vec4 n = texelFetch(uN, st, 0);
  vec4 e = texelFetch(uE, st, 0);
  if (mipd) { n = nM; e = eM; }
  int mat = int(e.a * 255.0 + 0.5);
  vec3 alb = a.rgb;
  // wall-foot base piece (corner texture): an albedo multiplier whose frame travels in the tint
  if ((flags & 8388608) != 0) alb *= texelFetch(uA, ivec2(vTint.rg) + lp, 0).rgb;
  if (mat == 6) { alb *= vTint.rgb; mat = 0; }
  else if ((flags & 32) != 0) alb *= vTint.rgb;
  float h = face ? vInst.x - (float(lp.y) + 0.5) / (16.0 * uS) + 0.5 / 16.0 : vInst.x + n.a * 255.0 / 40.0 - 1.0;
  vec3 nn = n.rgb * 2.0 - 1.0;
  if (flip) nn.x = -nn.x;
  // ---- autotiled raised edges (terrain tops): rims / coping on exposed edges, rounded or chamfered
  // outer corners, lit inner corners; and contact skirting where higher ground meets this tile
  if (!face && vSrc.z > -1.5 && vSrc.z < -0.5) {
    float cr = vSrc.w;
    bool chamfer = cr >= 15.5;
    if (chamfer) cr -= 16.0;
    float rw = cr > 0.0 ? (chamfer ? 3.0 : 2.0) : 1.0;
    vec2 pc = vLocal;
    float dLit = 99.0, dDark = 99.0;
    if ((flags & 2) != 0) dLit = min(dLit, pc.y);
    if ((flags & 4) != 0) dLit = min(dLit, pc.x);
    if ((flags & 8) != 0) dDark = min(dDark, 16.0 - pc.x);
    for (int c = 0; c < 2; c++) {
      if ((flags & (c == 0 ? 16384 : 32768)) == 0 || cr <= 0.0) continue;
      vec2 q = vec2(c == 0 ? pc.x : 16.0 - pc.x, pc.y);
      if (q.x >= cr || q.y >= cr) continue;
      float inside = chamfer ? (q.x + q.y - cr) * 0.7071 : cr - length(vec2(cr) - q);
      if (inside < 0.0) discard;
      // the rim follows the cut: replace the straight edges by the distance to the arc / mitre
      dLit = min(dLit, max(inside, 0.0));
      if (c == 1) dDark = 99.0;
      nn = normalize(nn + vec3(c == 0 ? -0.5 : 0.5, -0.5, 0.3));
    }
    if (dLit >= rw && dLit < rw + 1.0 && chamfer) alb *= 0.62;   // coping groove inside the rim (walls)
    if (dLit < rw) { alb = min(alb * 1.6 + 0.12, 1.0); nn = normalize(nn + vec3((flags & 4) != 0 && pc.x < rw ? -0.7 : 0.0, (flags & 2) != 0 && pc.y < rw ? -0.7 : 0.0, 0.3)); }
    else if (dDark < 1.0) alb *= 0.55;
    // inner corners: the rim turns the corner (diagonal neighbour lower)
    if ((flags & 65536) != 0 && pc.x < rw && pc.y < rw) alb = min(alb * 1.5 + 0.07, 1.0);
    if ((flags & 131072) != 0 && pc.x > 16.0 - rw && pc.y < rw) alb = min(alb * 1.2 + 0.03, 1.0);
    // contact skirting at the foot of higher ground, with matching inner / outer corners
    float sk = 0.0;
    if ((flags & 262144) != 0) sk = max(sk, 1.0 - pc.y / 3.0);
    if ((flags & 1048576) != 0) sk = max(sk, 1.0 - pc.x / 2.5);
    if ((flags & 524288) != 0) sk = max(sk, 1.0 - (16.0 - pc.x) / 2.5);
    if ((flags & 2097152) != 0) sk = max(sk, 1.0 - length(pc) / 3.0);
    if ((flags & 4194304) != 0) sk = max(sk, 1.0 - length(vec2(16.0 - pc.x, pc.y)) / 3.0);
    alb *= 1.0 - clamp(sk, 0.0, 1.0) * 0.4;
  }
  if (face) {
    // face end returns: lit west edge, shaded east edge where the face turns a corner
    if ((flags & 4096) != 0 && int(vLocal.x) == 0) { alb = min(alb * 1.3 + 0.03, 1.0); nn = normalize(nn + vec3(-0.9, 0.0, 0.0)); }
    if ((flags & 8192) != 0 && int(vLocal.x) >= int(vSize.x) - 2) { alb *= int(vLocal.x) == int(vSize.x) - 1 ? 0.5 : 0.75; nn = normalize(nn + vec3(0.9, 0.0, 0.0)); }
  }
  oA = vec4(alb, 1.0);
  oN = vec4(nn * 0.5 + 0.5, clamp((h + 1.0) * 40.0 / 255.0, 0.0, 1.0));
  oE = vec4(e.rgb * vTint.a, float(mat) / 255.0);
  int tx = int(vInst.y + 0.5), ty = int(vInst.z + 0.5);
  oT = vec4(float(tx & 255), float(ty & 255), float((tx >> 8) + (ty >> 8) * 16), 0.0) / 255.0;
  oT.a = (flags & 64) != 0 ? 1.0 : 0.0;
}`;

// ---------------------------------------------------------------- world-space shadow caster height map
// R = top of props / characters (height in tiles * 40 / 255), B = 1 - their underside, G = terrain lift.
// What stands on the ground is a volume between an underside and a top, not a solid column: the
// space under a tree's crown or under something that flies lets light through. Instances use SPRITE_VS
// with dst in ground px (16 per tile), mapped into the caster map.
export const CASTER_FS = HDR + `
uniform sampler2D uTop, uA;
uniform float uS;   // texels per px of the sprites in this draw
in vec2 vLocal;
flat in vec4 vSrc;
flat in vec4 vInst;
flat in vec4 vTint;
flat in vec2 vSize;
out vec4 o;
void main() {
  int flags = int(vInst.w + 0.5);
  bool flip = (flags & 128) != 0;
  ivec2 tSize = ivec2(vSize * uS + 0.5);
  ivec2 lp = clamp(ivec2(floor(vLocal * uS)), ivec2(0), tSize - 1);
  int lx = flip ? tSize.x - 1 - lp.x : lp.x;
  float hh, hb = 0.0;
  if ((flags & 256) != 0) {
    // flat card: the silhouette column above this base pixel, as a vertical card
    int oy = int(vSrc.z * uS + 0.5);
    int r = 0;
    for (; r < 1280; r++) { if (r >= oy || texelFetch(uA, ivec2(vSrc.xy) + ivec2(lx, r), 0).a > 0.5) break; }
    if (r >= oy) discard;
    hh = float(oy - r) / (16.0 * uS);
  } else {
    vec2 tb = texelFetch(uTop, ivec2(vSrc.xy) + ivec2(lx, lp.y), 0).rg * 255.0;
    if (tb.r < 0.5) discard;
    hh = (tb.r - 1.0) / 40.0;
    hb = tb.g / 40.0;
  }
  // R: the highest point of what stands here; B: one minus its lowest point (the blend keeps the
  // maximum of each, so where several things overlap the volume runs from the lowest to the highest)
  o = vec4(clamp((vInst.x + hh) * 40.0 / 255.0, 0.0, 1.0), 0.0, 1.0 - clamp((vInst.x + hb) * 40.0 / 255.0, 0.0, 1.0), 0.0);
}`;

export const TERRAIN_H_FS = HDR + TERRAIN_SHAPE + `
uniform vec2 uOrigin;   // world tile of caster map pixel (0,0)
uniform float uR;       // caster px per tile
uniform ivec2 uDim;
out vec4 o;
void main() {
  vec2 wt = uOrigin + gl_FragCoord.xy / uR;
  ivec2 t = ivec2(floor(wt));
  float L = 0.0;
  if (t.x >= 0 && t.y >= 0 && t.x < uDim.x && t.y < uDim.y) {
    vec4 c = texelFetch(uLift, t, 0);
    L = c.r * 255.0;
    // only tiles that have slopes need their neighbourhood
    if (mod(floor(c.g * 255.0 + 0.5), 16.0) >= 7.5) {
      loadNb(t);
      int d; float l, r;
      L = terrH(fract(wt) * 16.0, d, l, r);
    }
  }
  o = vec4(0.0, clamp(L / 16.0 * 40.0 / 255.0, 0.0, 1.0), 0.0, 0.0);
}`;

// ---------------------------------------------------------------- static terrain layers (overview or chunk) -> screen G-buffer
export const QUAD_VS = `#version 300 es
uniform vec2 uOff;   // screen px of texture origin
uniform float uK;    // screen px per texture px
uniform vec2 uTex;   // texture size
uniform vec2 uTarget;
void main() {
  vec2 c = vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : 0.0, gl_VertexID >= 2 ? 1.0 : 0.0);
  vec2 p = uOff + c * uTex * uK;
  gl_Position = vec4(p / uTarget * 2.0 - 1.0, 0.0, 1.0);
}`;

export const BLIT_FS = HDR + `
uniform sampler2D uA, uN, uE, uT;
uniform vec2 uOff;
uniform float uK;
uniform vec2 uTex;
uniform float uFade;
layout(location=0) out vec4 oA;
layout(location=1) out vec4 oN;
layout(location=2) out vec4 oE;
layout(location=3) out vec4 oT;
float bayer(ivec2 p) {
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[(p.y & 3) * 4 + (p.x & 3)]) + 0.5) / 16.0;
}
void main() {
  if (uFade < 1.0 && bayer(ivec2(gl_FragCoord.xy)) >= uFade) discard;
  vec2 dp = (gl_FragCoord.xy - uOff) / uK;
  if (dp.x < 0.0 || dp.y < 0.0 || dp.x >= uTex.x || dp.y >= uTex.y) discard;
  vec2 uv = dp / uTex;
  ivec2 ip = ivec2(dp);
  vec4 a = texture(uA, uv);
  if (a.a < 0.5) discard;
  vec4 n = texture(uN, uv);
  vec4 e = texture(uE, uv);
  oA = vec4(a.rgb / a.a, 1.0);
  oN = vec4(normalize(n.rgb * 2.0 - 1.0) * 0.5 + 0.5, n.a);
  oE = vec4(e.rgb, texelFetch(uE, ip, 0).a);
  oT = texelFetch(uT, ip, 0);
}`;

// ---------------------------------------------------------------- lighting
export const LIGHT_FS = HDR + `
uniform sampler2D gA, gN, gE, gT, uMask, uGhost;
uniform vec2 uOff;
uniform float uK;
uniform float uTop;
uniform vec2 uIS;
uniform vec3 uKeyDir, uKeyCol, uAmbTop, uAmbBot, uBg0, uBg1, uFogTint, uGhostTint;
uniform vec4 uLP[${32}];
uniform vec4 uLC[${32}];
uniform int uNL;
uniform float uTime, uFresh, uMotion, uHdr, uRock, uShadowLen;
uniform sampler2D uCast;
uniform vec2 uCastO;      // caster map origin (world tiles)
uniform float uCastR;     // caster px per tile
uniform vec2 uCastSize;
uniform vec3 uSeaAvg;     // average colour of the deep-water tile texture
uniform vec3 uSun;        // direction toward the sun (x east, y south, z up), normalized
uniform float uShadowMode, uShadowStr, uShadowSoft, uTerrainSh, uContact, uAmbK, uSunK, uPointK, uSea;
uniform float uFogDark, uFogDesat, uWaterK, uFoamK, uGlintK, uGlintPL;
uniform float uTexS;   // texels per px of the tile grid (texture resolution / 16): lighting, shadows and water keep to that grid
uniform vec4 uGlintP; // water speculars: density, cells per tile, crest focus, low-sun boost
uniform sampler2D uOvA;
uniform float uOvP, uOvTop;
uniform vec2 uOvSize;
uniform int uLSN;          // how many of the first (strongest) lights cast shadows
uniform float uLSK, uLSSoft;
uniform vec4 uGhost0;   // on, ghost top (dim px), ghost overview px per dim px
uniform vec2 uGhostSize;
out vec4 o;
float dh(vec4 n) { return n.a * 255.0 / 40.0 - 1.0; }
// what is over world point q: (terrain height, top of what stands there, its underside), in tiles
vec3 castAt(vec2 q) {
  vec2 uv = (q - uCastO) * uCastR;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= uCastSize.x || uv.y >= uCastSize.y) return vec3(-9.0, -9.0, 9.0);
  vec4 c = texelFetch(uCast, ivec2(uv), 0);
  return vec3(c.g * uTerrainSh, c.r, 1.0 - c.b) * 255.0 / 40.0;
}
float shadowRay(vec3 P, vec3 S) {
  float lxy = length(S.xy);
  if (lxy < 1e-3) return 0.0;
  vec2 d = S.xy / lxy;
  float tanE = S.z / lxy;
  float maxT = min(9.0, 7.0 / max(tanE, 0.05));
  // one texel of the caster map per step: nothing as thin as a trunk can fall between two samples
  float stepT = 1.0 / uCastR;
  for (int i = 1; i <= 160; i++) {
    float t = float(i) * stepT;
    if (t > maxT) break;
    float hz = P.z + t * tanE;
    vec3 c = castAt(P.xy + d * t);
    if (c.x > hz + 0.03 || (c.y > hz + 0.03 && c.z <= hz + 0.03)) return 1.0;
  }
  return 0.0;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// ---- water: broad slow swells (world space, a few tiles long), rare drifting foam streaks
float swell(vec2 w, float t) {
  return sin(w.x * 0.55 + w.y * 0.32 - t * 0.45) * 0.6 + sin(w.x * 0.21 - w.y * 0.62 + t * 0.31) * 0.4;
}
vec2 swellGrad(vec2 w, float t) {
  return vec2(cos(w.x * 0.55 + w.y * 0.32 - t * 0.45) * 0.33 + cos(w.x * 0.21 - w.y * 0.62 + t * 0.31) * 0.084,
              cos(w.x * 0.55 + w.y * 0.32 - t * 0.45) * 0.19 - cos(w.x * 0.21 - w.y * 0.62 + t * 0.31) * 0.25);
}
// a few short 1 px foam streaks per screen that drift and fade in and out (never a per-pixel hash)
float foamStreak(vec2 w, float t) {
  vec2 cs = vec2(3.0, 1.5);
  vec2 g = (w + vec2(t * 0.12, 0.0)) / cs;
  vec2 id = floor(g), f = fract(g);
  float h = hash(id);
  if (h > 0.3) return 0.0;
  float life = sin(t * 0.45 + h * 40.0);
  if (life < 0.35) return 0.0;
  float y0 = 0.25 + hash(id + 3.1) * 0.5, x0 = 0.1 + hash(id + 7.7) * 0.4, len = 0.18 + hash(id + 1.3) * 0.25;
  float row = abs(floor(f.y * cs.y * 16.0) - floor(y0 * cs.y * 16.0));
  return step(row, 0.5) * step(x0, f.x) * step(f.x, x0 + len) * (life - 0.35) / 0.65;
}
// deep-sea albedo and normal at world point w (shared by sea tiles and the sea past the map edge)
vec3 seaAlbedo(vec2 w, float dist, float t, out vec3 n) {
  vec2 q = floor(w * 16.0 * uTexS) / (16.0 * uTexS);   // stay on the pixel grid
  float sw = swell(q, t);
  float band = floor(sw * 1.4 + 0.5) / 1.4;
  float far = smoothstep(2.0, 8.0, dist);
  vec3 base = vec3(0.07, 0.2, 0.38) * (1.0 + band * 0.1) * mix(1.0, 0.8, far);
  vec2 gr = swellGrad(q, t) * 0.18 * (1.0 - far * 0.5);
  n = normalize(vec3(-gr, 1.0));
  return base;
}

// occlusion of the segment from surface point P to point light Lp over the world height map
float lightOcc(vec3 P, vec3 Lp) {
  vec2 dxy = Lp.xy - P.xy;
  float len = length(dxy);
  if (len < 0.3) return 0.0;
  // Step a fixed distance in the world, not a fixed number of times: every 0.2 tile, so a
  // one-tile wall or a pillar can never fall between two samples however far the light is.
  float n = clamp(ceil(len / 0.2), 4.0, 48.0);
  float occ = 0.0;
  for (int k = 1; k <= 48; k++) {
    float fk = float(k);
    if (fk >= n) break;
    float u = fk / n;
    // Only the light's own fixture is exempt (a torch bracket, a crystal). This used to skip
    // 0.55 tile, which is most of the wall a torch hangs on, and let its light through that wall.
    if (len * (1.0 - u) < 0.22) break;
    vec3 c = castAt(P.xy + dxy * u);
    float zr = mix(P.z, Lp.z, u);
    // the ray is blocked by ground above it, or by something standing there whose volume it passes through
    occ = max(occ, max(smoothstep(0.02, 0.05 + uLSSoft * 0.35, c.x - zr), smoothstep(0.02, 0.05 + uLSSoft * 0.35, c.y - zr) * step(c.z, zr + 0.03)));
    if (occ >= 0.999) break;
  }
  return occ;
}
float toon(float x) { return smoothstep(0.02, 0.07, x) * 0.36 + smoothstep(0.28, 0.34, x) * 0.34 + smoothstep(0.6, 0.66, x) * 0.30; }
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(gA, fc, 0);
  vec2 dp = (gl_FragCoord.xy - uOff) / uK;
  vec2 sp = uK > uTexS ? (floor(dp * uTexS) + 0.5) / uTexS : dp;
  float X = sp.x / 16.0, Ys = (sp.y - uTop) / 16.0;
  if (A.a < 0.5) {
    vec3 bg = mix(uBg0, uBg1, gl_FragCoord.y / uIS.y);
    if (uSea > 0.0) {
      // open sea continuing past the map edge: the same model as the deep-water tiles, no seam
      float tt = uTime * uMotion * uWaterK;
      vec2 wq = vec2(sp.x, sp.y - uTop) / 16.0;
      vec3 sn;
      // distance to land continues the in-map value across the boundary, so there is no seam
      ivec2 msz = textureSize(uMask, 0);
      vec2 cl = clamp(floor(wq), vec2(0.0), vec2(msz) - 1.0);
      vec4 em = texelFetch(uMask, ivec2(cl), 0);
      int ec = int(em.b * 255.0 + 0.5);
      float edist = (int(em.a * 255.0 + 0.5) == 2 && ec >= 16) ? float(ec - 16) : 15.0;
      float outD = length(wq - cl - 0.5);
      if (int(em.a * 255.0 + 0.5) == 2) {
        // beyond a sea edge: open sea
        vec3 sa = seaAlbedo(wq, edist + outD, tt, sn);
        float fo = foamStreak(wq, tt) * uFoamK * 0.4 * smoothstep(0.35, 0.9, uK);
        sa = mix(sa, vec3(0.62, 0.7, 0.75), fo);
        float nlk = max(dot(sn, uKeyDir), 0.0);
        bg = sa * (mix(uAmbBot, uAmbTop, sn.z * 0.5 + 0.5) * uAmbK + uKeyCol * uSunK * toon(nlk));
      } else {
        // beyond a land edge (mountain range, thicket, wastes): continue the edge's terrain as chunky
        // pixel noise in its own colours, dimmed with distance
        vec2 ouv = (vec2(cl.x + 0.5, cl.y + 0.5 + uOvTop) * uOvP) / uOvSize;
        vec3 ec0 = textureLod(uOvA, ouv, 3.0).rgb;   // blurred edge colour: no stripes from single edge pixels
        vec2 g2 = floor(wq * 4.0);
        float nb = hash(floor(wq * 0.7)) * 0.5 + hash(floor(wq * 1.6)) * 0.3 + hash(g2) * 0.2;
        vec3 la = ec0 * (0.7 + nb * 0.55);
        float lift = step(0.62, hash(floor(wq * 1.6) + 7.0));
        vec3 ln = normalize(vec3(hash(g2 + 1.0) - 0.5, hash(g2 + 2.0) - 0.5 - lift * 0.4, 1.0));
        float dim2 = mix(1.0, 0.45, 1.0 - exp(-outD / 14.0));
        bg = la * dim2 * (mix(uAmbBot, uAmbTop, ln.z * 0.5 + 0.5) * uAmbK + uKeyCol * uSunK * toon(max(dot(ln, uKeyDir), 0.0)));
      }
      if (em.r > 0.5) {
        float l = dot(bg, vec3(0.3, 0.59, 0.11));
        bg = mix(bg * (1.0 - uFogDark), vec3(l) * uFogTint * (1.0 - uFogDark) * 1.6, uFogDesat);
      }
    }
    if (uRock > 0.0) {
      float n = hash(floor(dp / 5.0)) * 0.45 + hash(floor(dp / 23.0)) * 0.55;
      bg *= 0.55 + n * 0.9;
    }
    if (uGhost0.x > 0.0) {
      vec2 guv = vec2(dp.x, dp.y - uTop + uGhost0.y) * uGhost0.z / uGhostSize;
      if (guv.x > 0.0 && guv.y > 0.0 && guv.x < 1.0 && guv.y < 1.0) {
        vec4 g = textureLod(uGhost, guv, uGhost0.w) * 0.5 + textureLod(uGhost, guv, uGhost0.w + 1.0) * 0.5;
        float gl2 = dot(g.rgb, vec3(0.3, 0.59, 0.11));
        bg = mix(bg, mix(vec3(gl2), g.rgb, 0.5) * uGhostTint, clamp(g.a * 1.2, 0.0, 1.0) * 0.4);
      }
    }
    o = vec4(bg * uHdr, 1.0);
    return;
  }
  vec4 Nn = texelFetch(gN, fc, 0);
  vec3 N = normalize(Nn.rgb * 2.0 - 1.0);
  float h = dh(Nn);
  vec4 E = texelFetch(gE, fc, 0);
  int mat = int(E.a * 255.0 + 0.5);
  vec4 Tt = texelFetch(gT, fc, 0);
  ivec3 tb = ivec3(Tt.rgb * 255.0 + 0.5);
  ivec2 tile = ivec2(tb.x + (tb.z & 15) * 256, tb.y + (tb.z >> 4) * 256);
  vec4 M = texelFetch(uMask, tile, 0);
  float fog = M.r, fresh = M.g;
  vec3 P = vec3(X, Ys + h, h);
  float t = uTime * uMotion * uWaterK;
  vec3 emi = E.rgb * 1.8;
  int flowC = int(M.b * 255.0 + 0.5), wk = int(M.a * 255.0 + 0.5);
  float waterGlint = 0.0;
  if (mat == 1) {
    vec2 q = floor(P.xy * 16.0 * uTexS) / (16.0 * uTexS);
    float zf = smoothstep(0.35, 0.9, uK);   // fine detail fades out when zoomed out (no moire)
    if (wk == 2) {
      // deep sea: dark readable blue, broad slow swells, rare foam streaks; darker far from land
      float dist = flowC >= 16 ? float(flowC - 16) : 0.0;
      vec3 sn;
      // the tile's own texture carries the detail; the swell model sets tone and shading, the same
      // as for the open sea past the map's edge (whose flat colour is this texture's average)
      A.rgb = A.rgb / max(uSeaAvg, vec3(0.004)) * seaAlbedo(P.xy, dist, t, sn);
      N = sn;
      float fo = foamStreak(P.xy, t) * uFoamK * zf * (1.0 - smoothstep(2.0, 10.0, dist) * 0.6);
      A.rgb = mix(A.rgb, vec3(0.62, 0.7, 0.75), fo);
      waterGlint = step(0.78 * uGlintP.z, swell(q, t)) * step(1.0 - 0.015 * uGlintP.x, hash(floor(P.xy * uGlintP.y))) * zf;
    } else {
      // swimmable water: lighter, clearer and calmer
      float sw = swell(q * 1.3, t * 0.7);
      A.rgb *= 1.0 + floor(sw * 1.2 + 0.5) / 1.2 * 0.05;
      N = normalize(vec3(-swellGrad(q * 1.3, t * 0.7) * 0.06, 1.0));
      if (flowC > 0 && flowC < 16) {
        // river: a few long, soft streaks drifting downstream
        vec2 fd = flowC == 1 ? vec2(0.0, -1.0) : flowC == 2 ? vec2(1.0, 0.0) : flowC == 3 ? vec2(0.0, 1.0) : vec2(-1.0, 0.0);
        float along = dot(q, fd), across = dot(q, vec2(-fd.y, fd.x));
        float lane = floor(across * 16.0 / 3.0);
        float st = fract(along * 0.35 - t * 0.35 + hash(vec2(lane, 1.0)) * 7.0);
        emi += vec3(0.1, 0.14, 0.17) * smoothstep(0.7, 0.95, st) * (1.0 - smoothstep(0.95, 1.0, st)) * step(0.72, hash(vec2(lane, 2.0))) * zf * uFoamK;
      }
      waterGlint = step(0.85 * uGlintP.z, sw) * step(1.0 - 0.008 * uGlintP.x, hash(floor(P.xy * uGlintP.y))) * zf;
    }
    if (uRock > 0.0) {
      // underground water: a soft, banded caustic glow
      float c = floor((0.5 + 0.5 * sin(q.x * 1.7 + t * 0.6) * sin(q.y * 1.4 - t * 0.7)) * 3.0) / 3.0;
      emi += vec3(0.03, 0.1, 0.14) * (0.6 + c);
    }
  } else if (mat == 7) {
    // falling water: bright streaks scrolling down the face, per texel column
    float col = floor(dp.x);
    float r = hash(vec2(col, 3.0));
    float v = fract(dp.y / 16.0 * 0.8 - t * (0.9 + r * 0.6) + r * 7.0);
    emi += (vec3(0.22, 0.3, 0.34) * smoothstep(0.6, 0.95, v) * step(0.55, r) * (uMotion > 0.0 ? 1.0 : 0.4) + vec3(0.04, 0.08, 0.12)) * smoothstep(0.35, 0.9, uK);
    N = normalize(vec3(0.0, 0.7, 0.7));
  } else if (mat == 8) {
    // surf: a thin foam line hugging the coast, breathing in and out (kept below the bloom threshold)
    A.rgb *= 0.78 + 0.2 * sin(t * 1.3 + floor(P.x * 4.0) * 0.9 + floor(P.y * 4.0) * 0.7);
  } else if (mat == 2) {
    vec2 q = floor(P.xy * 8.0) / 8.0;
    emi *= 0.75 + 0.35 * sin(t * 1.8 + q.x * 2.1 + q.y * 1.7) + 0.15 * sin(t * 3.7 + q.y * 5.0);
  } else if (mat == 3) {
    N = normalize(N + vec3(sin(P.y * 2.0 + t * 0.4), 0.0, 0.0) * 0.1);
  }
  // key light with height-field shadow march toward the light
  float nl = dot(N, uKeyDir);
  if (mat == 5 || mat == 3) nl = (nl + 0.4) / 1.4;
  float sh = 1.0;
  if (uShadowMode > 0.5 && uSun.z > 0.02) {
    float gS = 16.0 * uTexS;
    vec3 Pg = vec3((floor(P.x * gS) + 0.5) / gS, (floor(P.y * gS) + 0.5) / gS, P.z + 0.02);
    float occ0 = shadowRay(Pg, uSun);
    if (uShadowSoft > 0.0) {
      vec3 s1 = normalize(uSun + vec3(-uSun.y, uSun.x, 0.0) * 0.08 * uShadowSoft);
      vec3 s2 = normalize(uSun - vec3(-uSun.y, uSun.x, 0.0) * 0.08 * uShadowSoft);
      occ0 = (occ0 * 2.0 + shadowRay(Pg, s1) + shadowRay(Pg, s2)) * 0.25;
    }
    sh = 1.0 - occ0 * uShadowStr;
  }
  // contact occlusion from nearby higher pixels
  float occ = 0.0;
  float r1 = 5.0 * uK;
  occ += clamp(dh(texelFetch(gN, clamp(fc + ivec2(-int(r1), 0), ivec2(0), ivec2(uIS) - 1), 0)) - h, 0.0, 0.6);
  occ += clamp(dh(texelFetch(gN, clamp(fc + ivec2(int(r1), 0), ivec2(0), ivec2(uIS) - 1), 0)) - h, 0.0, 0.6);
  occ += clamp(dh(texelFetch(gN, clamp(fc + ivec2(0, -int(r1)), ivec2(0), ivec2(uIS) - 1), 0)) - h, 0.0, 0.6);
  occ += clamp(dh(texelFetch(gN, clamp(fc + ivec2(0, -int(r1 * 2.0)), ivec2(0), ivec2(uIS) - 1), 0)) - h, 0.0, 0.6);
  if (N.z < 0.5) occ *= 0.25; // walls facing the camera: only contact shadow from what is in front
  float ao = 1.0 - min(occ * 0.55, 0.6) * uContact / 0.6;
  vec3 amb = mix(uAmbBot, uAmbTop, N.z * 0.5 + 0.5) * ao * uAmbK;
  // dynamic objects (chests, doors, NPCs, gates) get a lift + rim so they stay easy to spot
  float isObj = Tt.a;
  amb += vec3(0.3, 0.28, 0.34) * isObj;
  vec3 key = uKeyCol * uSunK * toon(max(nl, 0.0)) * sh;
  vec3 V = vec3(0.0, 0.7071, 0.7071);
  bool shiny = mat == 1 || mat == 4 || mat == 7;
  vec3 spec = vec3(0.0);
  if (mat == 1) {
    // sparse glints on swell crests, mostly when the sun or moon is low
    float lowK = 1.0 - smoothstep(0.25, 0.75, uKeyDir.z);
    spec += uKeyCol * waterGlint * sh * uGlintK * (0.12 + 0.3 * lowK * uGlintP.w);
  } else if (shiny) {
    vec3 hv = normalize(uKeyDir + V);
    spec += uKeyCol * step(0.965, dot(N, hv)) * sh * 0.6;
  }
  vec3 pl = vec3(0.0);
  for (int i = 0; i < ${32}; i++) {
    if (i >= uNL) break;
    vec4 L = uLP[i];
    vec3 d = L.xyz - P;
    float dist = length(d);
    float att = clamp(1.0 - dist / L.w, 0.0, 1.0);
    if (att <= 0.0) continue;
    att *= att;
    vec3 l = d / max(dist, 1e-3);
    float nd = dot(N, l);
    // a surface above the light and facing up (wall tops, cliff tops) gets nothing from it
    if (P.z > L.z + 0.04 && N.z > 0.6) continue;
    float lo = (i < uLSN) ? lightOcc(vec3(P.xy, P.z + 0.03), L.xyz) * uLSK : 0.0;
    if (mat == 5 || mat == 3) nd = (nd + 0.4) / 1.4;
    float pul = uLC[i].w > 0.0 ? 0.72 + 0.28 * sin(uTime * uMotion * uLC[i].w + L.x * 3.1 + L.y) : 1.0;
    pl += uLC[i].rgb * uPointK * toon(max(nd, 0.0) * att * 1.6) * pul * (1.0 - lo);
    if (shiny && mat != 1) {
      vec3 hv = normalize(l + V);
      spec += uLC[i].rgb * step(0.93, dot(N, hv)) * att * 0.8 * pul;
    }
    if (mat == 1) spec += uLC[i].rgb * waterGlint * att * 0.6 * pul * uGlintPL;
  }
  if (fog > 0.5) { pl *= 0.25; spec *= 0.2; emi *= 0.35; }
  vec3 c = A.rgb * (amb + key + pl) + spec + emi;
  c += isObj * vec3(1.0, 0.85, 0.6) * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * 0.35;
  if (fog > 0.5) {
    // unreachable: read the map from a flat, desaturated, cool version (independent of the mood's darkness)
    float l = dot(A.rgb * (0.55 + 0.45 * max(N.z, 0.0)) + E.rgb * 0.25, vec3(0.3, 0.59, 0.11));
    vec3 grey = vec3(l) * uFogTint * (1.0 - uFogDark) * 1.6;
    c = mix(c * (1.0 - uFogDark), grey, uFogDesat);
  }
  c += fresh * uFresh * (A.rgb * vec3(1.3, 0.8, 0.35) + vec3(0.35, 0.17, 0.04));
  o = vec4(c * uHdr, 1.0);
}`;

// ---------------------------------------------------------------- particles (additive points)
export const POINT_VS = `#version 300 es
layout(location=0) in vec4 aP;   // x, y (target px), size px, alpha
layout(location=1) in vec3 aC;
uniform vec2 uTarget;
out vec4 vC;
void main() {
  gl_Position = vec4(aP.xy / uTarget * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = aP.z;
  vC = vec4(aC, aP.w);
}`;
export const POINT_FS = HDR + `
in vec4 vC;
uniform float uHdr;
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = length(q);
  if (d > 1.0) discard;
  float core = d < 0.35 ? 1.6 : 0.55 * (1.0 - d);
  o = vec4(vC.rgb * vC.a * core * uHdr, 1.0);
}`;

// ---------------------------------------------------------------- bloom + composite
export const BRIGHT_FS = HDR + `
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform float uThr, uHdr, uExp;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * 4.0 / uSrcSize;
  vec2 px = 1.0 / uSrcSize;
  vec3 c = (texture(uSrc, uv + px * vec2(-1.0, -1.0)).rgb + texture(uSrc, uv + px * vec2(1.0, -1.0)).rgb +
            texture(uSrc, uv + px * vec2(-1.0, 1.0)).rgb + texture(uSrc, uv + px * vec2(1.0, 1.0)).rgb) * 0.25 / uHdr * uExp;
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c * smoothstep(uThr, uThr + 0.35, l), 1.0);
}`;

export const BLUR_FS = HDR + `
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform vec2 uSize;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 d = uDir / uSize;
  vec3 c = texture(uSrc, uv).rgb * 0.227;
  c += (texture(uSrc, uv + d * 1.385).rgb + texture(uSrc, uv - d * 1.385).rgb) * 0.316;
  c += (texture(uSrc, uv + d * 3.231).rgb + texture(uSrc, uv - d * 3.231).rgb) * 0.070;
  o = vec4(c, 1.0);
}`;

export const COMPOSITE_FS = HDR + `
uniform sampler2D uLit, uB1, uB2;
uniform vec2 uOut;
uniform float uHdr, uBloom, uSat, uContrast, uVig, uTime, uMotion, uHaze, uExp;
uniform int uTone;
uniform vec3 uShadowTint, uHighTint, uHazeCol;
out vec4 o;
void main() {
  ivec2 ip = ivec2(int(gl_FragCoord.x), int(uOut.y) - 1 - int(gl_FragCoord.y));
  vec2 uv = (vec2(ip) + 0.5) / uOut;
  vec3 c = texelFetch(uLit, ip, 0).rgb / uHdr * uExp;
  vec3 b = texture(uB1, uv).rgb + texture(uB2, uv).rgb * 0.8;
  c += b * uBloom;
  if (uHaze > 0.0) {
    float n = sin(uv.x * 5.0 + uv.y * 2.0 + uTime * uMotion * 0.05) * sin(uv.y * 4.0 - uTime * uMotion * 0.04 + uv.x * 1.3);
    float shaft = smoothstep(0.2, 1.0, n) * (1.0 - uv.y * 0.6);
    c += uHazeCol * shaft * uHaze;
  }
  if (uTone == 0) {
    // filmic (ACES fit): soft shoulder so bright skies do not clip
    vec3 x = c * 0.9;
    c = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    c = pow(c, vec3(0.92));
  } else if (uTone == 1) c = c / (1.0 + c);
  else if (uTone == 2) c = c / (1.0 + c * 0.22);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSat);
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.42, l)) * 0.09;
  c *= mix(vec3(1.0), uHighTint, smoothstep(0.45, 1.0, l));
  c = (c - 0.5) * uContrast + 0.5;
  vec2 q = uv - 0.5;
  c *= 1.0 - dot(q, q) * uVig;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
