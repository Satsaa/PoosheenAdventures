// Graph tab: the logic at region level as a node-link diagram (inline SVG).
// Layout uses the real map anchors; worlds are stacked as bands (sky / overworld / underworld),
// which works because stacked worlds share tile coordinates.
import type { Dimension, Edge, HNode, LocId } from '../core/types';
import { fmtReq, reqItems, TIME_ITEM } from '../core/req';
import { h, s, focusLocOf, reqOk, selLoc, reqStatus, reqPhases, PHASE_GLYPH, enemySummary, type Selection } from './shared';
import type { TabCtx, TabView } from './tab';

const W = 360;
const MX = 24;
const NODE_R = 10;
const SAT_R = 7;
const Y_STRETCH = 1.6; // panels are tall and narrow: spread the map vertically
const FS = 10; // region label size (viewBox units)
const EFS = 9; // edge label size

const PLACE_GLYPH: Record<string, string> = {
  dungeon: '♜', cave: '◒', alcove: '◆', sanctum: '★', shop: '$', npc: '☺', grove: '♣', house: '⌂', shrine: '✚',
};
const PLACE_NAME: Record<string, string> = {
  dungeon: 'dungeon', cave: 'cave', alcove: 'alcove', sanctum: 'sanctum', shop: 'shop', npc: 'NPC spot', grove: 'clearing', house: 'house', shrine: 'shrine',
};
const BAND_ORDER: Record<string, number> = { sky: 0, overworld: 1, underworld: 2, interior: 3 };

interface Rect { x: number; y: number; w: number; h: number }
interface Sat { place: HNode; x: number; y: number; glyph: string; entry?: Edge }
interface RNode { region: HNode; loc: LocId; x: number; y: number; r: number; color: string; sats: Sat[]; band: Band }
interface Band { world: HNode; dim: Dimension; top: number; h: number }
interface Layout { bands: Band[]; nodes: Map<string, RNode>; height: number; regionEdges: Edge[] }

let uid = 0;
type Status = 'open' | 'wait' | 'locked';
const STATUS_CLASS: Record<Status, string> = { open: 'is-on', wait: 'is-wait', locked: 'is-off' };
interface EdgeRec { e: Edge; path: SVGPathElement; reach: boolean; label: SVGGElement | null; timed: boolean }

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

function pick(cands: Rect[], obstacles: Rect[]): Rect {
  let best = cands[0];
  let bestScore = Infinity;
  for (const c of cands) {
    let sc = 0;
    for (const o of obstacles) sc += overlap(c, o);
    if (sc === 0) return c;
    if (sc < bestScore) { bestScore = sc; best = c; }
  }
  return best;
}

export function createGraphTab(): TabView {
  const el = h('div', { class: 'pa-graph' });
  const id = 'pa' + uid++;
  let layout: Layout | null = null;
  let layoutFor: unknown = null;
  let edgeRecs: EdgeRec[] = [];
  let measure: CanvasRenderingContext2D | null = null;
  let family = 'system-ui, sans-serif';

  const textW = (t: string, fs: number, weight = 500): number => {
    try {
      measure ??= document.createElement('canvas').getContext('2d');
    } catch { measure = null; }
    if (measure) {
      measure.font = `${weight} ${fs}px ${family}`;
      return measure.measureText(t).width;
    }
    return t.length * fs * 0.56;
  };

  function computeLayout(ctx: TabCtx): Layout {
    const { world, ix } = ctx;
    const worlds = world.tree.children.filter((c) => c.kind === 'world');
    const dimOf = (w: HNode) => world.dims.find((d) => d.id === (w.meta.dim ?? w.id));
    const sorted = worlds
      .map((w) => ({ w, d: dimOf(w) }))
      .filter((x): x is { w: HNode; d: Dimension } => !!x.d)
      .sort((a, b) => (BAND_ORDER[a.d.kind] ?? 9) - (BAND_ORDER[b.d.kind] ?? 9));
    const bands: Band[] = [];
    const nodes = new Map<string, RNode>();
    let y = 0;
    for (const { w, d } of sorted) {
      const regions = w.children.filter((c) => c.kind === 'region');
      if (!regions.length) continue;
      const scale = (W - 2 * MX) / d.w;
      const anchors = regions.map((r) => {
        const ri = d.regions.find((q) => q.id === r.id);
        const l = ix.loc.get(r.locs[0]);
        return { r, x: ri?.x ?? l?.x ?? 0, y: ri?.y ?? l?.y ?? 0, color: ri?.color ?? 'currentColor' };
      });
      const minY = Math.min(...anchors.map((a) => a.y));
      const maxY = Math.max(...anchors.map((a) => a.y));
      // panels are tall and narrow: give each band a height that grows with its region count
      const span = Math.max(1, (maxY - minY) * scale);
      const stretch = Math.max(1.2, Math.min(3, (60 + regions.length * 26) / span, Y_STRETCH * 1.6));
      const head = 18;
      const padTop = 26; // satellites sit above nodes
      const padBot = 26; // labels sit below nodes
      const band: Band = { world: w, dim: d, top: y, h: head + padTop + (maxY - minY) * scale * stretch + padBot };
      bands.push(band);
      for (const a of anchors) {
        const nx = MX + a.x * scale;
        const ny = y + head + padTop + (a.y - minY) * scale * stretch;
        const places = a.r.children.filter((c) => c.kind === 'place');
        const angles = [-90, -45, -135, -15, -165, 20, 160, 55, 125];
        const sats: Sat[] = places.map((p, i) => {
          const ring = NODE_R + 10 + Math.floor(i / angles.length) * 15;
          const ang = (angles[i % angles.length] * Math.PI) / 180;
          const sub = new Set(ix.subLocs.get(p.id) ?? []);
          const entry = world.graph.edges.find((e) => sub.has(e.b) && !sub.has(e.a)) ?? world.graph.edges.find((e) => sub.has(e.a) && !sub.has(e.b));
          return { place: p, x: nx + Math.cos(ang) * ring, y: ny + Math.sin(ang) * ring, glyph: PLACE_GLYPH[p.meta.placeKind ?? ''] ?? '•', entry };
        });
        nodes.set(a.r.id, { region: a.r, loc: a.r.locs[0] ?? focusLocOf(ix, a.r) ?? '', x: nx, y: ny, r: a.r.meta.biome === 'river' ? 7 : NODE_R, color: a.color, sats, band });
      }
      y += band.h + 10;
    }
    const regionEdges = world.graph.edges.filter((e) => {
      const na = ix.locNode.get(e.a);
      const nb = ix.locNode.get(e.b);
      return na && nb && na !== nb && na.kind === 'region' && nb.kind === 'region' && nodes.has(na.id) && nodes.has(nb.id);
    });
    return { bands, nodes, height: Math.max(40, y - 10), regionEdges };
  }

  function render(ctx: TabCtx): void {
    const { world, state, ix, cb } = ctx;
    try { family = getComputedStyle(el).fontFamily || family; } catch { /* detached */ }
    if (layoutFor !== world) { layout = computeLayout(ctx); layoutFor = world; }
    const L = layout!;
    el.replaceChildren();
    const svg = s('svg', { class: 'pa-g', viewBox: `0 0 ${W} ${L.height}`, role: 'group', 'aria-label': 'Region logic graph' });
    const defs = s('defs');
    for (const v of ['on', 'off']) {
      defs.append(s('marker', { id: `${id}-arr-${v}`, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' },
        s('path', { d: 'M0,1 L10,5 L0,9 z', class: `pa-g-arrow is-${v}` })));
    }
    svg.append(defs);

    const obstacles: Rect[] = [];
    const reachable = (r: RNode) => state.reachable.has(r.loc);
    const fresh = (r: RNode) => state.fresh.has(r.loc);

    // bands
    for (const b of L.bands) {
      svg.append(
        s('rect', { class: `pa-g-band is-${b.dim.kind}`, x: 2, y: b.top, width: W - 4, height: b.h, rx: 8 }),
        s('text', { class: 'pa-g-bandt', x: 12, y: b.top + 13 }, b.world.name.toUpperCase()),
      );
      obstacles.push({ x: 8, y: b.top + 2, w: textW(b.world.name.toUpperCase(), 9, 600) * 1.15 + 8, h: 14 });
    }
    for (const n of L.nodes.values()) {
      obstacles.push({ x: n.x - n.r - 2, y: n.y - n.r - 2, w: 2 * n.r + 4, h: 2 * n.r + 4 });
      for (const st of n.sats) obstacles.push({ x: st.x - SAT_R - 1, y: st.y - SAT_R - 1, w: 2 * SAT_R + 2, h: 2 * SAT_R + 2 });
    }

    // edges: group parallels so they can bow apart
    const edgeLayer = s('g', { class: 'pa-g-edges' });
    const labelLayer = s('g', { class: 'pa-g-elabels' });
    const pairKey = (e: Edge) => {
      const a = ix.locNode.get(e.a)!.id, b = ix.locNode.get(e.b)!.id;
      return a < b ? a + '|' + b : b + '|' + a;
    };
    const groups = new Map<string, Edge[]>();
    for (const e of L.regionEdges) {
      const k = pairKey(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(e);
    }
    const pendingLabels: { e: Edge; pt: (t: number) => [number, number]; nx: number; ny: number; st: Status; text: string; glyph?: { g: string; c: string }; phase?: string }[] = [];
    edgeRecs = [];

    for (const group of groups.values()) {
      group.forEach((e, gi) => {
        const A = L.nodes.get(ix.locNode.get(e.a)!.id)!;
        const B = L.nodes.get(ix.locNode.get(e.b)!.id)!;
        const cross = A.band !== B.band;
        const reach = reachable(A) || reachable(B);
        const st: Status = reach ? reqStatus(world, state, e.req) : 'locked';
        const dx = B.x - A.x, dy = B.y - A.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        // perpendicular, oriented consistently for the pair so parallels separate
        const flip = A.region.id < B.region.id ? 1 : -1;
        const nx = -uy * flip, ny = ux * flip;
        const bow = (gi - (group.length - 1) / 2) * 22 + (cross ? 18 : 0);
        const sa = A.r + 1, sb = B.r + (e.oneWay ? 3 : 1);
        const x1 = A.x + ux * sa, y1 = A.y + uy * sa;
        const x2 = B.x - ux * sb, y2 = B.y - uy * sb;
        const cx = (x1 + x2) / 2 + nx * bow, cy = (y1 + y2) / 2 + ny * bow;
        const pt = (t: number): [number, number] => [
          (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2,
          (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2,
        ];
        const portal = e.gate === 'portal' || cross;
        const path = s('path', {
          d: `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`,
          class: `pa-g-edge ${STATUS_CLASS[st]}${portal ? ' is-portal' : ''}`,
          'marker-end': e.oneWay ? `url(#${id}-arr-${st === 'locked' ? 'off' : 'on'})` : null,
        });
        const label = e.req.t === 'none' ? (e.gate === 'ledge' ? 'ledge' : '') : fmtReq(e.req, world.items);
        const title = `${ix.loc.get(e.a)?.name} ${e.oneWay ? '→' : '↔'} ${ix.loc.get(e.b)?.name}: ${e.gate}${e.req.t !== 'none' ? ', needs ' + fmtReq(e.req, world.items) : ''}${e.oneWay ? ' (one-way)' : ''}`;
        const hit = s('path', { d: path.getAttribute('d')!, class: 'pa-g-hit' });
        const eg = s('g', { class: 'pa-g-e', 'data-edge': e.id }, s('title', null, title), hit, path);
        edgeLayer.append(eg);
        const phases = [...reqPhases(e.req)];
        edgeRecs.push({ e, path, reach, label: null, timed: phases.length > 0 });
        if (label) {
          const first = [...reqItems(e.req)].filter((x) => !(phases.length && x === TIME_ITEM))[0];
          const def = first ? world.items[first] : undefined;
          pendingLabels.push({ e, pt, nx, ny, st, text: label, glyph: def ? { g: def.icon, c: def.color } : undefined, phase: phases.map((p) => PHASE_GLYPH[p]).join('') || undefined });
        }
      });
    }
    svg.append(edgeLayer);

    // region nodes + satellites
    const nodeLayer = s('g', { class: 'pa-g-nodes' });
    const satLines = s('g', { class: 'pa-g-satlines' });
    for (const n of L.nodes.values()) for (const st of n.sats) satLines.append(s('line', { class: 'pa-g-satline', x1: n.x, y1: n.y, x2: st.x, y2: st.y }));
    const regionLabels: { n: RNode; text: string }[] = [];
    for (const n of L.nodes.values()) {
      const on = reachable(n);
      const isStart = n.loc === world.graph.start;
      const g = s('g', {
        class: `pa-g-node${on ? '' : ' is-dim'}${fresh(n) ? ' is-fresh' : ''}`,
        'data-region': n.region.id, tabindex: '0', role: 'button',
        'aria-label': `${n.region.name}${on ? '' : ' (not reachable yet)'}: show on map`,
      },
      s('title', null, `${n.region.name}${(ix.nodeEnemies.get(n.region.id)?.length ?? 0) ? `\nenemies: ${enemySummary(ix.nodeEnemies.get(n.region.id)!).text}` : ''}${n.region.needs.t !== 'none' ? '\nentry: ' + fmtReq(n.region.needs, world.items) : ''}\n${on ? 'reachable' : 'not reachable yet'}`),
      s('circle', { class: 'pa-g-selring', cx: n.x, cy: n.y, r: n.r + 7 }),
      s('circle', { class: 'pa-g-fresh', cx: n.x, cy: n.y, r: n.r + 4 }),
      s('circle', { class: `pa-g-dot${n.region.meta.biome === 'river' ? ' is-river' : ''}`, cx: n.x, cy: n.y, r: n.r, style: { fill: n.color } }),
      isStart ? s('circle', { class: 'pa-g-start', cx: n.x, cy: n.y, r: 3 }) : null);
      const foes = ix.nodeEnemies.get(n.region.id) ?? [];
      if (foes.length) {
        const pr = Math.min(4.5, 1.6 + Math.sqrt(foes.length) * 0.7);
        g.append(s('circle', { class: 'pa-g-threat', cx: n.x + n.r * 0.75, cy: n.y + n.r * 0.75, r: pr },
          s('title', null, `${foes.length} enem${foes.length === 1 ? 'y' : 'ies'}: ${enemySummary(foes).text}`)));
      }
      const go = () => cb.focusLoc(n.loc);
      g.addEventListener('click', go);
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      nodeLayer.append(g);
      regionLabels.push({ n, text: (isStart ? '⌂ ' : '') + n.region.name });

      for (const st of n.sats) {
        const sub = ix.subLocs.get(st.place.id) ?? [];
        const sOn = sub.length ? sub.some((l) => state.reachable.has(l)) : on && reqOk(world, state, st.place.needs);
        const sFresh = sub.some((l) => state.fresh.has(l));
        const need = st.entry && st.entry.req.t !== 'none' ? st.entry.req : st.place.needs;
        const kindName = PLACE_NAME[st.place.meta.placeKind ?? ''] ?? st.place.meta.placeKind ?? 'place';
        const sg = s('g', {
          class: `pa-g-sat${sOn ? '' : ' is-dim'}${sFresh ? ' is-fresh' : ''}`, 'data-place': st.place.id, tabindex: '0', role: 'button',
          'aria-label': `${st.place.name} (${kindName})${sOn ? '' : ', not reachable yet'}: show on map`,
        },
        s('title', null, `${st.place.name} (${kindName})${need.t !== 'none' ? '\nneeds ' + fmtReq(need, world.items) : ''}\n${sOn ? 'reachable' : 'not reachable yet'}`),
        s('circle', { class: 'pa-g-selring', cx: st.x, cy: st.y, r: SAT_R + 4 }),
        s('circle', { class: 'pa-g-satdot', cx: st.x, cy: st.y, r: SAT_R }),
        s('text', { class: 'pa-g-satg', x: st.x, y: st.y + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, st.glyph));
        const goS = () => { const l = focusLocOf(ix, st.place); if (l) cb.focusLoc(l); };
        sg.addEventListener('click', (ev) => { ev.stopPropagation(); goS(); });
        sg.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); goS(); } });
        nodeLayer.append(sg);
      }
    }

    // labels: regions first (fixed priority), then gates, each nudged off what is already placed
    const lblLayer = s('g', { class: 'pa-g-rlabels' });
    for (const { n, text } of regionLabels) {
      const w = textW(text, FS, 600) + 2;
      const hgt = FS + 2;
      const clampX = (x: number) => Math.max(4, Math.min(W - 4 - w, x));
      const cands: Rect[] = [
        { x: clampX(n.x - w / 2), y: n.y + n.r + 3, w, h: hgt },
        { x: clampX(n.x + n.r + 4), y: n.y - hgt / 2, w, h: hgt },
        { x: clampX(n.x - n.r - 4 - w), y: n.y - hgt / 2, w, h: hgt },
        { x: clampX(n.x - w / 2), y: n.y + n.r + 3 + hgt, w, h: hgt },
        { x: clampX(n.x - w / 2), y: n.y - n.r - 22 - hgt, w, h: hgt },
        { x: clampX(n.x + n.r + 4), y: n.y + 4, w, h: hgt },
        { x: clampX(n.x - n.r - 4 - w), y: n.y + 4, w, h: hgt },
      ];
      const r = pick(cands, obstacles);
      obstacles.push(r);
      lblLayer.append(s('text', {
        class: `pa-g-rlabel${state.reachable.has(n.loc) ? '' : ' is-dim'}`, 'data-region-label': n.region.id,
        x: r.x + r.w / 2, y: r.y + hgt / 2 + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      }, text));
    }
    const score = (r: Rect) => obstacles.reduce((a, o) => a + overlap(r, o), 0);
    for (const pl of pendingLabels) {
      const gw = pl.glyph ? textW(pl.glyph.g, EFS) + 3 : 0;
      const pw = pl.phase ? textW(pl.phase, EFS) + 4 : 0;
      const hgt = EFS + 5;
      const candsFor = (w: number): Rect[] => {
        const cands: Rect[] = [];
        for (const t of [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75]) {
          const [x, y] = pl.pt(t);
          cands.push({ x: x - w / 2, y: y - hgt / 2, w, h: hgt });
        }
        for (const off of [9, -9, 16, -16]) {
          const [x, y] = pl.pt(0.5);
          cands.push({ x: x - w / 2 + pl.nx * off, y: y - hgt / 2 + pl.ny * off, w, h: hgt });
        }
        for (const c of cands) c.x = Math.max(3, Math.min(W - 3 - w, c.x));
        return cands;
      };
      const wFull = gw + textW(pl.text, EFS) + pw + 10;
      let r = pick(candsFor(wFull), obstacles);
      // crowded: fall back to a glyph-only pill (full text stays in the tooltip)
      let compact = false;
      if (score(r) > 0 && (pl.glyph || pl.phase)) {
        const wC = (pl.glyph ? textW(pl.glyph.g, EFS) : 0) + (pl.phase ? textW(pl.phase, EFS) + (pl.glyph ? 3 : 0) : 0) + 10;
        const rc = pick(candsFor(wC), obstacles);
        if (score(rc) < score(r)) { r = rc; compact = true; }
      }
      obstacles.push(r);
      const g = s('g', { class: `pa-g-elabel ${STATUS_CLASS[pl.st]}${compact ? ' is-compact' : ''}`, 'data-edge-label': pl.e.id },
        s('title', null, pl.text),
        s('rect', { x: r.x, y: r.y, width: r.w, height: hgt, rx: hgt / 2 }));
      const t = s('text', { x: r.x + 5, y: r.y + hgt / 2 + 0.5, 'dominant-baseline': 'central' });
      if (pl.glyph) t.append(s('tspan', { class: 'pa-g-eglyph', style: { fill: pl.glyph.c } }, pl.glyph.g + (compact ? '' : ' ')));
      if (!compact) t.append(s('tspan', null, pl.text));
      if (pl.phase) t.append(s('tspan', { class: 'pa-g-ephase' }, (compact && !pl.glyph ? '' : ' ') + pl.phase));
      g.append(t);
      const rec = edgeRecs.find((x) => x.e === pl.e);
      if (rec) rec.label = g;
      labelLayer.append(g);
    }
    svg.append(satLines, labelLayer, nodeLayer, lblLayer);

    const legend = h('div', { class: 'pa-legend', 'aria-label': 'Legend' },
      h('span', { class: 'pa-lg' }, h('i', { class: 'pa-lg-line is-on' }), 'open now'),
      h('span', { class: 'pa-lg' }, h('i', { class: 'pa-lg-line is-wait' }), 'waiting for ☀ day / ☾ night'),
      h('span', { class: 'pa-lg' }, h('i', { class: 'pa-lg-line is-off' }), 'locked'),
      h('span', { class: 'pa-lg' }, h('i', { class: 'pa-lg-line is-portal' }), 'stairs / beanstalk'),
      h('span', { class: 'pa-lg' }, h('i', { class: 'pa-lg-ring' }), 'new this sphere'),
      h('span', { class: 'pa-lg' }, h('i', { class: 'pa-lg-dot is-dim' }), 'not reachable yet'),
      ix.enemies.length ? h('span', { class: 'pa-lg' }, h('i', { class: 'pa-lg-threat' }), 'enemies') : null,
      ...usedPlaceKinds(L).map((k) => h('span', { class: 'pa-lg' }, h('b', { class: 'pa-lg-sat' }, PLACE_GLYPH[k] ?? '•'), PLACE_NAME[k] ?? k)));

    const counts = h('p', { class: 'pa-note' },
      `${L.nodes.size} regions, ${L.regionEdges.length} region links. `,
      'Satellites are the places inside a region. Click anything to find it on the map.');
    el.append(h('div', { class: 'pa-g-wrap' }, svg), legend, counts);
  }

  function usedPlaceKinds(L: Layout): string[] {
    const set = new Set<string>();
    for (const n of L.nodes.values()) for (const st of n.sats) set.add(st.place.meta.placeKind ?? '');
    return Object.keys(PLACE_GLYPH).filter((k) => set.has(k));
  }

  function match(sel: Selection, ctx: TabCtx): Element[] {
    if (!sel || !layout) return [];
    const { ix } = ctx;
    const out: Element[] = [];
    const q = (a: string, v: string) => el.querySelectorAll(`[${a}="${CSS.escape(v)}"]`);
    if (sel.edgeId) {
      const e = ix.edge.get(sel.edgeId);
      if (e && layout.regionEdges.includes(e)) out.push(...q('data-edge', e.id), ...q('data-edge-label', e.id));
    }
    const loc = selLoc(ctx.world, ix, ctx.state, sel);
    if (loc) {
      // innermost place under a region, else the region itself
      let n = ix.locNode.get(loc);
      let place: HNode | undefined;
      while (n && n.kind !== 'region') { if (n.kind === 'place') place = n; n = ix.parent.get(n.id); }
      if (place) out.push(...q('data-place', place.id));
      if (n) out.push(...q('data-region', n.id));
    }
    return out;
  }

  /** time of day changed: restyle time-gated edges only, no rebuild */
  function onTime(ctx: TabCtx): void {
    for (const r of edgeRecs) {
      if (!r.timed) continue;
      const st: Status = r.reach ? reqStatus(ctx.world, ctx.state, r.e.req) : 'locked';
      const cls = STATUS_CLASS[st];
      for (const c of ['is-on', 'is-wait', 'is-off']) { r.path.classList.toggle(c, c === cls); r.label?.classList.toggle(c, c === cls); }
      if (r.e.oneWay) r.path.setAttribute('marker-end', `url(#${id}-arr-${st === 'locked' ? 'off' : 'on'})`);
    }
  }

  return { el, render, match, onTime };
}
