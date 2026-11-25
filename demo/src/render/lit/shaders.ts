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
uniform sampler2D uOcc, uLift;   // terrain tile ids of the screen (copied), per-tile lift in px
uniform int uOccOn;
uniform float uFade;             // detail fade (dithered)
uniform float uDepthOn;
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
  bool face = (flags & 1) != 0;
  bool flip = (flags & 128) != 0;
  ivec2 lq = flip ? ivec2(int(vSize.x) - 1 - lp.x, lp.y) : lp;
  ivec2 st = ivec2(vSrc.xy) + lq;
  if (face && lp.y >= 48) st = ivec2(vSrc.xy) + ivec2(lp.x, 4 + (lp.y - 4) % 44);
  vec4 a = texelFetch(uA, st, 0);
  if (a.a < 0.5) discard;
  if (uFade < 1.0) {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    if ((float(m[(p.y & 3) * 4 + (p.x & 3)]) + 0.5) / 16.0 >= uFade) discard;
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
  int mat = int(e.a * 255.0 + 0.5);
  vec3 alb = a.rgb;
  if (mat == 6) { alb *= vTint.rgb; mat = 0; }
  else if ((flags & 32) != 0) alb *= vTint.rgb;
  float h = face ? vInst.x - float(lp.y) / 16.0 : vInst.x + n.a * 255.0 / 40.0 - 1.0;
  vec3 nn = n.rgb * 2.0 - 1.0;
  if (flip) nn.x = -nn.x;
  // rims on raised edges: lit lip on north / west, dark seam on east
  if ((flags & 2) != 0 && lp.y == 0) alb = min(alb * 1.35 + 0.04, 1.0);
  if ((flags & 4) != 0 && lp.x == 0) { alb = min(alb * 1.2 + 0.02, 1.0); nn = normalize(nn + vec3(-0.8, 0.0, 0.4)); }
  if ((flags & 8) != 0 && lp.x == int(vSize.x) - 1) alb *= 0.55;
  oA = vec4(alb, 1.0);
  oN = vec4(nn * 0.5 + 0.5, clamp((h + 1.0) * 40.0 / 255.0, 0.0, 1.0));
  oE = vec4(e.rgb * vTint.a, float(mat) / 255.0);
  int tx = int(vInst.y + 0.5), ty = int(vInst.z + 0.5);
  oT = vec4(float(tx & 255), float(ty & 255), float((tx >> 8) + (ty >> 8) * 16), 0.0) / 255.0;
  oT.a = (flags & 64) != 0 ? 1.0 : 0.0;
}`;

// ---------------------------------------------------------------- world-space shadow caster height map
// R = props / characters (max height in tiles * 40 / 255), G = terrain lift. Instances use SPRITE_VS
// with dst in ground px (16 per tile), mapped into the caster map.
export const CASTER_FS = HDR + `
uniform sampler2D uTop, uA;
in vec2 vLocal;
flat in vec4 vSrc;
flat in vec4 vInst;
flat in vec4 vTint;
flat in vec2 vSize;
out vec4 o;
void main() {
  int flags = int(vInst.w + 0.5);
  bool flip = (flags & 128) != 0;
  ivec2 lp = clamp(ivec2(floor(vLocal)), ivec2(0), ivec2(vSize) - 1);
  int lx = flip ? int(vSize.x) - 1 - lp.x : lp.x;
  float hh;
  if ((flags & 256) != 0) {
    // flat card: the silhouette column above this base pixel, as a vertical card
    int oy = int(vSrc.z + 0.5), fh = int(vSrc.w + 0.5);
    int r = 0;
    for (; r < 96; r++) { if (r >= oy || texelFetch(uA, ivec2(vSrc.xy) + ivec2(lx, r), 0).a > 0.5) break; }
    if (r >= oy) discard;
    hh = float(oy - r) / 16.0;
  } else {
    float v = texelFetch(uTop, ivec2(vSrc.xy) + ivec2(lx, lp.y), 0).r * 255.0;
    if (v < 0.5) discard;
    hh = (v - 1.0) / 40.0;
  }
  o = vec4(clamp((vInst.x + hh) * 40.0 / 255.0, 0.0, 1.0), 0.0, 0.0, 0.0);
}`;

export const TERRAIN_H_FS = HDR + `
uniform sampler2D uLift;
uniform vec2 uOrigin;   // world tile of caster map pixel (0,0)
uniform float uR;       // caster px per tile
uniform ivec2 uDim;
out vec4 o;
void main() {
  vec2 wt = uOrigin + gl_FragCoord.xy / uR;
  ivec2 t = ivec2(floor(wt));
  float L = 0.0;
  if (t.x >= 0 && t.y >= 0 && t.x < uDim.x && t.y < uDim.y) L = texelFetch(uLift, t, 0).r * 255.0 / 16.0;
  // the tile surface is lifted: in ground (x, y) it occupies its own cell
  o = vec4(0.0, clamp(L * 40.0 / 255.0, 0.0, 1.0), 0.0, 0.0);
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
uniform vec3 uSun;        // direction toward the sun (x east, y south, z up), normalized
uniform float uShadowMode, uShadowStr, uShadowSoft, uTerrainSh, uContact, uAmbK, uSunK, uPointK, uSea;
uniform float uFogDark, uFogDesat, uWaterK;
uniform vec4 uGhost0;   // on, ghost top (dim px), ghost overview px per dim px
uniform vec2 uGhostSize;
out vec4 o;
float dh(vec4 n) { return n.a * 255.0 / 40.0 - 1.0; }
float castH(vec2 q) {
  vec2 uv = (q - uCastO) * uCastR;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= uCastSize.x || uv.y >= uCastSize.y) return -9.0;
  vec4 c = texelFetch(uCast, ivec2(uv), 0);
  return max(c.r, c.g * uTerrainSh) * 255.0 / 40.0;
}
float shadowRay(vec3 P, vec3 S) {
  float lxy = length(S.xy);
  if (lxy < 1e-3) return 0.0;
  vec2 d = S.xy / lxy;
  float tanE = S.z / lxy;
  float maxT = min(9.0, 7.0 / max(tanE, 0.05));
  float stepT = max(1.0 / uCastR, maxT / 40.0);
  for (int i = 1; i <= 40; i++) {
    float t = float(i) * stepT;
    if (t > maxT) break;
    float hz = P.z + t * tanE;
    float H = castH(P.xy + d * t);
    if (H > hz + 0.03) return 1.0;
  }
  return 0.0;
}
float toon(float x) { return smoothstep(0.02, 0.07, x) * 0.36 + smoothstep(0.28, 0.34, x) * 0.34 + smoothstep(0.6, 0.66, x) * 0.30; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(gA, fc, 0);
  vec2 dp = (gl_FragCoord.xy - uOff) / uK;
  vec2 sp = uK > 1.0 ? floor(dp) + 0.5 : dp;
  float X = sp.x / 16.0, Ys = (sp.y - uTop) / 16.0;
  if (A.a < 0.5) {
    vec3 bg = mix(uBg0, uBg1, gl_FragCoord.y / uIS.y);
    if (uSea > 0.0) {
      // open sea continuing past the map edge, lit like deep water
      vec2 q = floor(vec2(dp.x, dp.y - uTop) / 2.0) / 8.0;
      float tt = uTime * uMotion * uWaterK;
      float wv = sin(q.x * 0.9 + q.y * 1.7 + tt * 1.3) * sin(q.y * 1.3 - q.x * 0.6 - tt);
      vec3 sea = vec3(0.03, 0.09, 0.2) * (1.0 + wv * 0.25);
      vec3 lit = sea * (uAmbTop * uAmbK + uKeyCol * uSunK * 0.55 * max(uSun.z, 0.0));
      lit += vec3(0.6, 0.7, 0.8) * step(0.9, wv) * 0.15 * (uAmbK * 0.5 + uSunK * max(uSun.z, 0.0));
      bg = lit;
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
  if (mat == 1) {
    vec2 q = floor(P.xy * 16.0) / 16.0;
    if (wk == 2) {
      // rough deep water: choppy, fast, whitecaps
      N = normalize(N + vec3(sin(q.x * 7.3 + t * 2.1) + sin(q.y * 9.7 - t * 2.6 + q.x * 3.1), cos(q.y * 8.1 + t * 1.9) + sin(q.x * 6.3 - t * 1.7), 0.0) * 0.45);
      float cap = sin(q.x * 5.1 + q.y * 2.3 + t * 1.6) * sin(q.y * 4.3 - q.x * 1.7 - t * 1.2);
      emi += vec3(0.5, 0.58, 0.62) * step(0.86, cap) * 0.5;
    } else if (flowC > 0) {
      // river: streaks drifting downstream
      vec2 fd = flowC == 1 ? vec2(0.0, -1.0) : flowC == 2 ? vec2(1.0, 0.0) : flowC == 3 ? vec2(0.0, 1.0) : vec2(-1.0, 0.0);
      float along = dot(q, fd), across = dot(q, vec2(-fd.y, fd.x));
      float lane = floor(across * 5.0);
      float st = fract(along * 0.9 - t * 0.7 * uMotion + hash(vec2(lane, 1.0)) * 7.0);
      emi += vec3(0.22, 0.32, 0.38) * smoothstep(0.82, 0.97, st) * step(0.35, hash(vec2(lane, 2.0)));
      N = normalize(N + vec3(fd * 0.3 * sin(along * 7.0 - t * 3.0), 0.0));
    } else {
      // calm: gentle swell
      N = normalize(N + vec3(sin(q.x * 3.7 + t * 0.6) + sin(q.y * 4.1 - t * 0.8), cos(q.y * 3.3 + t * 0.7), 0.0) * 0.12);
    }
    if (uRock > 0.0) {
      // underground water: soft caustics glow
      float c = pow(abs(sin(q.x * 3.1 + t * 0.9) * sin(q.y * 2.7 - t * 1.1 + q.x)), 3.0);
      emi += vec3(0.05, 0.22, 0.3) * (0.4 + c);
    }
  } else if (mat == 7) {
    // falling water: bright streaks scrolling down the face, per texel column
    float col = floor(dp.x);
    float r = hash(vec2(col, 3.0));
    float v = fract(dp.y / 16.0 * 1.4 - t * (1.1 + r) + r * 7.0);
    emi += vec3(0.45, 0.6, 0.7) * smoothstep(0.7, 0.95, v) * (uMotion > 0.0 ? 1.0 : 0.4) + vec3(0.04, 0.08, 0.12);
    N = normalize(vec3(0.0, 0.7, 0.7));
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
    vec3 Pg = vec3(floor(P.x * 16.0) / 16.0 + 1.0 / 32.0, floor(P.y * 16.0) / 16.0 + 1.0 / 32.0, P.z + 0.02);
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
  if (shiny) {
    vec3 hv = normalize(uKeyDir + V);
    spec += uKeyCol * step(0.965, dot(N, hv)) * sh * (mat == 1 ? 0.9 : 0.6);
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
    if (mat == 5 || mat == 3) nd = (nd + 0.4) / 1.4;
    float pul = uLC[i].w > 0.0 ? 0.72 + 0.28 * sin(uTime * uMotion * uLC[i].w + L.x * 3.1 + L.y) : 1.0;
    pl += uLC[i].rgb * uPointK * toon(max(nd, 0.0) * att * 1.6) * pul;
    if (shiny) {
      vec3 hv = normalize(l + V);
      spec += uLC[i].rgb * step(0.93, dot(N, hv)) * att * 0.8 * pul;
    }
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
