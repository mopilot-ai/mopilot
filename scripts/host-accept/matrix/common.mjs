// What the matrix steps share: the harnesses a run covers, the plan of each (model, scratch repo or why it is skipped), starting a chat and watching it from another client, driving cards to the end of a turn, and the p50/p95 arithmetic.
import { expect, session, until } from '../steps.mjs';
import { answerCard, eventOf, framesOf, optionOf, pending } from '../milestones/common.mjs';
import { planFor } from '../milestones/harness.mjs';

/** The harnesses a matrix run tries, in the order of its table; the fake agent is always there. */
export const KEYS = ['fake', 'claude', 'codex'];

/** The plan of one harness, made once per run; a scratch repo it made goes at the end of the run. @param {any} ctx @param {string} key */
export async function target(ctx, key) {
  ctx.state.mx ??= {};
  if (!ctx.state.mx[key]) {
    const plan = await planFor(ctx, key, 0, `-${key}`);
    ctx.state.mx[key] = plan;
    if (plan.scratch) (ctx.state.cleanups ??= []).push(() => ctx.m.run(`rm -rf '${plan.scratch}' '${plan.scratch}'-*-outside.txt`));
  }
  return ctx.state.mx[key];
}

/** The harnesses of this run that can run, as plans. @param {any} ctx */
export async function available(ctx) {
  const plans = [];
  for (const key of KEYS) {
    const t = await target(ctx, key);
    if (!t.skip) plans.push({ key, t });
  }
  return plans;
}

/** A marker no other chat of this run carries. @param {any} ctx */
export const mark = (ctx) => `mk${ctx.nonce}x${(ctx.state.mxM = (ctx.state.mxM ?? 0) + 1)}`;

/** A chat id on this harness. @param {any} ctx @param {any} t */
export const newChat = (ctx, t) => t.w.chatId(ctx, (ctx.state.mxN = (ctx.state.mxN ?? 100) + 1));

/**
 * A client that subscribes to a new chat of this harness and starts it.
 * @param {any} ctx @param {any} t @param {string} text @param {(c: any) => Promise<unknown>} [prep] what the client does first (announce tools)
 */
export async function startChat(ctx, t, text, prep) {
  const id = newChat(ctx, t);
  const c = await session(ctx);
  try {
    if (prep) await prep(c);
    await c.request('chat.subscribe', { chatId: id, epoch: 1, fromRev: 0 });
    const t0 = Date.now();
    await c.request('chat.start', {
      chatId: id,
      epoch: 1,
      key: `accept-${id}`,
      harness: 'acp:fake',
      text,
      cwd: ctx.state.dataDir,
      ...t.start,
    });
    return { c, id, t0 };
  } catch (e) {
    c.close();
    throw e;
  }
}

/** Another client on a chat, caught up from the first revision. @param {any} ctx @param {string} id */
export async function watch(ctx, id) {
  const c = await session(ctx);
  try {
    await c.request('chat.subscribe', { chatId: id, epoch: 1, fromRev: 0 });
    return c;
  } catch (e) {
    c.close();
    throw e;
  }
}

/** The assistant's words of a chat as this client saw them (never the prompt's). @param {any} c @param {string} id */
export const textsOf = (c, id) =>
  framesOf(c, id)
    .map((e) => e.frame?.item)
    .filter((i) => i?.t === 'assistant')
    .map((i) => String(i.text ?? ''));

/** How long the summary item may trail the turn's end; a test shortens it. */
export const REPLY_WAIT = { ms: 10_000 };

/**
 * Wait for the assistant item that carries `marker` (any assistant item for an empty marker). The Host records a turn's end before its summary item (host/src/protocol.mjs: the turnEnd frame, then the assistant item), so a client that reads the reply the moment the end arrives can find none yet.
 * @param {any} c @param {string} id @param {string} marker
 */
export async function awaitReply(c, id, marker) {
  try {
    return await c.waitFor(
      (/** @type {any} */ e) => e.chatId === id && e.frame?.item?.t === 'assistant' && String(e.frame.item.text ?? '').includes(marker),
      REPLY_WAIT.ms,
    );
  } catch {
    throw new Error(`No assistant item with ${marker} reached the client (it holds ${JSON.stringify(textsOf(c, id)).slice(0, 200)}).`);
  }
}

/** Wait for the turn to end on this client. @param {any} c @param {string} id @param {number} ms */
export const turnEnd = (c, id, ms) => c.waitFor(eventOf(id, 'turnEnd'), ms);

/**
 * Answer every card the chat raises with this kind (allow or deny) until its turn ends: a harness may ask again after a Deny.
 * @param {any} c @param {string} id @param {'allow' | 'deny'} kind @param {number} ms @param {string} tag
 */
export async function drive(c, id, kind, ms, tag) {
  const answered = new Set();
  const end = Date.now() + ms;
  for (;;) {
    if (framesOf(c, id).some(eventOf(id, 'turnEnd'))) return answered.size;
    for (const card of (await pending(c)).cards.filter((x) => x.chatId === id && !answered.has(x.requestId))) {
      answered.add(card.requestId);
      await answerCard(c, card, optionOf(card, kind).optionId, `${tag}-${answered.size}`);
    }
    expect(Date.now() < end, `${id} did not finish after ${answered.size} answered card(s).`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Wait until a file exists or does not on the machine. @param {any} ctx @param {string} file @param {boolean} exists */
export const fileIs = (ctx, file, exists) =>
  until(async () => ((await ctx.m.run(`test -e '${file}'`)).code === 0) === exists, {
    what: `${file} to ${exists ? 'exist' : 'be absent'}`,
    ms: 10_000,
    every: 300,
  });

/** The nearest-rank percentile of a list of numbers. @param {number[]} values @param {number} p 0 to 100 */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** One line of p50 and p95 for a measure. @param {number[]} values */
export const spread = (values) => `p50 ${percentile(values, 50)} ms, p95 ${percentile(values, 95)} ms (n=${values.length})`;
