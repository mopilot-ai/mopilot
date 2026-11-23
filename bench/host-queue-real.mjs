// Real-login proof that a message queued on a Host survives kill -9 (#4278 B) on a locked mopilot-* VM: a real Codex turn runs a slow command, a second message is queued behind it, the exact Host PID is killed, and the replacement Host holds the queued message, then sends it once after the chat's next turn.
// Acquire the VM's vmlock.sh lock before invocation; never run this against the user's Mac or change any login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { channelFor, realDeps, runSteps } from '../scripts/host-accept.mjs';
import { exitCode, formatReport } from '../scripts/host-accept/report.mjs';
import { STEPS, cleanup, expect, until } from '../scripts/host-accept/steps.mjs';
import { lineClient } from '../scripts/host-accept/wire.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (/** @type {string} */ name) => process.argv[process.argv.indexOf(name) + 1];
const vm = arg('--vm');
const evidence = arg('--out');
const harness = process.argv.includes('--harness') ? arg('--harness') : 'codex';
if (!process.argv.includes('--vm') || !/^mopilot-[\w-]+$/.test(vm) || !process.argv.includes('--out') || !evidence)
  throw new Error('usage: host-queue-real.mjs --vm mopilot-* --out <evidence-dir> [--harness codex|claude] (hold that VM lock)');
fs.mkdirSync(evidence, { recursive: true });
const ctx = {
  m: channelFor(/** @type {any} */ ({ vm, ssh: '', sshArgs: [] })),
  deps: realDeps(),
  root: ROOT,
  target: vm,
  outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'host-queue-real-')),
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
const frames = (/** @type {any} */ c, /** @type {string} */ chatId) =>
  c.events.filter((/** @type {any} */ e) => e.chatId === chatId && e.frame).map((/** @type {any} */ e) => e.frame);
/** The run-installed Host's PID, checked to be the Host. */
async function pid() {
  const info = await ctx.m.run('launchctl list ai.mopilot.host');
  const found = /"PID"\s*=\s*(\d+)/.exec(info.stdout)?.[1];
  expect(found && /^\d+$/.test(found), 'The run-installed service did not report its exact PID.');
  const command = await ctx.m.run(`ps -p ${found} -o command=`);
  expect(
    command.code === 0 && command.stdout.includes('mopilot-host.mjs') && command.stdout.includes('serve'),
    'PID does not belong to the installed Host.',
  );
  return /** @type {string} */ (found);
}

const step = {
  id: 'Q-restart',
  title: `A message queued behind a running real ${harness} turn survives kill -9 of the Host, is held by the next Host, and is sent once after the chat\u2019s next turn`,
  async run() {
    expect(ctx.state.os === 'Darwin', 'This verification uses the launchd service on a macOS VM.');
    const chatId = harness === 'claude' ? `claude:${crypto.randomUUID()}` : crypto.randomUUID();
    const marker = `queued-${crypto.randomUUID()}`;
    const c = await connect();
    await c.request('chat.subscribe', { chatId, epoch: 1 });
    await c.request('chat.start', {
      chatId,
      epoch: 1,
      harness,
      key: crypto.randomUUID(),
      text: 'Run exactly this shell command and nothing else, then say "ended": sleep 45',
      cwd: ctx.state.dataDir,
    });
    // the turn is running once its command's card is on the stream
    await c.waitFor((/** @type {any} */ e) => e.chatId === chatId && e.frame?.item?.event?.update?.sessionUpdate === 'tool_call', 120_000);
    const queued = await c.request('chat.send', {
      chatId,
      epoch: 1,
      key: crypto.randomUUID(),
      text: `Reply with exactly ${marker}. Do not use tools.`,
    });
    expect(
      queued.result?.action === 'queued',
      `The second message was not queued behind the turn: ${JSON.stringify(queued).slice(0, 300)}`,
    );
    const onDisk = await ctx.m.run(`ls "${ctx.state.dataDir}/queues" | wc -l`);
    expect(Number(onDisk.stdout.trim()) === 1, `The queued message is not on disk (${onDisk.stdout.trim()} files).`);
    const oldPid = await pid();
    const killed = await ctx.m.run(`kill -9 ${oldPid}`);
    expect(killed.code === 0, 'Could not kill the verified Host PID.');
    const newPid = await until(
      async () => {
        const current = await pid();
        return current !== oldPid ? current : null;
      },
      { what: 'a different launchd Host PID' },
    );
    const again = await until(async () => connect().catch(() => null), {
      what: 'the replacement Host accepting authenticated hello',
      ms: 60_000,
    });
    await again.request('chat.subscribe', { chatId, epoch: 1 });
    const repliesWith = (/** @type {string} */ text) =>
      frames(again, chatId)
        .flatMap((/** @type {any} */ f) => (f.t === 'hello' ? (f.snapshot?.items ?? []) : f.t === 'durable' ? [f.item] : []))
        .filter((/** @type {any} */ i) => i?.t === 'assistant' && String(i.text).includes(text));
    // held, as a queue is after a Stop: the restart itself sends nothing
    await new Promise((r) => setTimeout(r, 15_000));
    expect(repliesWith(marker).length === 0, 'The queued message ran by itself after the restart.');
    const held = await ctx.m.run(`ls "${ctx.state.dataDir}/queues" | wc -l`);
    expect(Number(held.stdout.trim()) === 1, 'The queued message is no longer on disk after the restart.');
    // the chat's next message runs, and the queued one follows it
    const next = `next-${crypto.randomUUID()}`;
    await again.request('chat.send', {
      chatId,
      epoch: 1,
      key: crypto.randomUUID(),
      text: `Reply with exactly ${next}. Do not use tools.`,
      cwd: ctx.state.dataDir,
    });
    await until(async () => repliesWith(next).length > 0 && repliesWith(marker).length > 0, {
      what: 'the next message’s reply and then the queued message’s',
      ms: 300_000,
      every: 1000,
    });
    // settle, then count: the message ran once
    await new Promise((r) => setTimeout(r, 5000));
    const fresh = await connect();
    await fresh.request('chat.subscribe', { chatId, epoch: 1 });
    const items = frames(fresh, chatId)[0].snapshot.items;
    const replies = items.filter((/** @type {any} */ i) => i?.t === 'assistant' && String(i.text).includes(marker));
    const order = items
      .filter((/** @type {any} */ i) => i?.t === 'assistant' && (String(i.text).includes(marker) || String(i.text).includes(next)))
      .map((/** @type {any} */ i) => (String(i.text).includes(next) ? 'next' : 'queued'));
    expect(order.join(',') === 'next,queued', `The replies came as ${order.join(',')}.`);
    const interrupted = items.filter((/** @type {any} */ i) => i?.t === 'assistant' && i.stopReason === 'cancelled');
    expect(replies.length === 1, `The queued message's reply appears ${replies.length} times.`);
    const left = await ctx.m.run(`ls "${ctx.state.dataDir}/queues" 2>/dev/null | wc -l`);
    expect(Number(left.stdout.trim()) === 0, 'A queue file remains after the queued message ran.');
    fs.writeFileSync(path.join(evidence, 'queue-after.json'), JSON.stringify({ oldPid, newPid, marker, items }, null, 2));
    return `Killed PID ${oldPid}; restarted PID ${newPid}; the first turn ended as interrupted (${interrupted.length}); nothing ran by itself for 15 s; after the next message the replies came next,queued, the queued one once; no queue file left.`;
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
    'A message taken off the queue in the instant before the crash; attachments; more than one queued message; Claude Code unless --harness claude was given.',
    'Any OS other than the named macOS VM; no login/account/model changes or user app launch.',
  ],
});
fs.writeFileSync(path.join(evidence, 'report.md'), report);
process.stdout.write(report);
process.exitCode = exitCode(rows);
