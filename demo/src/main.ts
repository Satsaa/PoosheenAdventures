// Page wiring: seed bar, map stage, sphere scrubber, info card, side panels.
import type { DimId, LocId, MapObject, World } from './core/types';
import { fmtReq } from './core/req';
import { stateAt, type WorldState } from './core/view';
import { normalizeSettings, type GenSettings } from './core/settings';
import { generateWorld } from './gen/index';
import { createMapView } from './render/mapView';
import { createPanels } from './ui/panels';

const $ = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let world: World;
let state: WorldState;
let dimId: DimId = 'over';
let fog = true;
let timer = 0;

// settings are a per-viewer convenience: remembered in this browser only
const STORE = 'poosheen-worldgen-settings';
function loadSettings(): GenSettings {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(STORE) ?? 'null')); } catch { return normalizeSettings(null); }
}
let settings = loadSettings();

const canvas = $<HTMLCanvasElement>('map');
const info = $('info');
const sphere = $<HTMLInputElement>('sphere');

const map = createMapView(canvas, {
  onPick: (obj) => (obj ? showInfo(obj) : hideInfo()),
});
const panels = createPanels($('panels'), {
  focusLoc,
  setSphere: (k) => setSphere(k),
  runBatch: async (n, onProgress) => {
    let bad = 0, first = 0;
    for (let i = 0; i < n; i++) {
      const w = generateWorld(`batch-${world.seed}-${i}`, settings);
      if (!w.ok) bad++;
      else if (w.stats.attempts === 1) first++;
      if (i % 4 === 3 || i === n - 1) {
        onProgress(i + 1, bad, first);
        await new Promise((r) => setTimeout(r));
      }
    }
  },
  changeSettings: (next) => {
    settings = normalizeSettings(next);
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* not remembered, still applied */ }
    generate(world.seed, true);
  },
});

// ------------------------------------------------------------------ world & dimension
/** keepView: a settings tweak, so stay on the same layer, sphere and camera where possible */
function generate(seed: string, keepView = false): void {
  stop();
  const prevSphere = keepView && state ? state.sphere : -1;
  world = generateWorld(seed, settings);
  settings = world.settings;
  if (!keepView || !world.dims.some((d) => d.id === dimId)) dimId = 'over';
  map.setWorld(world);
  panels.setWorld(world);
  sphere.max = String(world.solution.spheres.length - 1);
  const bad = world.lints.filter((l) => !l.ok).length;
  const status = $('status');
  status.textContent = bad ? `${bad} check${bad > 1 ? 's' : ''} failed` : `valid · ${world.stats.ms} ms · attempt ${world.stats.attempts}`;
  status.className = 'pill ' + (bad ? 'bad' : 'ok');
  buildDimTabs();
  showDim(dimId);
  setSphere(Math.min(prevSphere >= 0 ? prevSphere : 2, world.solution.spheres.length - 1));
  hideInfo();
  try { history.replaceState(null, '', '#' + seed); } catch { /* hash is a convenience only */ }
}

function buildDimTabs(): void {
  const tabs = $('dimTabs');
  tabs.textContent = '';
  for (const d of world.dims.filter((x) => x.kind !== 'interior').sort((a, b) => (b.stack ?? 0) - (a.stack ?? 0))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.dataset.dim = d.id;
    b.textContent = d.name;
    b.addEventListener('click', () => showDim(d.id));
    tabs.append(b);
  }
}

function showDim(id: DimId, at?: { x: number; y: number }): void {
  const dim = world.dims.find((d) => d.id === id);
  if (!dim) return;
  dimId = id;
  map.setDimension(id);
  if (at) map.focus(at.x, at.y, dim.kind === 'interior' ? undefined : 26);
  for (const b of $('dimTabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.dim === id));
  const back = $<HTMLButtonElement>('btnBack');
  back.hidden = dim.kind !== 'interior';
  back.textContent = `← Leave ${dim.name}`;
}

function focusLoc(loc: LocId): void {
  const l = world.graph.locs.find((x) => x.id === loc);
  if (!l) return;
  showDim(l.dim, { x: l.x, y: l.y });
}

// ------------------------------------------------------------------ playthrough scrubber
function setSphere(k: number): void {
  state = stateAt(world, k);
  sphere.value = String(state.sphere);
  $('sphereLabel').textContent = `Sphere ${state.sphere} of ${world.solution.spheres.length - 1}`;
  const names = state.gained.map((it) => `<b style="color:${esc(world.items[it]?.color ?? '')}">${esc(world.items[it]?.icon ?? '')}</b> ${esc(world.items[it]?.name ?? it)}`);
  $('gained').innerHTML = names.length ? 'Found: ' + names.join(', ') : 'Nothing new to pick up';
  pushState();
  panels.setState(state);
}

function pushState(): void {
  map.setState({ reachable: fog ? state.reachable : null, fresh: state.fresh, hidden: state.hidden, done: state.done });
}

function stop(): void {
  clearInterval(timer);
  timer = 0;
  $('btnPlay').textContent = '▶';
}

$('btnPlay').addEventListener('click', () => {
  if (timer) return stop();
  if (state.sphere >= world.solution.spheres.length - 1) setSphere(0);
  $('btnPlay').textContent = '❚❚';
  timer = window.setInterval(() => {
    if (state.sphere >= world.solution.spheres.length - 1) return stop();
    setSphere(state.sphere + 1);
  }, 1500);
});
sphere.addEventListener('input', () => { stop(); setSphere(Number(sphere.value)); });

// ------------------------------------------------------------------ info card
function showInfo(o: MapObject): void {
  const rows: [string, string][] = [];
  const g = world.graph;
  const locName = (id: LocId) => esc(g.locs.find((l) => l.id === id)?.name ?? id);
  const edge = o.edgeId ? g.edges.find((e) => e.id === o.edgeId) : undefined;
  const check = o.checkId ? g.checks.find((c) => c.id === o.checkId) : undefined;
  const source = o.sourceId ? g.sources.find((s) => s.id === o.sourceId) : undefined;
  const npc = o.npcId ? world.npcs.find((n) => n.id === o.npcId) : undefined;
  const req = edge?.req ?? check?.req ?? source?.req ?? o.req;
  if (edge) {
    rows.push(['Joins', `${locName(edge.a)} ${edge.oneWay ? '→' : '↔'} ${locName(edge.b)}`]);
    if (edge.lock) rows.push(['Needs', 'one small key of this dungeon']);
    rows.push(['Reachable', `sphere ${Math.max(world.solution.locSphere[edge.a] ?? 0, world.solution.locSphere[edge.b] ?? 0)}`]);
  }
  if (req && req.t !== 'none') rows.push(['Needs', esc(fmtReq(req, world.items))]);
  if (check) {
    const it = world.items[check.item];
    rows.push(['Gives', `<b style="color:${esc(it.color)}">${esc(it.icon)}</b> ${esc(it.name)}`]);
    rows.push(['Collected', `sphere ${world.solution.checkSphere[check.id] ?? '—'}`]);
  }
  if (source) rows.push(['Refills', esc(world.items[source.gives].name) + ' (renewable)']);
  let quote = '';
  if (npc) {
    const st = npc.stages[o.stage ?? 0];
    rows.push(['Role', esc(npc.role)]);
    rows.push(['Stage', `${(o.stage ?? 0) + 1} of ${npc.stages.length}${st.when.t === 'none' ? '' : ', once you have ' + esc(fmtReq(st.when, world.items))}`]);
    quote = `<p><q>${esc(st.line)}</q></p>`;
  }
  info.innerHTML = `<button type="button" class="btn small close" aria-label="Close">×</button><h3>${esc(o.label)}</h3>${quote}` +
    `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` +
    (o.to ? `<button type="button" class="btn small primary go">Go through</button>` : '');
  info.hidden = false;
  info.querySelector('.close')!.addEventListener('click', hideInfo);
  info.querySelector('.go')?.addEventListener('click', () => { hideInfo(); showDim(o.to!.dim, o.to); });
  const loc = world.dims.find((d) => d.id === dimId);
  const zone = loc ? loc.zoneLoc[loc.zone[o.y * loc.w + o.x]] : undefined;
  panels.select({ loc: zone, checkId: o.checkId, edgeId: o.edgeId, npcId: o.npcId }, false);
}

function hideInfo(): void {
  info.hidden = true;
  panels.select(null);
}

// ------------------------------------------------------------------ controls
$('btnBack').addEventListener('click', () => {
  const p = world.dims.find((d) => d.id === dimId)?.parent;
  if (p) showDim(p.dim, p);
});
$('btnFit').addEventListener('click', () => map.fitAll());
$('btnGhost').addEventListener('click', (e) => {
  const b = e.currentTarget as HTMLElement;
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on));
  map.setGhost(on);
});
// the lit renderer is optional: without WebGL2 (or before it exists) the button simply is not offered
const look = map as unknown as { setRenderer?: (mode: 'lit' | 'flat') => void; renderer?: 'lit' | 'flat' };
$('btnLook').hidden = typeof look.setRenderer !== 'function';
$('btnLook').addEventListener('click', (e) => {
  const b = e.currentTarget as HTMLElement;
  look.setRenderer?.(b.getAttribute('aria-pressed') !== 'true' ? 'lit' : 'flat');
  b.setAttribute('aria-pressed', String(look.renderer === 'lit'));
});
$('btnFog').addEventListener('click', (e) => {
  const b = e.currentTarget as HTMLElement;
  fog = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(fog));
  pushState();
});

const cleanSeed = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'poosheen';
$('seedForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('seed');
  input.value = cleanSeed(input.value);
  generate(input.value);
});
const A = ['sleepy', 'fluffy', 'grumpy', 'tiny', 'round', 'brave', 'sneaky', 'toasty', 'wobbly', 'mossy'];
const B = ['biscuit', 'whisker', 'bober', 'toud', 'tutel', 'monke', 'knoblin', 'mitten', 'noodle', 'pinjata'];
$('btnRandom').addEventListener('click', () => {
  const r = (n: number) => Math.floor(Math.random() * n);
  const seed = `${A[r(A.length)]}-${B[r(B.length)]}-${r(900) + 100}`;
  $<HTMLInputElement>('seed').value = seed;
  generate(seed);
});
window.addEventListener('resize', () => map.resize());
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => map.resize()).observe(canvas);

map.setGhost(true);
$('btnLook').setAttribute('aria-pressed', String(look.renderer === 'lit'));
const fromHash = cleanSeed(decodeURIComponent(location.hash.slice(1)));
if (location.hash.length > 1) $<HTMLInputElement>('seed').value = fromHash;
generate($<HTMLInputElement>('seed').value);
