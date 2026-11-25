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
uniform vec4 uGhost0;   // on, ghost top (dim px), ghost overview px per dim px
uniform vec2 uGhostSize;
out vec4 o;
float dh(vec4 n) { return n.a * 255.0 / 40.0 - 1.0; }
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
  float t = uTime * uMotion;
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
  if (uShadowLen > 0.0) {
    vec2 stp = vec2(uKeyDir.x, uKeyDir.y - uKeyDir.z) * 16.0 * uK;
    for (int i = 1; i <= 12; i++) {
      float tt = float(i) * uShadowLen / 12.0;
      vec2 p = gl_FragCoord.xy + stp * tt;
      if (p.x < 0.0 || p.y < 0.0 || p.x >= uIS.x || p.y >= uIS.y) break;
      ivec2 ip = ivec2(p);
      if (texelFetch(gA, ip, 0).a < 0.5) continue;
      if (dh(texelFetch(gN, ip, 0)) > h + uKeyDir.z * tt + 0.05) { sh = 0.0; break; }
    }
  }
  // contact occlusion from nearby higher pixels
  float occ = 0.0;
  float r1 = 5.0 * uK;
  occ += clamp(dh(texelFetch(gN, clamp(fc + ivec2(-int(r1), 0), ivec2(0), ivec2(uIS) - 1), 0)) - h, 0.0, 0.6);
  occ += clamp(dh(texelFetch(gN, clamp(fc + ivec2(int(r1), 0), ivec2(0), ivec2(uIS) - 1), 0)) - h, 0.0, 0.6);
  occ += clamp(dh(texelFetch(gN, clamp(fc + ivec2(0, -int(r1)), ivec2(0), ivec2(uIS) - 1), 0)) - h, 0.0, 0.6);
  occ += clamp(dh(texelFetch(gN, clamp(fc + ivec2(0, -int(r1 * 2.0)), ivec2(0), ivec2(uIS) - 1), 0)) - h, 0.0, 0.6);
  if (N.z < 0.5) occ *= 0.25; // walls facing the camera: only contact shadow from what is in front
  float ao = 1.0 - min(occ * 0.55, 0.6);
  vec3 amb = mix(uAmbBot, uAmbTop, N.z * 0.5 + 0.5) * ao;
  // dynamic objects (chests, doors, NPCs, gates) get a lift + rim so they stay easy to spot
  float isObj = Tt.a;
  amb += vec3(0.3, 0.28, 0.34) * isObj;
  vec3 key = uKeyCol * toon(max(nl, 0.0)) * sh;
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
    pl += uLC[i].rgb * toon(max(nd, 0.0) * att * 1.6) * pul;
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
    c = mix(c * 0.45, vec3(l) * uFogTint, 0.8);
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
uniform float uThr, uHdr;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * 4.0 / uSrcSize;
  vec2 px = 1.0 / uSrcSize;
  vec3 c = (texture(uSrc, uv + px * vec2(-1.0, -1.0)).rgb + texture(uSrc, uv + px * vec2(1.0, -1.0)).rgb +
            texture(uSrc, uv + px * vec2(-1.0, 1.0)).rgb + texture(uSrc, uv + px * vec2(1.0, 1.0)).rgb) * 0.25 / uHdr;
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
uniform float uHdr, uBloom, uSat, uContrast, uVig, uTime, uMotion, uHaze;
uniform vec3 uShadowTint, uHighTint, uHazeCol;
out vec4 o;
void main() {
  ivec2 ip = ivec2(int(gl_FragCoord.x), int(uOut.y) - 1 - int(gl_FragCoord.y));
  vec2 uv = (vec2(ip) + 0.5) / uOut;
  vec3 c = texelFetch(uLit, ip, 0).rgb / uHdr;
  vec3 b = texture(uB1, uv).rgb + texture(uB2, uv).rgb * 0.8;
  c += b * uBloom;
  if (uHaze > 0.0) {
    float n = sin(uv.x * 5.0 + uv.y * 2.0 + uTime * uMotion * 0.05) * sin(uv.y * 4.0 - uTime * uMotion * 0.04 + uv.x * 1.3);
    float shaft = smoothstep(0.2, 1.0, n) * (1.0 - uv.y * 0.6);
    c += uHazeCol * shaft * uHaze;
  }
  c = c / (1.0 + c * 0.22);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSat);
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.42, l)) * 0.09;
  c *= mix(vec3(1.0), uHighTint, smoothstep(0.45, 1.0, l));
  c = (c - 0.5) * uContrast + 0.5;
  vec2 q = uv - 0.5;
  c *= 1.0 - dot(q, q) * uVig;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
