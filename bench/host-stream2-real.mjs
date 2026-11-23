// Real-login Host stream probes: install the Host, exercise Claude questions/sub-agents and Codex output, and verify a stopped source's production local continuation inbox with a VM-only model consumer.
//   VMLOCK_VM=<vm> ~/bench/runner/vmlock.sh acquire <tag>; node bench/host-stream2-real.mjs --vm <mopilot-*> [--only claude|codex] [--steps R1,R4,R5,R6,R7]
// The guest's own sign-ins are used (the Host user's `claude` and `codex`); nothing is signed in by this run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { channelFor, realDeps, runSteps } from '../scripts/host-accept.mjs';
import { exitCode, formatReport } from '../scripts/host-accept/report.mjs';
import { STEPS, cleanup, expect, until } from '../scripts/host-accept/steps.mjs';
import { lineClient } from '../scripts/host-accept/wire.mjs';
import { mcpCheck, lostHostCheck } from './host-stream/checks.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {any} ctx */
const connect = (ctx) => lineClient(ctx.m.open(`nc -U '${ctx.state.socket}'`), { timeoutMs: 120_000 });

/** A paired connection that said hello with every feature this build has (stream2 included). @param {any} ctx */
async function session(ctx) {
  const c = connect(ctx);
  await ctx.deps.authenticate((/** @type {string} */ m, /** @type {object} */ p) => c.request(m, p), ctx.state.identity);
  const hello = await c.request('host.hello', ctx.deps.helloParams());
  expect(hello.agreed?.features?.includes('stream2'), 'The Host did not agree on stream2.');
  return c;
}

/** Starts a chat of the harness, subscribed before the first message; returns the connection and the frames it will collect. @param {any} ctx @param {string} chatId @param {string} harness @param {string} text */
async function begin(ctx, chatId, harness, text) {
  const c = await session(ctx);
  await c.request('chat.subscribe', { chatId, epoch: 1, fromRev: 0 });
  await c.request('chat.start', { chatId, epoch: 1, key: `s2-${crypto.randomUUID()}`, harness, text, cwd: ctx.state.dataDir });
  return c;
}

/** The frames of a chat, in the order the Host sent them. @param {ReturnType<typeof lineClient>} c @param {string} chatId */
const framesOf = (c, chatId) => c.events.filter((e) => e.event === 'frame' && e.chatId === chatId).map((e) => e.frame);
/** The newest card of a kind (`question`, `permission`) the chat's stream has told and not closed, or null. @param {ReturnType<typeof lineClient>} c @param {string} chatId @param {string} kind */
function cardOf(c, chatId, kind) {
  const events = framesOf(c, chatId)
    .filter((f) => f.t === 'durable' && f.item?.t === 'event')
    .map((f) => f.item.event);
  const closed = new Set(events.filter((e) => e.kind === 'permissionCancelled').map((e) => e.requestId));
  return events.findLast((e) => e.kind === kind && !closed.has(e.requestId ?? e.question?.id)) ?? null;
}
/** A finished error (including quota exhaustion) fails immediately instead of waiting three minutes for a card. */
async function waitCard(c, chatId, kinds) {
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const cards = kinds.map((kind) => cardOf(c, chatId, kind)).filter(Boolean);
    if (cards.length) return cards[0];
    const reply = framesOf(c, chatId).find((f) => f.item?.t === 'assistant');
    if (reply) throw new Error(`Turn ended before ${kinds.join('/')} card: ${String(reply.item.error ?? reply.item.text).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${kinds.join('/')} card.`);
}
const isReply = (/** @type {string} */ chatId) => (/** @type {any} */ e) => e.chatId === chatId && e.frame?.item?.t === 'assistant';

/** @param {string} id @param {string} harness */
const signedIn = (id, harness) => async (/** @type {any} */ ctx) => {
  const c = connect(ctx);
  try {
    const s = await c.request('status');
    const h = (s.harnesses ?? []).find((/** @type {any} */ x) => x.id === harness);
    expect(h?.detected && h?.signedIn, `${id}: ${harness} is not installed and signed in for the Host user on ${ctx.target}.`);
  } finally {
    c.close();
  }
};

/** @param {{ only?: string }} o */
export const steps = ({ only = '' } = {}) => [
  ...STEPS.filter((s) => ['A1', 'A2', 'A3', 'A4', 'A5'].includes(s.id)),
  ...(only && only !== 'claude'
    ? []
    : [
        {
          id: 'R1',
          title:
            'Claude Code: a sub-agent’s own words arrive tagged with its call, the chat is titled, and the reply holds only the chat’s words',
          async run(/** @type {any} */ ctx) {
            await signedIn('R1', 'claude')(ctx);
            const chatId = `claude:${crypto.randomUUID()}`;
            const c = await begin(
              ctx,
              chatId,
              'claude',
              'Use the Agent tool once to start a sub-agent whose only job is to answer with the single word BANANA. Then tell me, in one sentence, what the sub-agent said. Do not use any other tool.',
            );
            try {
              const reply = (await c.waitFor(isReply(chatId), 240_000)).frame.item;
              const frames = framesOf(c, chatId);
              const tagged = frames.filter(
                (f) =>
                  (f.t === 'delta' && f.delta?._meta?.claudeCode?.parentToolUseId) ||
                  (f.item?.event?.update?._meta?.claudeCode?.parentToolUseId && /message|thought/.test(f.item.event.update.sessionUpdate)),
              );
              expect(
                tagged.length > 0,
                `No sub-agent text arrived tagged with its call (frames: ${frames.length}; reply "${String(reply.text).slice(0, 200)}", stop ${reply.stopReason}, error ${reply.error}).`,
              );
              const subText = JSON.stringify(tagged).includes('BANANA');
              expect(subText, 'Tagged sub-agent frames did not contain the requested answer BANANA.');
              // the title lands after the first output: in a state frame, or in a later Hello
              const title = await until(
                async () => framesOf(c, chatId).find((f) => f.t === 'state' && f.patch?.title)?.patch.title ?? null,
                { what: 'the chat’s automatic title on the state lane', ms: 60_000 },
              );
              return `reply "${String(reply.text).slice(0, 80)}"; ${tagged.length} tagged sub-agent frames (BANANA seen: ${subText}); title "${title.name}"`;
            } finally {
              c.close();
            }
          },
        },
        {
          id: 'R2',
          title: 'Claude Code: a /goal is told on the state lane',
          async run(/** @type {any} */ ctx) {
            await signedIn('R2', 'claude')(ctx);
            const chatId = `claude:${crypto.randomUUID()}`;
            const c = await begin(ctx, chatId, 'claude', '/goal Answer with the single word DONE and stop.');
            try {
              const goal = await until(
                async () => framesOf(c, chatId).find((f) => f.t === 'state' && f.patch && 'goal' in f.patch)?.patch.goal ?? null,
                {
                  what: 'a goal on the state lane',
                  ms: 180_000,
                  every: 1000,
                },
              );
              return `goal ${JSON.stringify(goal).slice(0, 160)}`;
            } finally {
              c.close();
            }
          },
        },
      ]),
  ...(only && only !== 'claude'
    ? []
    : [
        {
          id: 'R4',
          title: 'Claude Code: AskUserQuestion is a form question the person answers, and the answer reaches the agent (#4025)',
          async run(/** @type {any} */ ctx) {
            await signedIn('R4', 'claude')(ctx);
            const chatId = `claude:${crypto.randomUUID()}`;
            const c = await begin(
              ctx,
              chatId,
              'claude',
              'Use the AskUserQuestion tool once to ask me which colour I prefer, with the options red and blue. Then tell me the colour I picked in one word. Do not use any other tool.',
            );
            try {
              const q = await waitCard(c, chatId, ['question']);
              const id = q.question.id;
              expect(q.question.form?.fields?.length > 0, 'The question carried no form.');
              const key = q.question.form.fields[0].key;
              const choice = q.question.form.fields[0].options?.[0]?.value ?? 'red';
              await c.request('chat.answer', {
                chatId,
                epoch: 1,
                key: `ans-${crypto.randomUUID()}`,
                requestId: id,
                form: { action: 'accept', content: { [key]: choice } },
              });
              const reply = (await c.waitFor(isReply(chatId), 240_000)).frame.item;
              expect(
                String(reply.text).toLowerCase().includes(String(choice).toLowerCase()),
                `The reply did not name the choice "${choice}": "${String(reply.text).slice(0, 160)}".`,
              );
              return `question "${q.question.message}", answered ${choice}; reply "${String(reply.text).slice(0, 60)}"`;
            } finally {
              c.close();
            }
          },
        },
        {
          id: 'R5',
          title: 'Claude Code: a command card offers Always allow when the CLI suggests a rule, and the answer lets the call run (#4025)',
          async run(/** @type {any} */ ctx) {
            await signedIn('R5', 'claude')(ctx);
            const chatId = `claude:${crypto.randomUUID()}`;
            const proofFile = `host-stream-permission-${crypto.randomUUID()}.txt`;
            const c = await begin(
              ctx,
              chatId,
              'claude',
              `Run exactly this command with the Bash tool, then report its output: node -e "require('fs').writeFileSync('${proofFile}', 'stream-ok'); console.log('stream-ok')". Do not use any other tool.`,
            );
            try {
              const card = await waitCard(c, chatId, ['permission']);
              const ids = card.options.map((/** @type {any} */ o) => o.optionId);
              expect(
                ids.includes('allow_always'),
                `The card offered ${ids.join(', ')}; no Always allow although the CLI may suggest a rule.`,
              );
              await c.request('chat.answer', {
                chatId,
                epoch: 1,
                key: `ans-${crypto.randomUUID()}`,
                requestId: card.requestId,
                optionId: 'allow_always',
              });
              const reply = (await c.waitFor(isReply(chatId), 240_000)).frame.item;
              expect(String(reply.text).includes('stream-ok'), `The command did not run: "${String(reply.text).slice(0, 160)}".`);
              const proof = await ctx.m.run(`cat "${ctx.state.dataDir}/${proofFile}"`);
              expect(proof.code === 0 && proof.stdout === 'stream-ok', 'The approved command did not write its run-scoped proof file.');
              return `options ${ids.join('/')}; Always allow let the call run; reply "${String(reply.text).slice(0, 60)}"`;
            } finally {
              c.close();
            }
          },
        },
      ]),
  ...(only && only !== 'codex'
    ? []
    : [
        {
          id: 'R3',
          title: 'Codex: a command’s output streams while it runs and the finished call replaces it',
          async run(/** @type {any} */ ctx) {
            await signedIn('R3', 'codex')(ctx);
            const chatId = crypto.randomUUID();
            const c = await begin(
              ctx,
              chatId,
              'codex',
              'Run exactly this shell command and nothing else, then say "ended": for i in 1 2 3 4; do echo line$i; sleep 2; done',
            );
            try {
              const reply = (await c.waitFor(isReply(chatId), 240_000)).frame.item;
              const frames = framesOf(c, chatId);
              const live = frames.filter((f) => f.t === 'delta' && f.delta?.sessionUpdate === 'tool_output_delta');
              expect(live.length >= 2, `Only ${live.length} live output frames arrived while the command ran.`);
              const key = live[0].key;
              const promoted = frames.find((f) => f.t === 'durable' && f.promotes === key);
              expect(promoted, 'The finished call did not replace the live output (no durable promoted its key).');
              const at = (/** @type {any} */ f) => frames.indexOf(f);
              expect(at(live[0]) < at(promoted), 'The live output came after the finished call.');
              return `${live.length} live frames ("${live
                .map((f) => f.delta.text)
                .join('')
                .replace(/\n/g, '|')
                .slice(0, 60)}"), then the finished call; reply "${String(reply.text).slice(0, 40)}"`;
            } finally {
              c.close();
            }
          },
        },
      ]),
  ...(only && only !== 'claude'
    ? []
    : [
        {
          id: 'R6',
          title: 'Claude: real MCP form and inert URL elicitation round trip (#4001)',
          async run(ctx) {
            await signedIn('R6', 'claude')(ctx);
            return mcpCheck(ctx, { begin, waitCard, framesOf, isReply, root: ROOT });
          },
        },
      ]),
  {
    id: 'R7',
    title: 'Lost Host: production local ownership/inbox and real Codex handoff recall (#4003)',
    async run(ctx) {
      const harness = only === 'claude' ? 'claude' : 'codex';
      await signedIn('R7', harness)(ctx);
      await signedIn('R7 target', 'codex')(ctx);
      return lostHostCheck(ctx, { begin, framesOf, isReply, connect, harness });
    },
  },
];

/** Validate requested probes before any install: a typo or a family mismatch must never become a setup-only pass.
 * @param {{ only?: string, requested?: string }} o
 */
export function selectSteps({ only = '', requested } = {}) {
  if (!['', 'claude', 'codex'].includes(only)) throw new Error(`Unknown harness filter: ${only}`);
  const available = steps({ only });
  if (requested === undefined) return available;
  const ids = requested.split(',');
  if (ids.some((id) => !/^R[1-7]$/.test(id) || !available.some((s) => s.id === id)))
    throw new Error(`Unknown or unavailable probe for ${only || 'all families'}: ${requested}`);
  return available.filter((s) => s.id.startsWith('A') || ids.includes(s.id));
}

/** @param {string[]} argv */
export async function main(argv) {
  const get = (/** @type {string} */ flag) => {
    const value = argv[argv.indexOf(flag) + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    return value;
  };
  const vm = get('--vm');
  if (!vm) throw new Error('usage: node bench/host-stream2-real.mjs --vm <mopilot-*> [--only claude|codex] [--steps R1,R4,R5,R6,R7]');
  const selected = selectSteps({
    only: argv.includes('--only') ? get('--only') : '',
    requested: argv.includes('--steps') ? get('--steps') : undefined,
  });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-stream2-real-'));
  const ctx = {
    m: channelFor(/** @type {any} */ ({ vm, ssh: '', sshArgs: [] })),
    deps: realDeps(),
    root: ROOT,
    outDir,
    target: vm,
    nonce: path.basename(outDir).slice(-6),
    state: {},
  };
  let rows;
  try {
    rows = await runSteps({
      steps: selected,
      ctx,
    });
  } finally {
    await cleanup(ctx);
  }
  const report = formatReport({
    target: vm,
    rows,
    platform: /** @type {any} */ (ctx.state).platform,
    notVerified: [
      'Every probe not listed as PASS above; setup/sign-in status alone does not verify a model turn',
      'Remote mirror folding, GUI and SwitchRunner send; R7 drives production ownership/inbox then a VM-only Codex CLI consumer',
      'Mid-turn Host loss, Claude-source continuation unless R7 ran with --only claude, and images/compaction in real handoffs',
      'The app SSH tunnel, tool relay and browser pane; operating systems other than the one named above',
    ],
  });
  process.stdout.write(`${report}\n`);
  fs.rmSync(outDir, { recursive: true, force: true });
  return exitCode(rows);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`host-stream2-real: ${e.message}\n`);
      process.exitCode = 2;
    },
  );
