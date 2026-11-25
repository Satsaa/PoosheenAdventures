// Top of the hierarchy: decide the progression order and what each world must contain.
// Children receive this as a brief (ordered payloads + guaranteed caps) and never report back
// anything the parent has to react to.
import type { ItemId } from '../core/types';
import type { Rng } from '../core/rng';
import { PROGRESSION_TOOLS, QUEST_ITEMS } from '../core/content';
import { has } from '../core/req';
import type { Ctx } from './blueprint';
import type { Payload } from './lockgraph';

export interface Plan {
  /** enabled tools in the order the player is meant to find them (gifts first) */
  tools: ItemId[];
  /** medallions the seal asks for */
  medallions: number;
  dungeons: number;
  /** how many leading payloads the Elder hands over in the start region */
  gifts: number;
  over: Payload[];
}

const ORDER_BIAS = { start: 0, early: -0.6, any: 0, late: 0.6 } as const;

export function makePlan(rng: Rng, ctx: Ctx): Plan {
  const S = ctx.settings;
  let pid = 0;
  const item = (it: ItemId, data?: Payload['data']): Payload => ({ id: 'p' + pid++, kind: 'item', provides: [it], data });
  const dungeon = (tool: ItemId | null): Payload =>
    ({ id: 'p' + pid++, kind: 'dungeon', provides: tool ? [tool, 'medallion'] : ['medallion'], data: { tool } });
  const plain = (p: Payload) => (p.kind === 'item' || p.kind === 'dungeon') && !p.data?.fixed;

  // 1. item settings decide which tools exist and roughly when they show up
  const enabled = PROGRESSION_TOOLS.filter((t) => S.items[t]?.enabled !== false);
  const starters = enabled.filter((t) => S.items[t]?.order === 'start');
  const rest = enabled
    .filter((t) => !starters.includes(t))
    .map((t) => ({ t, k: rng.next() + ORDER_BIAS[S.items[t]?.order ?? 'any'] }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);
  // the Elder always hands over something, so the first gate has a key
  const gifts: ItemId[] = starters.length ? starters : rest.length ? [rest.shift()!] : ['heart'];

  // 2. which tools are dungeon treasure
  const wants = rest.filter((t) => S.items[t]?.home === 'dungeon');
  const free = rng.shuffle(rest.filter((t) => (S.items[t]?.home ?? 'any') === 'any'));
  const treasure = new Set([...wants, ...free].slice(0, S.dungeons));

  // 3. the sequence, in tool order
  const seq: Payload[] = rest.map((t) => (treasure.has(t) ? dungeon(t) : item(t)));
  for (let i = treasure.size; i < S.dungeons; i++) seq.splice(rng.range(Math.min(1, seq.length), seq.length), 0, dungeon(null));
  if (S.favorQuest) {
    const [name, icon] = rng.pick(QUEST_ITEMS);
    const q = ctx.item({ id: 'quest:favor', name, kind: 'quest', icon, color: '#f0c674' });
    const flag = ctx.item({ id: 'flag:favor', name: "Guard's Trust", kind: 'flag', icon: '⚑', color: '#f0c674' });
    seq.splice(rng.range(0, seq.length), 0, item(q, { fixed: true }), { id: 'p' + pid++, kind: 'favor', provides: [flag], needs: has(q), data: { fixed: true } });
  }

  // 4. hand a stretch of the sequence to each stacked world. To the overworld a sub-world is an
  //    opaque bundle, exactly like a dungeon is.
  const wrap = (world: 'under' | 'sky', want: number, from: number, to: number) => {
    const cands = seq.map((p, i) => (plain(p) ? i : -1)).filter((i) => i >= 0);
    let inner: Payload[];
    let at: number;
    if (cands.length) {
      at = cands[Math.min(cands.length - 1, Math.floor(cands.length * (from + rng.next() * (to - from))))];
      let end = at;
      while (end < seq.length && end - at < want && plain(seq[end])) end++;
      inner = seq.splice(at, end - at);
    } else {
      at = seq.length;
      inner = [item('heart')];
    }
    seq.splice(at, 0, { id: 'p' + pid++, kind: 'portal', provides: inner.flatMap((p) => p.provides), data: { world, inner, fixed: true } });
  };
  if (S.underworld) wrap('under', rng.range(2, 3), 0.15, 0.6);
  if (S.sky) wrap('sky', rng.range(1, 2), 0.6, 1);

  // dungeons are numbered in the order the player meets them
  let dn = 0;
  const number = (ps: Payload[]) => {
    for (const p of ps) {
      if (p.kind === 'dungeon') p.data!.scope = 'd' + ++dn;
      if (p.kind === 'portal') number(p.data!.inner as Payload[]);
    }
  };
  number(seq);

  const medallions = Math.min(S.sealMedallions, S.dungeons);
  const over: Payload[] = [
    ...gifts.map((g) => item(g, { gift: true, fixed: true })),
    ...seq,
    { id: 'p' + pid++, kind: 'sanctum', provides: ['flag:victory'], needs: has('medallion', medallions), terminal: true },
  ];
  return { tools: [...gifts.filter((g) => g !== 'heart'), ...rest], medallions, dungeons: S.dungeons, gifts: gifts.length, over };
}
