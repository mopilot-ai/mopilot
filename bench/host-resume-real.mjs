// Real-login proof that a turn a Host restart cut off can be carried on in the same native session (#4278 B) on a locked mopilot-* VM: a real turn is told a code word and starts a slow command, the exact Host PID is killed, the replacement Host ends the turn saying what was cut off, and the next message is answered from the same session (it knows the code word).
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
  throw new Error('usage: host-resume-real.mjs --vm mopilot-* --out <evidence-dir> [--harness codex|claude] (hold that VM lock)');
fs.mkdirSync(evidence, { recursive: true });
const ctx = {
  m: channelFor(/** @type {any} */ ({ vm, ssh: '', sshArgs: [] })),
  deps: realDeps(),
  root: ROOT,
  target: vm,
  outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'host-resume-real-')),
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
  id: 'R-resume',
  title: `A real ${harness} turn cut off by kill -9 of the Host says what was interrupted, and the next message runs on the same native session`,
  async run() {
    expect(ctx.state.os === 'Darwin', 'This verification uses the launchd service on a macOS VM.');
    const chatId = harness === 'claude' ? `claude:${crypto.randomUUID()}` : crypto.randomUUID();
    const word = `word-${crypto.randomUUID().slice(0, 8)}`;
    // a command each agent runs: Claude Code refuses a bare sleep, Codex declines the python one
    const slow = harness === 'claude' ? 'python3 -c "import time; time.sleep(45)"' : 'sleep 45';
    const c = await connect();
    await c.request('chat.subscribe', { chatId, epoch: 1 });
    await c.request('chat.start', {
      chatId,
      epoch: 1,
      harness,
      key: crypto.randomUUID(),
      text: `The code word of this conversation is ${word}. Run exactly this shell command and nothing else, then say "ended": ${slow}`,
      cwd: ctx.state.dataDir,
    });
    const started = await c.waitFor(
      (/** @type {any} */ e) => e.chatId === chatId && e.frame?.item?.event?.update?.sessionUpdate === 'tool_call',
      120_000,
    );
    const turnId = started.frame.item.event.turnId;
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
    const items = () =>
      frames(again, chatId).flatMap((/** @type {any} */ f) =>
        f.t === 'hello' ? (f.snapshot?.items ?? []) : f.t === 'durable' ? [f.item] : [],
      );
    const end = items()
      .map((/** @type {any} */ i) => i.event)
      .find((/** @type {any} */ e) => e?.kind === 'turnEnd' && e.turnId === turnId);
    // kept whether or not the checks below pass: what the journal holds of the turn
    fs.writeFileSync(
      path.join(evidence, 'turn-items.json'),
      JSON.stringify(
        items().filter((/** @type {any} */ i) => i?.event?.turnId === turnId || i?.turnId === turnId),
        null,
        2,
      ),
    );
    expect(end, 'The replacement Host did not end the turn it found running.');
    expect(
      end.stopReason === 'cancelled' && end.interrupted?.by === 'host_restart',
      `The turn's end does not say the restart cut it off: ${JSON.stringify(end).slice(0, 300)}`,
    );
    // the names are the calls the journal shows started and not ended at the kill (a call that had already failed or finished is not one)
    /** @type {Map<string, string>} */
    const open = new Map();
    for (const item of items()) {
      const update = item?.event?.turnId === turnId ? item.event.update : null;
      // the cards the replacement Host closed itself are what it found running, not an end the agent reported
      if (typeof update?.toolCallId !== 'string' || update._meta?.mopilot?.settled) continue;
      if (update.status === 'completed' || update.status === 'failed') open.delete(update.toolCallId);
      else open.set(update.toolCallId, String(update.title ?? open.get(update.toolCallId)));
    }
    expect(
      JSON.stringify(end.interrupted.running) === JSON.stringify([...open.values()]),
      `The end names ${JSON.stringify(end.interrupted.running)}, the journal shows ${JSON.stringify([...open.values()])} still running.`,
    );
    // what Retry does: one more message to the same chat; its answer needs the first turn's memory
    await again.request('chat.send', {
      chatId,
      epoch: 1,
      key: crypto.randomUUID(),
      text: 'What is the code word of this conversation, given in my first message? Reply with the word only. Do not use tools.',
      cwd: ctx.state.dataDir,
    });
    await until(
      async () => items().some((/** @type {any} */ i) => i?.t === 'assistant' && i.turnId !== turnId && (i.error || String(i.text).trim())),
      { what: 'the reply to the message after the restart', ms: 300_000, every: 1000 },
    );
    const reply = items().findLast((/** @type {any} */ i) => i?.t === 'assistant' && i.turnId !== turnId);
    expect(
      !reply.error && String(reply.text).includes(word),
      `The session did not carry on: ${String(reply.error ?? reply.text).slice(0, 300)}`,
    );
    fs.writeFileSync(path.join(evidence, 'resume-after.json'), JSON.stringify({ oldPid, newPid, word, end, reply }, null, 2));
    return `Killed PID ${oldPid}; restarted PID ${newPid}; the turn ended as interrupted by host_restart naming ${JSON.stringify(end.interrupted.running)}; the next message recalled the code word from the same session.`;
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
    'The app half (the failed turn and its Retry button; covered by the fake-Host spec); the other harness unless --harness names it; ACP agents.',
    'Any OS other than the named macOS VM; no login/account/model changes or user app launch.',
  ],
});
fs.writeFileSync(path.join(evidence, 'report.md'), report);
process.stdout.write(report);
process.exitCode = exitCode(rows);
