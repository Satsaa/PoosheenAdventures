// Dynamic NPCs, simplified to something the solver can reason about:
//   an NPC is a list of stages; the active stage is the LAST one whose `when` holds.
// `when` only reads the player's inventory/flags, which never shrink, so NPCs only ever move
// forward. Anything an NPC offers is carried into later stages, so nothing becomes missable.
// The validator checks one extra rule: when a stage activates, its zone is already reachable.
import type { ItemId, NpcStage, Req } from '../core/types';
import type { Rng } from '../core/rng';
import { NPC_NAMES, gateFor } from '../core/content';
import { NONE, all, at, has, use } from '../core/req';
import type { Ctx, RegionBP } from './blueprint';
import type { Plan } from './plan';

const stageAt = (r: RegionBP, when: Req, line: string, offers: string[] = []) =>
  ({ when, loc: r.id, dim: r.stack.id, x: 0, y: 0, line, offers });

export function addNpcs(ctx: Ctx, rng: Rng, plan: Plan, regions: RegionBP[], start: RegionBP): void {
  const regionOf = (loc: string) => regions.find((r) => loc === r.id || loc.startsWith(r.id + '.')) ?? start;

  // --- Elder: main quest guide. Stays home, then walks to the sanctum once it can be opened.
  const elder = ctx.npcs.find((n) => n.id === 'elder')!;
  const sanctum = regionOf(ctx.itemHome.get('flag:victory')!);
  const M = plan.medallions;
  if (M > 0) {
    if (M > 1) elder.stages.push(stageAt(start, has('medallion'), `One medallion already! ${M - 1} more and the seal will break.`));
    // he only leaves once the player can follow: everything that could gate the way there is owned
    elder.stages.push(stageAt(sanctum, all(has('medallion', M), ...ctx.sanctumCaps.filter((c) => gateFor(c)).map((c) => has(c))), 'The seal is broken. Baddie is inside, eating everything. Go!'));
  }
  ctx.quests.unshift({
    id: 'q.main', name: 'The Sealed Sanctum', main: true, reward: 'flag:victory',
    steps: [
      { text: "Receive the Elder's gift", req: NONE, check: elder.stages[0].offers[0] },
      ...ctx.checks.filter((c) => c.item === 'medallion').map((c) => ({ text: `Win a medallion: ${c.label}`, req: NONE, check: c.id })),
      ...(M > 0 ? [{ text: `Break the seal (${M} medallion${M > 1 ? 's' : ''})`, req: has('medallion', M) }] : []),
      { text: 'Defeat Baddie', req: NONE, check: ctx.checks.find((c) => c.item === 'flag:victory')!.id },
    ],
  });

  // --- Travelling merchant: follows the player's progress and is a moving ammo source.
  const S = ctx.settings;
  // up to three stops, spread over however many tools this world has
  const T = plan.tools;
  const picks = T.length >= 6 ? [1, 3, 5] : [Math.min(1, T.length - 1), T.length >> 1, T.length - 1];
  const stops = S.merchant && T.length ? [...new Set(picks)].sort((a, b) => a - b).map((i) => T[i]) : [];
  const timeOk = S.timeFlows || plan.tools.includes('sundial');
  // the peddler packs up at dusk; one of the traders is a night owl
  const dayOnly = timeOk && rng.chance(S.timeGates);
  const owl = timeOk && rng.chance(S.timeGates) ? 1 : -1;
  if (stops.length) {
  const merchant = { id: 'merchant', name: 'Pinjata the Peddler', role: 'Travelling shop', icon: '$', color: '#ff9f6b', stages: [] as NpcStage[] };
  const heart = ctx.check(regionOf(ctx.itemHome.get(stops[0])!).id, 'heart', 'shop', "Peddler's heart piece", all(has(stops[0]), dayOnly ? at('day') : NONE, use('rupees', S.pricePeddlerHeart)));
  stops.forEach((tool, i) => {
    const r = regionOf(ctx.itemHome.get(tool)!);
    const when = has(tool);
    // every stage re-offers the same stock, so the supply never disappears from logic
    for (const ammo of ['bombs', 'arrows']) ctx.source(r.id, ammo, `Peddler (${ctx.items[ammo].name})`, all(when, dayOnly ? at('day') : NONE, use('rupees', 10)));
    merchant.stages.push({ ...stageAt(r, when, `Fresh stock! I heard you found the ${ctx.items[tool].name}, so I followed you here.`, i === 0 ? [heart.id] : []), phase: dayOnly ? 'day' : undefined });
  });
  ctx.npcs.push(merchant);
  }

  // --- Trade chain: three static NPCs, an optional quest whose reward unlocks the pricey shop shelf.
  if (S.tradeQuest) {
  const names = rng.shuffle(NPC_NAMES.filter((n) => !ctx.npcs.some((p) => p.name === n))).slice(0, 3);
  const spots = rng.shuffle(regions.filter((r) => !r.barren)).slice(0, 3);
  const t1 = ctx.item({ id: 'quest:trade1', name: 'Yarn Ball', kind: 'quest', icon: '◍', color: '#ff9fd0' });
  const t2 = ctx.item({ id: 'quest:trade2', name: 'Knitted Hat', kind: 'quest', icon: '◓', color: '#ff9fd0' });
  const gives: [ItemId, Req, string, string][] = [
    [t1, NONE, 'Take this yarn. Someone out there knits.', 'I hope the yarn found its knitter.'],
    [t2, has(t1), 'I would trade for a Yarn Ball.', 'Yarn! I finally finished the hat. It is yours now.'],
    ['wallet', has(t2), 'I would trade for a Knitted Hat.', 'What a hat. Keep my big wallet, I never filled it anyway.'],
  ];
  const steps = gives.map(([item, req, before, after], i) => {
    const r = spots[i % spots.length];
    const night = i === owl;
    const c = ctx.check(r.id, item, 'npc', `${names[i]}'s trade`, night ? all(req, at('night')) : req);
    ctx.npcs.push({
      id: 'trade' + i, name: names[i], role: 'Trade chain', icon: '☻', color: '#ff9fd0',
      stages: [stageAt(r, NONE, before, [c.id]), stageAt(r, has(item), after)].map((st) => ({ ...st, phase: night ? ('night' as const) : undefined })),
    });
    return { text: `${names[i]} in ${r.name} gives the ${ctx.items[item].name}`, req, check: c.id };
  });
  ctx.quests.push({ id: 'q.trade', name: 'Yarn for a Wallet', main: false, reward: 'wallet', steps });
  }

  // one map object per stage; the UI shows whichever stage is active
  for (const n of ctx.npcs) {
    n.stages.forEach((s, i) => {
      const r = regions.find((q) => q.id === s.loc)!;
      r.feats.push({ f: 'spot', obj: { id: `o.${n.id}.${i}`, kind: 'npc', label: `${n.name} (${n.role})`, npcId: n.id, stage: i, icon: n.icon } });
    });
  }
}
