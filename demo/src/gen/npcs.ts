// Dynamic NPCs, simplified to something the solver can reason about:
//   an NPC is a list of stages; the active stage is the LAST one whose `when` holds.
// `when` only reads the player's inventory/flags, which never shrink, so NPCs only ever move
// forward. Anything an NPC offers is carried into later stages, so nothing becomes missable.
// The validator checks one extra rule: when a stage activates, its zone is already reachable.
import type { ItemId, Req } from '../core/types';
import type { Rng } from '../core/rng';
import { NPC_NAMES, gateFor } from '../core/content';
import { NONE, all, has, use } from '../core/req';
import type { Ctx, RegionBP } from './blueprint';
import type { Plan } from './plan';

const stageAt = (r: RegionBP, when: Req, line: string, offers: string[] = []) =>
  ({ when, loc: r.id, dim: r.stack.id, x: 0, y: 0, line, offers });

export function addNpcs(ctx: Ctx, rng: Rng, plan: Plan, regions: RegionBP[], start: RegionBP): void {
  const regionOf = (loc: string) => regions.find((r) => loc === r.id || loc.startsWith(r.id + '.')) ?? start;

  // --- Elder: main quest guide. Stays home, then walks to the sanctum once it can be opened.
  const elder = ctx.npcs.find((n) => n.id === 'elder')!;
  const sanctum = regionOf(ctx.itemHome.get('flag:victory')!);
  elder.stages.push(
    stageAt(start, has('medallion'), `One medallion already! ${plan.medallions - 1} more and the seal will break.`),
    // he only leaves once the player can follow: everything that could gate the way there is owned
    stageAt(sanctum, all(has('medallion', plan.medallions), ...ctx.sanctumCaps.filter((c) => gateFor(c)).map((c) => has(c))), 'The seal is broken. Baddie is inside, eating everything. Go!'),
  );
  ctx.quests.unshift({
    id: 'q.main', name: 'The Sealed Sanctum', main: true, reward: 'flag:victory',
    steps: [
      { text: `Receive the ${ctx.items[plan.tools[0]].name} from the Elder`, req: NONE, check: elder.stages[0].offers[0] },
      ...ctx.checks.filter((c) => c.item === 'medallion').map((c) => ({ text: `Win a medallion: ${c.label}`, req: NONE, check: c.id })),
      { text: `Break the seal (${plan.medallions} medallions)`, req: has('medallion', plan.medallions) },
      { text: 'Defeat Baddie', req: NONE, check: ctx.checks.find((c) => c.item === 'flag:victory')!.id },
    ],
  });

  // --- Travelling merchant: follows the player's progress and is a moving ammo source.
  const stops = [plan.tools[1], plan.tools[3], plan.tools[5]].filter(Boolean) as ItemId[];
  const merchant = { id: 'merchant', name: 'Pinjata the Peddler', role: 'Travelling shop', icon: '$', color: '#ff9f6b', stages: [] as ReturnType<typeof stageAt>[] };
  const heart = ctx.check(regionOf(ctx.itemHome.get(stops[0])!).id, 'heart', 'shop', "Peddler's heart piece", all(has(stops[0]), use('rupees', 80)));
  stops.forEach((tool, i) => {
    const r = regionOf(ctx.itemHome.get(tool)!);
    const when = has(tool);
    // every stage re-offers the same stock, so the supply never disappears from logic
    for (const ammo of ['bombs', 'arrows']) ctx.source(r.id, ammo, `Peddler (${ctx.items[ammo].name})`, all(when, use('rupees', 10)));
    merchant.stages.push(stageAt(r, when, `Fresh stock! I heard you found the ${ctx.items[tool].name}, so I followed you here.`, i === 0 ? [heart.id] : []));
  });
  ctx.npcs.push(merchant);

  // --- Trade chain: three static NPCs, an optional quest whose reward unlocks the pricey shop shelf.
  const names = rng.shuffle(NPC_NAMES.filter((n) => !ctx.npcs.some((p) => p.name === n))).slice(0, 3);
  const spots = rng.shuffle(regions).slice(0, 3);
  const t1 = ctx.item({ id: 'quest:trade1', name: 'Yarn Ball', kind: 'quest', icon: '◍', color: '#ff9fd0' });
  const t2 = ctx.item({ id: 'quest:trade2', name: 'Knitted Hat', kind: 'quest', icon: '◓', color: '#ff9fd0' });
  const gives: [ItemId, Req, string, string][] = [
    [t1, NONE, 'Take this yarn. Someone out there knits.', 'I hope the yarn found its knitter.'],
    [t2, has(t1), 'I would trade for a Yarn Ball.', 'Yarn! I finally finished the hat. It is yours now.'],
    ['wallet', has(t2), 'I would trade for a Knitted Hat.', 'What a hat. Keep my big wallet, I never filled it anyway.'],
  ];
  const steps = gives.map(([item, req, before, after], i) => {
    const r = spots[i % spots.length];
    const c = ctx.check(r.id, item, 'npc', `${names[i]}'s trade`, req);
    ctx.npcs.push({
      id: 'trade' + i, name: names[i], role: 'Trade chain', icon: '☻', color: '#ff9fd0',
      stages: [stageAt(r, NONE, before, [c.id]), stageAt(r, has(item), after)],
    });
    return { text: `${names[i]} in ${r.name} gives the ${ctx.items[item].name}`, req, check: c.id };
  });
  ctx.quests.push({ id: 'q.trade', name: 'Yarn for a Wallet', main: false, reward: 'wallet', steps });

  // one map object per stage; the UI shows whichever stage is active
  for (const n of ctx.npcs) {
    n.stages.forEach((s, i) => {
      const r = regions.find((q) => q.id === s.loc)!;
      r.feats.push({ f: 'spot', obj: { id: `o.${n.id}.${i}`, kind: 'npc', label: `${n.name} (${n.role})`, npcId: n.id, stage: i, icon: n.icon } });
    });
  }
}
