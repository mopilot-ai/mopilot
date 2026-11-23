// What M1/S1 needs of the harness it runs on (`--harness claude|codex`, default the fake ACP agent): a small per-harness table of start parameters and of how the resumed turn is read, and the plan that picks the cheapest model, a scratch git repo and the signed-in check.
import { randomUUID } from 'node:crypto';
import { priceFor } from '../../../shared/host/prices.mjs';
import { chat, expect, hostUp, replyOf } from '../steps.mjs';
import { eventOf } from './common.mjs';

/** What a real harness is asked to say, and to do slowly enough to be stopped. */
const SAY = (/** @type {string} */ marker) => `Reply with exactly this text and nothing else: ${marker}`;
const SLOW = 'Count from 1 to 300, one number per line, and do not stop until you reach 300.';
/** Claude Code asks before it writes a file, even inside the folder it runs in. */
const CLAUDE_PROMPT = () => 'Create the file note.txt in the current directory with the text hi. Do nothing else.';
/**
 * Codex's "Ask for approval" is `on-request` with the workspace-write sandbox (electron/harness/codexParams.cjs permissionParams, the same on a Mac and on a Host): a write inside the folder it runs in needs no approval, one outside the folder does.
 * @param {string} scratch the folder the chat runs in
 */
const CODEX_PROMPT = (scratch) =>
  `Run exactly this shell command and nothing else, and do not pick another path: touch '${scratch}-outside.txt'`;
/** What the resumed turn is asked: no second card. */
const NO_SECOND_CARD = 'Do not create any file now. Just reply done.';

/**
 * The wiring of each harness. `cheap` lists, in order, the patterns of the model it should run on; `settled` is the item that says the resumed turn is over and `resumed` returns what is wrong with it (empty when nothing is).
 * @type {Record<string, { id: string, real: boolean, chatId: (ctx: any, n: number) => string, prompt: (scratch: string) => string, say: (marker: string) => string, approveWith: (scratch: string, marker: string) => string, effect: (scratch: string, marker: string) => string, slow: string, cardKind: string, resumeText: string, waitMs: number, cheap: RegExp[], settled: (chatId: string) => (e: any) => boolean, resumed: (e: any) => string }>}
 */
export const WIRING = {
  fake: {
    id: 'acp:fake',
    real: false,
    chatId: chat,
    prompt: () => 'PERMIT leave and return',
    say: (marker) => `hello ${marker}`,
    approveWith: (_scratch, marker) => `PERMIT ${marker}`,
    effect: () => '',
    slow: 'SLOW stop me',
    cardKind: 'permission',
    resumeText: 'resume please',
    waitMs: 30_000,
    cheap: [],
    settled: replyOf,
    resumed: (e) => {
      const reply = e.frame.item;
      return reply.text.includes('resume please') && reply.stopReason === 'end_turn' ? '' : `The resumed turn said "${reply.text}".`;
    },
  },
  claude: {
    id: 'claude',
    real: true,
    // Claude Code session ids are UUIDs: the app mints `claude:<uuid>` for a new chat (electron/platform/chatStart.cjs), and so does this run
    chatId: () => `claude:${randomUUID()}`,
    prompt: CLAUDE_PROMPT,
    say: SAY,
    approveWith: (_scratch, marker) =>
      `Create the file note-${marker}.txt in the current directory with the text ${marker}. Do nothing else.`,
    effect: (scratch, marker) => `${scratch}/note-${marker}.txt`,
    slow: SLOW,
    cardKind: 'permission',
    resumeText: NO_SECOND_CARD,
    waitMs: 180_000,
    cheap: [/haiku/i, /sonnet/i],
    settled: (chatId) => eventOf(chatId, 'turnEnd'),
    resumed: (e) => (e.frame.item.event.stopReason === 'end_turn' ? '' : `The resumed turn ended with ${e.frame.item.event.stopReason}.`),
  },
  codex: {
    id: 'codex',
    real: true,
    chatId: () => randomUUID(),
    prompt: CODEX_PROMPT,
    say: SAY,
    approveWith: (scratch, marker) => CODEX_PROMPT(`${scratch}-${marker}`),
    effect: (scratch, marker) => `${scratch}-${marker}-outside.txt`,
    slow: SLOW,
    cardKind: 'permission',
    resumeText: NO_SECOND_CARD,
    waitMs: 180_000,
    cheap: [/mini|small|spark|nano/i, /luna/i],
    settled: (chatId) => eventOf(chatId, 'turnEnd'),
    resumed: (e) => (e.frame.item.event.stopReason === 'end_turn' ? '' : `The resumed turn ended with ${e.frame.item.event.stopReason}.`),
  },
};

/** A model's generation as the digits of its id (`gpt-5.6-luna` is `5.6`; none reads as the oldest). @param {{ id: string }} m */
const generation = (m) => m.id.match(/\d+(?:\.\d+)*/)?.[0] ?? '';

/**
 * The cheapest of the models a harness reports: the first pattern that names any of them picks the group (else all of them), and in the group the lowest list price when every one is priced (shared/host/prices.mjs), else the oldest generation.
 * @template {{ id: string, name?: string }} M
 * @param {RegExp[]} patterns @param {M[]} models @returns {M | undefined}
 */
export function cheapestOf(patterns, models) {
  const group = patterns.map((re) => models.filter((m) => re.test(`${m.id} ${m.name ?? ''}`))).find((g) => g.length) ?? models;
  const prices = group.map((m) => priceFor(m.id));
  // only read when every price exists
  const total = (/** @type {number} */ i) => /** @type {any} */ (prices[i]).input + /** @type {any} */ (prices[i]).output;
  const order = group.map((m, i) => ({ m, i }));
  order.sort((x, y) =>
    prices.every(Boolean) ? total(x.i) - total(y.i) : generation(x.m).localeCompare(generation(y.m), 'en', { numeric: true }),
  );
  return order[0]?.m;
}

/** The effort to run at: low when the model takes it, else the first it lists, else none. @param {{ efforts?: string[] }} model */
const effortOf = (model) => (model.efforts?.includes('low') ? 'low' : model.efforts?.[0]);

/**
 * Where a run on one harness starts: its wiring, a chat id, and for a real harness the model, effort and scratch repo, or why this run cannot use it.
 * A harness that is absent, signed out or lists no model gives `skip`; this run never signs in.
 * @param {any} ctx @param {string} key a key of WIRING @param {number} n @param {string} [tag] told apart in the scratch folder's name when one run holds several
 * @returns {Promise<{ skip: string, w: (typeof WIRING)[string], chatId: string, start: Record<string, unknown>, pick: { model?: string, effort?: string }, scratch: string, prompt: string }>}
 */
export async function planFor(ctx, key, n, tag = '') {
  const w = WIRING[key];
  const chatId = w.chatId(ctx, n);
  /** @type {{ model?: string, effort?: string }} */
  const pick = {};
  const skipped = (/** @type {string} */ skip) => ({ skip, w, chatId, start: {}, pick, scratch: '', prompt: '' });
  if (!w.real) return { skip: '', w, chatId, start: {}, pick, scratch: '', prompt: w.prompt('') };
  const h = (await hostUp(ctx)).status.harnesses.find((/** @type {any} */ x) => x.id === w.id);
  if (!h?.detected || !h.signedIn)
    return skipped(
      `${w.id} is ${h?.detected ? 'signed out' : 'not installed'} on this Host (status: ${h ? JSON.stringify(h) : 'not listed'}); the run never signs in`,
    );
  const models = /** @type {any[]} */ (h.models ?? []);
  const model = cheapestOf(w.cheap, models);
  if (!model) return skipped(`${w.id} lists no model to run on; the run picks none by guess`);
  const effort = effortOf(model);
  Object.assign(pick, { model: model.id, ...(effort ? { effort } : {}) });
  const home = (await ctx.m.run('echo $HOME')).stdout.trim();
  const scratch = `${home}/mopilot-accept-${ctx.nonce}${tag}`;
  const made = await ctx.m.run(
    `mkdir -p '${scratch}' && cd '${scratch}' && git init -q && git -c user.name=accept -c user.email=accept@example.invalid commit -q --allow-empty -m init`,
  );
  expect(made.code === 0, `The scratch git repo could not be made: ${made.stderr.trim()}.`);
  return {
    skip: '',
    w,
    chatId,
    scratch,
    prompt: w.prompt(scratch),
    pick,
    start: { harness: w.id, cwd: scratch, permission: 'default', ...pick },
  };
}

/** Where M1/S1 starts (`--harness`, default the fake agent). @param {any} ctx @param {number} n */
export const planS1 = (ctx, n) => planFor(ctx, ctx.opts.harness || 'fake', n);

/** Remove the scratch repo S1 made, and the file a Codex prompt may have written beside it, if it made any. @param {any} ctx */
export async function dropScratch(ctx) {
  const scratch = ctx.state.s1?.scratch;
  if (scratch) await ctx.m.run(`rm -rf '${scratch}' '${scratch}-outside.txt'`);
}
