// Page wiring: seed bar, map stage, sphere scrubber, info card, side panels.
import type { DimId, LocId, MapObject, World } from './core/types';
import { fmtReq } from './core/req';
import { phaseAt, stateAt, type WorldState } from './core/view';
import { normalizeGraphics, type GraphicsSettings } from './render/graphics';
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
let regenTimer = 0;

// settings are a per-viewer convenience: remembered in this browser only
const STORE = 'poosheen-worldgen-settings';
function loadSettings(): GenSettings {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(STORE) ?? 'null')); } catch { return normalizeSettings(null); }
}
let settings = loadSettings();
const GFX = 'poosheen-worldgen-graphics';
let graphics: GraphicsSettings = (() => { try { return normalizeGraphics(JSON.parse(localStorage.getItem(GFX) ?? 'null')); } catch { return normalizeGraphics(null); } })();
let hours = 10;
let clock = 0;

const canvas = $<HTMLCanvasElement>('map');
const info = $('info');
const sphere = $<HTMLInputElement>('sphere');

const map = createMapView(canvas, {
  onPick: (obj) => (obj ? showInfo(obj) : hideInfo()),
});
// (a variable rather than a literal, so callbacks the panels do not know yet are tolerated)
const callbacks = {
  focusLoc,
  setSphere: (k: number) => setSphere(k),
  runBatch: async (n: number, onProgress: (done: number, bad: number, firstTry: number) => void) => {
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
  changeGraphics: (next: GraphicsSettings) => {
    graphics = normalizeGraphics(next);
    try { localStorage.setItem(GFX, JSON.stringify(graphics)); } catch { /* not remembered, still applied */ }
    view.setGraphics?.(graphics);
    side.setGraphics?.(graphics);
  },
  changeSettings: (next: GenSettings) => {
    settings = normalizeSettings(next);
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* not remembered, still applied */ }
    // small worlds regenerate on every tick; when the last one was slow, wait for the slider to settle
    clearTimeout(regenTimer);
    if (world.stats.ms < 120) generate(world.seed, true);
    else {
      $('status').textContent = 'generating…';
      regenTimer = window.setTimeout(() => generate(world.seed, true), 220);
    }
  },
};
const panels = createPanels($('panels'), callbacks);

// methods the renderer and panels are gaining; optional so the page works with or without them
const view = map as unknown as { setGraphics?: (g: GraphicsSettings) => void; setTime?: (hours: number) => void };
const side = panels as unknown as { setGraphics?: (g: GraphicsSettings) => void };

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
  state = stateAt(world, k, hours);
  sphere.value = String(state.sphere);
  $('sphereLabel').textContent = `Sphere ${state.sphere} of ${world.solution.spheres.length - 1}`;
  const names = state.gained.map((it) => `<b style="color:${esc(world.items[it]?.color ?? '')}">${esc(world.items[it]?.icon ?? '')}</b> ${esc(world.items[it]?.name ?? it)}`);
  $('gained').innerHTML = names.length ? 'Found: ' + names.join(', ') : 'Nothing new to pick up';
  pushState();
  panels.setState(state);
  summarise();
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

// fullscreen for the map: the browser's own where it is allowed, otherwise the stage fills the page
const stage = document.querySelector('.stage') as HTMLElement;
const isFull = () => document.fullscreenElement === stage || stage.classList.contains('max');
function syncFull(): void {
  $('btnFull').setAttribute('aria-pressed', String(isFull()));
  $('btnFull').textContent = isFull() ? 'Exit fullscreen' : 'Fullscreen';
  map.resize();
}
$('btnFull').addEventListener('click', async () => {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  else if (stage.classList.contains('max')) stage.classList.remove('max');
  else {
    try { await stage.requestFullscreen(); } catch { stage.classList.add('max'); }
  }
  syncFull();
});
document.addEventListener('fullscreenchange', syncFull);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stage.classList.contains('max')) { stage.classList.remove('max'); syncFull(); }
});
$('btnGhost').addEventListener('click', (e) => {
  const b = e.currentTarget as HTMLElement;
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on));
  map.setGhost(on);
});
$('btnFog').addEventListener('click', (e) => {
  const b = e.currentTarget as HTMLElement;
  fog = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(fog));
  pushState();
});

// ------------------------------------------------------------------ touch diagnostics
// A readout for input problems that only show up on a particular device or app: which element a
// touch lands on, whether it could be cancelled, and which element actually scrolled.
{
  const out = $('diag');
  const lines: string[] = [];
  const name = (t: EventTarget | null) => {
    const e = t as HTMLElement | null;
    if (!e || !e.tagName) return String(t === document ? 'document' : t === window ? 'window' : '?');
    const cls = typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + cls;
  };
  const say = (s: string) => {
    if (lines[0]?.startsWith(s.slice(0, 24))) lines[0] = s; else lines.unshift(s);
    lines.length = Math.min(lines.length, 12);
    out.textContent = lines.join('\n');
  };
  let on = false, moves = 0;
  const hear = (type: string) => window.addEventListener(type, (ev) => {
    if (!on) return;
    if (type === 'scroll') { const e = ev.target as HTMLElement; say(`scroll   ${name(ev.target)} top=${Math.round((e as HTMLElement).scrollTop ?? window.scrollY)}`); return; }
    if (type === 'touchmove' || type === 'pointermove') { moves++; say(`${type} x${moves} on ${name(ev.target)} cancelable=${ev.cancelable} prevented=${ev.defaultPrevented}`); return; }
    moves = 0;
    say(`${type.padEnd(11)} on ${name(ev.target)} cancelable=${ev.cancelable}`);
  }, { capture: true, passive: true });
  ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'scroll'].forEach(hear);
  $('btnDiag').addEventListener('click', () => {
    on = !on;
    $('btnDiag').setAttribute('aria-pressed', String(on));
    out.hidden = !on;
    lines.length = 0;
    out.textContent = on ? 'Touch diagnostics on. Drag where the problem is, then read the lines here (newest first).' : '';
  });
}

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
view.setGraphics?.(graphics);
side.setGraphics?.(graphics);

// ------------------------------------------------------------------ time of day
function summarise(): void {
  if (!world || !state) return;
  $('scrubsNow').textContent = `Sphere ${state.sphere} of ${world.solution.spheres.length - 1} · ${$('hoursLabel').textContent} ${phaseAt(hours)}`;
}
function setHours(h: number): void {
  const flipped = phaseAt(h) !== phaseAt(hours);
  hours = h;
  const hh = Math.floor(h) % 24, mm = Math.floor((h - Math.floor(h)) * 60);
  $('hoursLabel').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  $('phaseLabel').textContent = phaseAt(h);
  $<HTMLInputElement>('hours').value = String(h);
  view.setTime?.(h);
  summarise();
  // what is out and about only changes at dawn and dusk
  if (flipped && world) setSphere(state.sphere);
}
$('hours').addEventListener('input', (e) => setHours(Number((e.currentTarget as HTMLInputElement).value)));
$('btnClock').addEventListener('click', () => {
  if (clock) { cancelAnimationFrame(clock); clock = 0; $('btnClock').textContent = '▶'; return; }
  $('btnClock').textContent = '❚❚';
  // a full day in about a minute, advanced every frame so light and shadows glide
  let last = performance.now();
  const tick = (now: number) => {
    setHours((hours + ((now - last) / 1000) * 0.4) % 24);
    last = now;
    clock = requestAnimationFrame(tick);
  };
  clock = requestAnimationFrame(tick);
});
const fromHash = cleanSeed(decodeURIComponent(location.hash.slice(1)));
if (location.hash.length > 1) $<HTMLInputElement>('seed').value = fromHash;
generate($<HTMLInputElement>('seed').value);
