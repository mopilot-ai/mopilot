// Real-login proof that a failed turn leaves a Host with a typed code (#4278) on a locked mopilot-* VM: a real turn is started on a model that does not exist, the harness's own failure ends it, and the end carries `error.code`; a turn that succeeds on the same Host carries none. No login, account or default model is changed.
// Acquire the VM's vmlock.sh lock before invocation; never run this against the user's Mac or change any login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { channelFor, realDeps, runSteps } from '../scripts/host-accept.mjs';
import { exitCode, formatReport } from '../scripts/host-accept/report.mjs';
import { STEPS, cleanup, expect } from '../scripts/host-accept/steps.mjs';
import { lineClient } from '../scripts/host-accept/wire.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (/** @type {string} */ name) => process.argv[process.argv.indexOf(name) + 1];
const vm = arg('--vm');
const evidence = arg('--out');
const harness = process.argv.includes('--harness') ? arg('--harness') : 'codex';
if (!process.argv.includes('--vm') || !/^mopilot-[\w-]+$/.test(vm) || !process.argv.includes('--out') || !evidence)
  throw new Error('usage: host-error-code-real.mjs --vm mopilot-* --out <evidence-dir> [--harness codex|claude] (hold that VM lock)');
fs.mkdirSync(evidence, { recursive: true });
const ctx = {
  m: channelFor(/** @type {any} */ ({ vm, ssh: '', sshArgs: [] })),
  deps: realDeps(),
  root: ROOT,
  target: vm,
  outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'host-error-code-real-')),
  nonce: crypto.randomUUID().slice(0, 8),
  state: /** @type {any} */ ({}),
};
/** @type {ReturnType<typeof lineClient>[]} */
const clients = [];
async function connect() {
  const c = lineClient(ctx.m.open(`nc -U '${ctx.state.socket}'`), { timeoutMs: 120_000 });
  clients.push(c);
  await ctx.deps.authenticate(
    (/** @type {string} */ method, /** @type {object | undefined} */ params) => c.request(method, params),
    ctx.state.identity,
  );
  await c.request('host.hello', ctx.deps.helloParams());
  return c;
}
const step = {
  id: 'R-code',
  title: `A real ${harness} turn that fails for its model ends with a typed code, and one that succeeds has none`,
  async run() {
    const chatOf = () => (harness === 'claude' ? `claude:${crypto.randomUUID()}` : crypto.randomUUID());
    const c = await connect();
    /** Starts a chat and waits for its first turn's end. @param {object} pick @returns {Promise<{ end?: any, refused?: string }>} */
    const run = async (pick) => {
      const chatId = chatOf();
      await c.request('chat.subscribe', { chatId, epoch: 1 });
      const started = await c
        .request('chat.start', {
          chatId,
          epoch: 1,
          harness,
          key: crypto.randomUUID(),
          text: 'Reply with the single word: ok',
          cwd: ctx.state.dataDir,
          ...pick,
        })
        .then(
          () => null,
          (/** @type {any} */ e) => ({ refused: `${e?.code ?? ''} ${e?.message ?? e}`.trim() }),
        );
      if (started) return started;
      const end = await c.waitFor((/** @type {any} */ e) => e.chatId === chatId && e.frame?.item?.event?.kind === 'turnEnd', 240_000);
      return { end: end.frame.item.event };
    };
    const bad = await run({ model: 'mopilot-no-such-model-0' });
    fs.writeFileSync(path.join(evidence, 'failed-turn.json'), JSON.stringify(bad, null, 2));
    expect(bad.end, `The Host refused the start itself, so no turn failed: ${bad.refused}`);
    expect(
      bad.end.stopReason === 'error',
      `The turn on a model that does not exist did not fail: ${JSON.stringify(bad.end).slice(0, 300)}`,
    );
    expect(
      bad.end.error?.code === 'model_unavailable',
      `The failed turn's code is ${JSON.stringify(bad.end.error?.code)}, its message: ${String(bad.end.error?.message).slice(0, 400)}`,
    );
    const good = await run({});
    fs.writeFileSync(path.join(evidence, 'clean-turn.json'), JSON.stringify(good, null, 2));
    expect(
      good.end?.stopReason === 'end_turn' && good.end.error === undefined,
      `The clean turn did not end clean: ${JSON.stringify(good).slice(0, 300)}`,
    );
    return `The turn on a model that does not exist ended as error with code model_unavailable (“${String(bad.end.error.message).slice(0, 120)}”); a turn on the default model ended clean with no error.`;
  },
};

let rows;
try {
  rows = await runSteps({ steps: [...STEPS.filter((s) => ['A1', 'A2', 'A3', 'A4', 'A5'].includes(s.id)), step], ctx });
} finally {
  if (ctx.state.dataDir) {
    const log = await ctx.m.run(`tail -c 65536 '${path.join(ctx.state.dataDir, 'host.log')}'`);
    fs.writeFileSync(path.join(evidence, 'host-before-cleanup.log'), log.stdout);
  }
  clients.forEach((c) => c.close());
  fs.writeFileSync(path.join(evidence, 'artifact.json'), JSON.stringify(ctx.state.bundle ?? {}, null, 2));
  await cleanup(ctx);
}
const report = formatReport({
  target: vm,
  rows,
  platform: ctx.state.platform,
  notVerified: [
    'The codes rate_limit, auth and context on a real Host (they need a login that is out of quota, signed out or a full context: not produced here); the app half (unit tests); the other harness unless --harness names it; ACP agents.',
    'Any OS other than the named macOS VM; no login/account/model changes or user app launch.',
  ],
});
fs.writeFileSync(path.join(evidence, 'report.md'), report);
process.stdout.write(report);
process.exitCode = exitCode(rows);
