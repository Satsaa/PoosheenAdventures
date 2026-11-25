// Fuzz: random settings x random seeds must still give valid worlds (or fail loudly, never crash).
import { generateWorld } from './gen/index';
import { Rng } from './core/rng';
import { ITEM_SETTING_DEFS, SETTING_DEFS, defaultSettings, normalizeSettings, type GenSettings, type ItemHome, type ItemOrder } from './core/settings';

const N = Number(process.argv[2] ?? 300);
const rng = new Rng(12345);
let bad = 0, thrown = 0, attempts = 0, ms = 0;
const why = new Map<string, number>();
for (let i = 0; i < N; i++) {
  const s = defaultSettings() as GenSettings & Record<string, number | boolean>;
  for (const d of SETTING_DEFS) {
    if (!rng.chance(0.6)) continue;
    if (d.type === 'bool') s[d.key] = rng.chance(0.5);
    else s[d.key] = d.type === 'int' ? rng.range(d.min!, d.max!) : d.min! + rng.next() * (d.max! - d.min!);
  }
  for (const d of ITEM_SETTING_DEFS) {
    const it = s.items[d.id];
    if (d.fields.includes('enabled')) it.enabled = rng.chance(0.8);
    if (d.fields.includes('order')) it.order = rng.pick(['start', 'early', 'any', 'any', 'late'] as ItemOrder[]);
    if (d.fields.includes('home')) it.home = rng.pick(['any', 'overworld', 'dungeon'] as ItemHome[]);
    if (d.fields.includes('cap') && rng.chance(0.4)) it.cap = rng.range(d.capRange![0], d.capRange![1]);
  }
  s.maxAttempts = 12;
  // the fuzz run stays at moderate sizes so it finishes quickly; test-scale covers the huge ones
  s.worldW = Math.min(s.worldW, 16); s.worldH = Math.min(s.worldH, 12); s.underworldSize = Math.min(s.underworldSize, 60); s.skySize = Math.min(s.skySize, 40);
  s.dungeons = Math.min(s.dungeons, 8); s.dungeonRooms = Math.min(s.dungeonRooms, 20);
  // keep the economy consistent; inconsistent prices are a legitimate lint failure, tested separately
  const base = s.items.rupees.cap!, big = Math.max(base, s.items.wallet.cap!);
  s.priceBombs = Math.min(s.priceBombs, base); s.priceArrows = Math.min(s.priceArrows, base);
  s.pricePeddlerHeart = Math.min(s.pricePeddlerHeart, base); s.priceHeart = Math.min(s.priceHeart, big);
  try {
    const w = generateWorld('fuzz' + i, s);
    attempts += w.stats.attempts; ms += w.stats.ms;
    if (!w.ok) {
      bad++;
      for (const l of w.lints.filter((x) => !x.ok)) { const k = l.id + ': ' + l.detail.replace(/[a-z]+\d+[\w.]*/g, '#').slice(0, 100); why.set(k, (why.get(k) ?? 0) + 1); }
      if (bad <= 3) console.log('BAD fuzz' + i, JSON.stringify(normalizeSettings(s)).slice(0, 900));
    }
  } catch (e) { thrown++; if (thrown <= 4) console.log('THROW fuzz' + i, (e as Error).stack?.split('\n').slice(0, 4).join(' | '), JSON.stringify(normalizeSettings(s)).slice(0, 700)); }
}
console.log([...why].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => v + 'x ' + k).join('\n'));
// an impossible price must be reported by the validator, not hidden
const d0 = defaultSettings();
const broke = generateWorld('broke', { priceHeart: 300, maxAttempts: 2, items: { ...d0.items, wallet: { cap: 100 } } });
const reported = !broke.ok && broke.lints.some((l) => l.id === 'complete' && !l.ok);
console.log('impossible price reported by the validator:', reported);
// settings must actually take effect
const tiny = generateWorld('tiny', { worldW: 5, worldH: 4, regions: 3, rivers: 0, underworld: false, sky: false, dungeons: 1, favorQuest: false, tradeQuest: false, merchant: false,
  items: { ...d0.items, bow: { enabled: false }, hookshot: { enabled: false }, sword: { enabled: true, order: 'start', home: 'any' }, lantern: { enabled: true, order: 'start', home: 'any' } } });
const got0 = tiny.solution.spheres[0].collected.map((c) => c.item);
const effect = tiny.ok && tiny.dims[0].w === 60 && tiny.dims[0].h === 40 && tiny.dims[0].regions.length === 3 && !tiny.dims.some((d) => d.id === 'under' || d.id === 'sky')
  && tiny.graph.checks.filter((c) => c.item === 'medallion').length === 1 && !tiny.graph.checks.some((c) => c.item === 'bow' || c.item === 'hookshot')
  && got0.includes('sword') && got0.includes('lantern') && tiny.npcs.length === 1;
console.log('settings take effect:', effect, effect ? '' : JSON.stringify({ ok: tiny.ok, w: tiny.dims[0].w, r: tiny.dims[0].regions.length, got0, npcs: tiny.npcs.length, lints: tiny.lints.filter((l) => !l.ok) }));
if (!reported || !effect) process.exit(1);
console.log('SETTINGS', JSON.stringify({ N, bad, thrown, avgAttempts: +(attempts / N).toFixed(2), msPer: +(ms / N).toFixed(1) }));
// extreme combinations may be too cramped for the tile pass; that must stay rare and must be REPORTED (a failed check), never a crash
process.exit(thrown || bad > N * 0.02 ? 1 : 0);
