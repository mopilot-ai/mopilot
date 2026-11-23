// The matrix's timing step: per harness, a few runs of one approval chat, measuring start to first frame, the card round trip (the answer sent to the turn ended) and resume (a returning client caught up), and the p50/p95 table the report ends with.
import { expect } from '../steps.mjs';
import { answerCard, optionOf, waitCard } from '../milestones/common.mjs';
import { available, mark, percentile, spread, startChat, turnEnd, watch } from './common.mjs';

/** @param {Record<string, { start: number[], card: number[], resume: number[] }>} samples */
export function formatTimings(samples) {
  const rows = Object.entries(samples).flatMap(([key, m]) =>
    /** @type {const} */ (['start', 'card', 'resume']).map(
      (measure) =>
        `| ${key} | ${{ start: 'start to first frame', card: 'card round trip', resume: 'resume (caught up)' }[measure]} | ${m[measure].length} | ${percentile(m[measure], 50)} | ${percentile(m[measure], 95)} |`,
    ),
  );
  return ['**Timings (ms)**', '', '| Harness | Measure | Runs | p50 | p95 |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}

export const TIMINGS_STEP = {
  id: 'timings',
  title: 'Matrix timings: start to first frame, card round trip and resume, p50 and p95 per harness',
  /** @param {any} ctx */
  async run(ctx) {
    const runs = ctx.opts.runs;
    /** @type {Record<string, { start: number[], card: number[], resume: number[] }>} */
    const samples = {};
    for (const { key, t } of await available(ctx)) {
      /** @type {{ start: number[], card: number[], resume: number[] }} */
      const m = { start: [], card: [], resume: [] };
      samples[key] = m;
      for (let i = 0; i < runs; i++) {
        const marker = mark(ctx);
        const { c, id, t0 } = await startChat(ctx, t, t.w.approveWith(t.scratch, marker));
        try {
          await c.waitFor((/** @type {any} */ e) => e.chatId === id, t.w.waitMs);
          m.start.push(Date.now() - t0);
          const card = await waitCard(c, id);
          const a0 = Date.now();
          await answerCard(c, card, optionOf(card, 'allow').optionId, `timing-${id}`);
          await turnEnd(c, id, t.w.waitMs);
          m.card.push(Date.now() - a0);
        } finally {
          c.close();
        }
        const back = await watch(ctx, id);
        try {
          const r0 = Date.now();
          await turnEnd(back, id, t.w.waitMs);
          m.resume.push(Date.now() - r0);
        } finally {
          back.close();
        }
      }
    }
    expect(Object.keys(samples).length > 0, 'No harness ran.');
    ctx.state.timingsTable = formatTimings(samples);
    return Object.entries(samples)
      .map(([key, m]) => `${key}: start ${spread(m.start)}; card ${spread(m.card)}; resume ${spread(m.resume)}`)
      .join(' | ');
  },
};
