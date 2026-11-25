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
  tools: ItemId[];
  medallions: number;
  over: Payload[];
}

export function makePlan(rng: Rng, ctx: Ctx): Plan {
  // variation: the tool order is shuffled, but a way to earn rupees early keeps shops honest
  const tools = rng.shuffle(PROGRESSION_TOOLS);
  let t = 0;
  let dungeons = 0;
  let pid = 0;
  const item = (it: ItemId): Payload => ({ id: 'p' + pid++, kind: 'item', provides: [it] });
  const tool = () => item(tools[t++]);
  const dungeon = (): Payload => {
    const scope = 'd' + ++dungeons;
    const tl = tools[t++];
    return { id: 'p' + pid++, kind: 'dungeon', provides: [tl, 'medallion'], data: { scope, tool: tl } };
  };
  const portal = (world: 'under' | 'sky', inner: Payload[]): Payload => ({
    id: 'p' + pid++, kind: 'portal', provides: inner.flatMap((p) => p.provides), data: { world, inner },
  });
  const favor = (): Payload[] => {
    const [name, icon] = rng.pick(QUEST_ITEMS);
    const q = ctx.item({ id: 'quest:favor', name, kind: 'quest', icon, color: '#f0c674' });
    const flag = ctx.item({ id: 'flag:favor', name: "Guard's Trust", kind: 'flag', icon: '⚑', color: '#f0c674' });
    return [item(q), { id: 'p' + pid++, kind: 'favor', provides: [flag], needs: has(q) }];
  };

  // The overworld sequence. Sub-worlds are opaque bundles here, exactly like dungeons are.
  const over: Payload[] = [tool(), tool()];
  const mid: (() => Payload[])[] = rng.shuffle([
    () => [dungeon()],
    () => favor(),
    () => [portal('under', rng.chance(0.5) ? [tool(), dungeon()] : [dungeon(), tool()])],
  ]);
  for (const m of mid) over.push(...m());
  if (t < tools.length - 1) over.push(tool());
  over.push(portal('sky', [dungeon()]));
  while (t < tools.length) over.push(tool());
  over.push({
    id: 'p' + pid++, kind: 'sanctum', provides: ['flag:victory'], needs: has('medallion', dungeons), terminal: true,
  });
  return { tools, medallions: dungeons, over };
}
