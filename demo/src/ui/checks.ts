// Checks tab: validator lints, generation stats, world counts, and a batch test over many seeds.
import { countChanges } from '../core/settings';
import { h } from './shared';
import type { TabCtx, TabView } from './tab';

const BATCH = 200;

export function createChecksTab(): TabView {
  const el = h('div', { class: 'pa-checks' });
  const batch = { running: false, done: 0, bad: 0, first: 0, n: BATCH, finished: false, error: '' };
  let bar: HTMLElement | null = null;
  let tally: HTMLElement | null = null;
  let btn: HTMLButtonElement | null = null;

  const tallyText = () => {
    if (batch.error) return `Stopped: ${batch.error}`;
    if (!batch.running && !batch.finished) return `Generates ${BATCH} fresh seeds and runs every check on each.`;
    const valid = batch.done - batch.bad;
    const t = `${valid}/${batch.done} valid, ${batch.first} on the first attempt`;
    return batch.running ? `${t} … (${batch.done}/${batch.n})` : t;
  };
  const paint = () => {
    if (bar) {
      bar.style.setProperty('--p', String(batch.n ? batch.done / batch.n : 0));
      bar.parentElement?.setAttribute('aria-valuenow', String(batch.done));
      bar.parentElement?.classList.toggle('has-bad', batch.bad > 0);
    }
    if (tally) tally.textContent = tallyText();
    if (btn) { btn.disabled = batch.running; btn.textContent = batch.running ? 'Testing…' : `Test ${BATCH} seeds`; }
  };

  async function run(ctx: TabCtx): Promise<void> {
    if (batch.running) return;
    Object.assign(batch, { running: true, done: 0, bad: 0, first: 0, n: BATCH, finished: false, error: '' });
    paint();
    try {
      await ctx.cb.runBatch(BATCH, (done, bad, first) => { batch.done = done; batch.bad = bad; batch.first = first; paint(); });
      batch.finished = true;
    } catch (e) {
      batch.error = e instanceof Error ? e.message : String(e);
    } finally {
      batch.running = false;
      paint();
    }
  }

  function render(ctx: TabCtx): void {
    const { world } = ctx;
    const g = world.graph;
    const passed = world.lints.filter((l) => l.ok).length;
    const lints = h('ul', { class: 'pa-lints' }, ...world.lints.map((l) =>
      h('li', { class: l.ok ? 'is-ok' : 'is-bad' },
        h('span', { class: 'pa-lint-i', 'aria-hidden': 'true' }, l.ok ? '✓' : '✕'),
        h('div', null,
          h('div', { class: 'pa-lint-l' }, h('span', { class: 'pa-sr' }, l.ok ? 'Pass: ' : 'Fail: '), l.label),
          h('div', { class: 'pa-lint-d' }, l.detail)))));

    const counts: [string, number][] = [
      ['zones', g.locs.length],
      ['edges', g.edges.length],
      ['checks', g.checks.length],
      ['sources', g.sources.length],
      ['one-way edges', g.edges.filter((e) => e.oneWay).length],
      ['locked doors', g.edges.filter((e) => e.lock).length],
      ['tile maps', world.dims.length],
      ['spheres', world.solution.spheres.length],
    ];

    const track = h('div', {
      class: 'pa-bar', role: 'progressbar', 'aria-label': 'Seeds tested', 'aria-valuemin': '0', 'aria-valuemax': String(batch.n), 'aria-valuenow': String(batch.done),
    }, h('div', { class: 'pa-bar-fill' }));
    bar = track.firstElementChild as HTMLElement;
    tally = h('p', { class: 'pa-tally pa-num', 'aria-live': 'polite' });
    btn = h('button', { class: 'pa-btn', type: 'button', onclick: () => void run(ctx) });

    el.replaceChildren(
      h('section', { class: 'pa-sum' },
        h('div', { class: `pa-verdict ${world.ok ? 'is-ok' : 'is-bad'}` },
          h('span', { class: 'pa-verdict-v pa-num' }, `${passed}/${world.lints.length}`),
          h('span', null, world.ok ? 'checks pass for this seed' : 'checks fail for this seed')),
        h('p', { class: 'pa-muted pa-num' },
          `Seed “${world.seed}” · ${world.stats.attempts} attempt${world.stats.attempts === 1 ? '' : 's'} · ${world.stats.ms} ms`)),
      h('h3', { class: 'pa-label pa-sec-t' }, 'Validator'),
      lints,
      settingsHint(ctx) ?? '',
      h('h3', { class: 'pa-label pa-sec-t' }, 'This world'),
      h('dl', { class: 'pa-counts' }, ...counts.flatMap(([k, v]) => [h('div', null, h('dt', null, k), h('dd', { class: 'pa-num' }, String(v)))])),
      h('h3', { class: 'pa-label pa-sec-t' }, 'Batch test'),
      h('div', { class: 'pa-batch' }, btn, track, tally),
    );
    paint();
  }

  function settingsHint(ctx: TabCtx): HTMLElement | null {
    const n = ctx.world.settings ? countChanges(ctx.world.settings) : 0;
    if (ctx.world.lints.every((l) => l.ok) || n === 0) return null;
    return h('div', { class: 'pa-hint' },
      h('span', null, `Settings in effect differ from defaults (${n} changed).`),
      h('button', { class: 'pa-btn2', type: 'button', onclick: () => ctx.goTab('settings') }, 'Open settings'));
  }

  return { el, render, match: () => [] };
}
