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
  bool face = (flags & 1) != 0;
  bool flip = (flags & 128) != 0;
  ivec2 lq = flip ? ivec2(int(vSize.x) - 1 - lp.x, lp.y) : lp;
  ivec2 st = ivec2(vSrc.xy) + lq;
  if (face && lp.y >= 48) st = ivec2(vSrc.xy) + ivec2(lp.x, 4 + (lp.y - 4) % 44);
  vec4 a = texelFetch(uA, st, 0);
  if (a.a < 0.5) discard;
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
  int mat = int(e.a * 255.0 + 0.5);
  vec3 alb = a.rgb;
  // wall-foot base piece (corner texture): an albedo multiplier whose frame travels in the tint
  if ((flags & 8388608) != 0) alb *= texelFetch(uA, ivec2(vTint.rg) + lp, 0).rgb;
  float rimK = (flags & 512) != 0 ? uOutline.x : (flags & 1024) != 0 ? uOutline.y : (flags & 2048) != 0 ? uOutline.z : 0.0;
  if (rimK > 0.0 && !face && uOccOn == 1) {
    // 1 px silhouette rim: a darker shade of the sprite's own edge colour
    bool rim = false;
    for (int k = 0; k < 4; k++) {
      ivec2 o = k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1);
      ivec2 q = lq + o;
      // only real silhouette edges: a frame border is not an edge (modular building pieces continue there)
      if (q.x >= 0 && q.y >= 0 && q.x < int(vSize.x) && q.y < int(vSize.y) && texelFetch(uA, ivec2(vSrc.xy) + q, 0).a < 0.5) { rim = true; break; }
    }
    if (rim) alb *= vec3(1.0 - rimK, 1.0 - rimK, 1.0 - rimK * 0.85);
  }
  if (mat == 6) { alb *= vTint.rgb; mat = 0; }
  else if ((flags & 32) != 0) alb *= vTint.rgb;
  float h = face ? vInst.x - float(lp.y) / 16.0 : vInst.x + n.a * 255.0 / 40.0 - 1.0;
  vec3 nn = n.rgb * 2.0 - 1.0;
  if (flip) nn.x = -nn.x;
  // ---- autotiled raised edges (terrain tops): rims / coping on exposed edges, rounded or chamfered
  // outer corners, lit inner corners; and contact skirting where higher ground meets this tile
  if (!face && vSrc.z > -1.5 && vSrc.z < -0.5) {
    float cr = vSrc.w;
    bool chamfer = cr >= 15.5;
    if (chamfer) cr -= 16.0;
    float rw = cr > 0.0 ? (chamfer ? 3.0 : 2.0) : 1.0;
    vec2 pc = vec2(lp) + 0.5;
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
    if ((flags & 4096) != 0 && lp.x == 0) { alb = min(alb * 1.3 + 0.03, 1.0); nn = normalize(nn + vec3(-0.9, 0.0, 0.0)); }
    if ((flags & 8192) != 0 && lp.x >= int(vSize.x) - 2) { alb *= lp.x == int(vSize.x) - 1 ? 0.5 : 0.75; nn = normalize(nn + vec3(0.9, 0.0, 0.0)); }
  }
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
  if (t.x >= 0 && t.y >= 0 && t.x < uDim.x && t.y < uDim.y) {
    L = texelFetch(uLift, t, 0).r * 255.0 / 16.0;
    // rounded outer corners (like the drawn tops), so shadows have no square notch
    vec2 f = fract(wt);
    float r = 3.0 / 16.0, me = L * 16.0 / 255.0;
    for (int c = 0; c < 4; c++) {
      int sx = (c == 0 || c == 3) ? -1 : 1, sy = c <= 1 ? -1 : 1;
      vec2 q = vec2(sx < 0 ? f.x : 1.0 - f.x, sy < 0 ? f.y : 1.0 - f.y);
      if (q.x >= r || q.y >= r) continue;
      float a = texelFetch(uLift, clamp(t + ivec2(0, sy), ivec2(0), uDim - 1), 0).r;
      float b = texelFetch(uLift, clamp(t + ivec2(sx, 0), ivec2(0), uDim - 1), 0).r;
      float d = texelFetch(uLift, clamp(t + ivec2(sx, sy), ivec2(0), uDim - 1), 0).r;
      if (a < me && b < me && d < me && length(vec2(r) - q) > r) L = max(a, b) * 255.0 / 16.0;
    }
  }
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
uniform float uFogDark, uFogDesat, uWaterK, uFoamK, uGlintK;
uniform sampler2D uOvA;
uniform float uOvP, uOvTop;
uniform vec2 uOvSize;
uniform int uLSN;          // how many of the first (strongest) lights cast shadows
uniform float uLSK, uLSSoft;
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
  vec2 q = floor(w * 16.0) / 16.0;   // stay on the pixel grid
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
    float H = castH(P.xy + dxy * u);
    occ = max(occ, smoothstep(0.02, 0.05 + uLSSoft * 0.35, H - mix(P.z, Lp.z, u)));
    if (occ >= 0.999) break;
  }
  return occ;
}
float toon(float x) { return smoothstep(0.02, 0.07, x) * 0.36 + smoothstep(0.28, 0.34, x) * 0.34 + smoothstep(0.6, 0.66, x) * 0.30; }
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(gA, fc, 0);
  vec2 dp = (gl_FragCoord.xy - uOff) / uK;
  vec2 sp = uK > 1.0 ? floor(dp) + 0.5 : dp;
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
    vec2 q = floor(P.xy * 16.0) / 16.0;
    float zf = smoothstep(0.35, 0.9, uK);   // fine detail fades out when zoomed out (no moire)
    if (wk == 2) {
      // deep sea: dark readable blue, broad slow swells, rare foam streaks; darker far from land
      float dist = flowC >= 16 ? float(flowC - 16) : 0.0;
      vec3 sn;
      A.rgb = seaAlbedo(P.xy, dist, t, sn);
      N = sn;
      float fo = foamStreak(P.xy, t) * uFoamK * zf * (1.0 - smoothstep(2.0, 10.0, dist) * 0.6);
      A.rgb = mix(A.rgb, vec3(0.62, 0.7, 0.75), fo);
      waterGlint = step(0.78, swell(q, t)) * step(0.985, hash(floor(P.xy * 4.0))) * zf;
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
      waterGlint = step(0.85, sw) * step(0.992, hash(floor(P.xy * 4.0))) * zf;
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
  if (mat == 1) {
    // sparse glints on swell crests, mostly when the sun or moon is low
    float lowK = 1.0 - smoothstep(0.25, 0.75, uKeyDir.z);
    spec += uKeyCol * waterGlint * sh * uGlintK * (0.12 + 0.3 * lowK);
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
    if (mat == 1) spec += uLC[i].rgb * waterGlint * att * 0.6 * pul;
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
