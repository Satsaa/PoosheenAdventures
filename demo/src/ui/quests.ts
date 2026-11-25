// Quests tab: quest steps ticked against the current sphere, and NPCs as monotone stage steppers.
import { fmtReq } from '../core/req';
import { h, chip, reqOk, selLoc, type Selection } from './shared';
import type { TabCtx, TabView } from './tab';

export function createQuestsTab(): TabView {
  const el = h('div', { class: 'pa-quests' });

  function render(ctx: TabCtx): void {
    const { world, state, ix, cb } = ctx;
    const quests = [...world.quests].sort((a, b) => Number(b.main) - Number(a.main));
    const qBox = h('div', { class: 'pa-cards' });
    for (const q of quests) {
      const steps = q.steps.map((st) => {
        const k = st.check ? world.solution.checkSphere[st.check] : undefined;
        const done = st.check ? k !== undefined && k <= state.sphere : reqOk(world, state, st.req);
        return { st, done, k };
      });
      const nDone = steps.filter((x) => x.done).length;
      const ol = h('ol', { class: 'pa-steps' });
      for (const { st, done, k } of steps) {
        const chk = st.check ? ix.check.get(st.check) : undefined;
        const where = chk ? ix.loc.get(chk.loc)?.name : undefined;
        ol.append(h('li', { class: done ? 'is-done' : '', 'data-check': st.check },
          h('span', { class: 'pa-tick', 'aria-hidden': 'true' }, done ? '✓' : ''),
          h('span', { class: 'pa-sr' }, done ? 'done: ' : 'to do: '),
          h('div', { class: 'pa-step-b' },
            chk
              ? h('button', { class: 'pa-link', type: 'button', onclick: () => cb.focusLoc(chk.loc), title: where ? `Show ${where} on the map` : undefined }, st.text)
              : h('span', null, st.text),
            h('span', { class: 'pa-muted pa-step-m' },
              chk ? (k !== undefined ? `sphere ${k}` : 'never reached') : st.req.t !== 'none' ? `when you own ${fmtReq(st.req, world.items)}` : ''))));
      }
      qBox.append(h('article', { class: `pa-card${q.main ? ' is-main' : ''}`, 'data-quest': q.id },
        h('header', { class: 'pa-card-h' },
          h('h4', { class: 'pa-card-t' }, q.name),
          q.main ? h('span', { class: 'pa-tag is-main' }, 'main') : h('span', { class: 'pa-tag' }, 'side'),
          h('span', { class: 'pa-muted pa-num pa-card-n' }, `${nDone}/${steps.length}`)),
        h('div', { class: 'pa-kv' }, h('span', { class: 'pa-tf-k' }, 'reward'), h('span', { class: 'pa-chips' }, chip(world, q.reward))),
        ol));
    }

    const nBox = h('div', { class: 'pa-cards' });
    for (const n of world.npcs) {
      // npcStage is -1 while an NPC has not appeared yet (e.g. the peddler before his first stop)
      const k0 = state.npcStage[n.id] ?? 0;
      const absent = !n.stages[k0] || !reqOk(world, state, n.stages[k0].when);
      const active = absent ? -1 : k0;
      const ol = h('ol', { class: 'pa-stepper' });
      n.stages.forEach((st, i) => {
        const where = ix.loc.get(st.loc)?.name ?? st.loc;
        const cls = i === active ? 'is-active' : i < active ? 'is-past' : 'is-next';
        ol.append(h('li', { class: cls, 'data-stage': `${n.id}.${i}` },
          h('button', { class: 'pa-stage', type: 'button', onclick: () => cb.focusLoc(st.loc), 'aria-current': i === active ? 'step' : undefined, title: `Show ${where} on the map` },
            h('span', { class: 'pa-stage-dot', 'aria-hidden': 'true' }),
            h('span', { class: 'pa-stage-b' },
              h('span', { class: 'pa-stage-when' }, st.when.t === 'none' ? 'from the start' : `once you own ${fmtReq(st.when, world.items)}`),
              h('span', { class: 'pa-stage-loc' }, where, i === active ? h('span', { class: 'pa-tag is-active' }, 'now') : null),
              h('q', { class: 'pa-stage-line' }, st.line)))));
      });
      nBox.append(h('article', { class: 'pa-card pa-npc', 'data-npc': n.id },
        h('header', { class: 'pa-card-h' },
          h('span', { class: 'pa-npc-i', style: { '--chip-c': n.color }, 'aria-hidden': 'true' }, n.icon),
          h('h4', { class: 'pa-card-t' }, n.name),
          absent ? h('span', { class: 'pa-tag', title: 'No stage condition holds yet' }, 'not around yet') : null,
          h('span', { class: 'pa-muted pa-card-n' }, n.role)),
        ol));
    }

    el.replaceChildren(
      h('h3', { class: 'pa-label pa-sec-t' }, 'Quests'), qBox,
      h('h3', { class: 'pa-label pa-sec-t' }, 'NPCs'),
      h('p', { class: 'pa-note' }, 'NPCs only ever move forward, driven by what the player owns, and never to a place the player cannot reach yet.'),
      nBox);
  }

  function match(sel: Selection, ctx: TabCtx): Element[] {
    if (!sel) return [];
    const q = (a: string, v: string) => [...el.querySelectorAll(`[${a}="${CSS.escape(v)}"]`)];
    if (sel.npcId) return q('data-npc', sel.npcId);
    if (sel.checkId) {
      const steps = q('data-check', sel.checkId);
      const npc = ctx.world.npcs.find((n) => n.stages.some((s) => s.offers.includes(sel.checkId!)));
      return [...steps, ...(npc ? q('data-npc', npc.id) : [])];
    }
    const loc = selLoc(ctx.world, ctx.ix, ctx.state, sel);
    if (!loc) return [];
    const out: Element[] = [];
    for (const n of ctx.world.npcs) {
      const k = ctx.state.npcStage[n.id] ?? 0;
      if (n.stages[k]?.loc === loc) out.push(...q('data-npc', n.id));
    }
    return out;
  }

  return { el, render, match };
}
