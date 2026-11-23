// Real-login durable-journal proof on a locked mopilot-* VM: two native turns, kill -9 the exact Host PID, then a second device reads history and resumes.
// Acquire the VM's vmlock.sh lock before invocation; never run this against the user's Mac or change any login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { channelFor, realDeps, runSteps } from '../scripts/host-accept.mjs';
import { STEPS, cleanup, expect, until } from '../scripts/host-accept/steps.mjs';
import { lineClient } from '../scripts/host-accept/wire.mjs';
import { formatReport, exitCode } from '../scripts/host-accept/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const vm = value('--vm');
const evidence = value('--out');
const retire = process.argv.includes('--retire');
if (!process.argv.includes('--vm') || !/^mopilot-[\w-]+$/.test(vm) || !process.argv.includes('--out') || !evidence)
  throw new Error('usage: host-journal-real.mjs --vm mopilot-* --out <evidence-dir> (hold that VM lock)');
fs.mkdirSync(evidence, { recursive: true });
const ctx = {
  m: channelFor(/** @type {any} */ ({ vm, ssh: '', sshArgs: [] })),
  deps: realDeps(),
  root: ROOT,
  target: vm,
  outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'host-journal-real-')),
  nonce: crypto.randomUUID().slice(0, 8),
  state: /** @type {any} */ ({}),
};
const saved = [];
const clients = [];
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
async function saveHostLog(name) {
  if (!ctx.state.dataDir) return;
  const log = await ctx.m.run(`tail -c 65536 ${quote(path.join(ctx.state.dataDir, 'host.log'))}`);
  fs.writeFileSync(path.join(evidence, name), log.stdout + '\n[read exit=' + log.code + '] ' + log.stderr);
}
async function connect() {
  const c = lineClient(ctx.m.open(`nc -U '${ctx.state.socket}'`), { timeoutMs: 120_000 });
  clients.push(c);
  await ctx.deps.authenticate((method, params) => c.request(method, params), ctx.state.identity);
  await c.request('host.hello', ctx.deps.helloParams());
  return c;
}
const frames = (c, chatId) => c.events.filter((e) => e.chatId === chatId && e.frame).map((e) => e.frame);
async function pid() {
  const info = await ctx.m.run('launchctl list ai.mopilot.host');
  const found = /"PID"\s*=\s*(\d+)/.exec(info.stdout)?.[1];
  expect(found && /^\d+$/.test(found), 'The run-installed service did not report its exact PID.');
  const command = await ctx.m.run(`ps -p ${found} -o command=`);
  expect(
    command.code === 0 && command.stdout.includes('mopilot-host.mjs') && command.stdout.includes('serve'),
    'PID does not belong to the installed Host.',
  );
  return found;
}
const probes = ['claude', 'codex'].map((harness) => ({
  id: `J-${harness}`,
  title: `Real ${harness} turn commits before Host restart`,
  async run() {
    const c = await connect();
    const chatId = harness === 'claude' ? `claude:${crypto.randomUUID()}` : crypto.randomUUID();
    const marker = `durable-${crypto.randomUUID()}`;
    await c.request('chat.subscribe', { chatId, epoch: 1 });
    await c.request('chat.start', {
      chatId,
      epoch: 1,
      harness,
      key: crypto.randomUUID(),
      text: `Reply with exactly ${marker}. Do not use tools.`,
      cwd: ctx.state.dataDir,
    });
    const reply = (await c.waitFor((e) => e.chatId === chatId && e.frame?.item?.t === 'assistant', 180_000)).frame.item;
    expect(
      !reply.error && reply.text.includes(marker),
      `Minimal quota/turn probe failed: ${String(reply.error ?? reply.text).slice(0, 350)}`,
    );
    const other = await connect();
    await other.request('chat.subscribe', { chatId, epoch: 1 });
    const hello = frames(other, chatId)[0];
    saved.push({ harness, chatId, marker, hello });
    fs.writeFileSync(path.join(evidence, `${harness}-before.json`), JSON.stringify({ hello, frames: frames(c, chatId) }, null, 2));
    return `Native reply ${marker}; rev ${hello.rev}, seq ${hello.seq}, generation ${hello.generation}`;
  },
}));
const restart = {
  id: 'J-restart',
  title: 'Kill the exact Host PID, restart, and open both chats from new connections',
  async run() {
    expect(saved.length > 0, 'No real model turn passed; no restart acceptance is claimed.');
    expect(ctx.state.os === 'Darwin', 'This verification uses the launchd service on a macOS VM.');
    if (retire) {
      for (const { harness, chatId } of saved) {
        const c = await connect();
        const request = { chatId, epoch: 1, key: crypto.randomUUID() };
        expect((await c.request('chat.remove', request)).result.removed === true, `${harness}: retirement was not acknowledged.`);
        expect(
          (await c.request('chat.remove', request)).replayed === true,
          `${harness}: retirement did not retain its idempotent receipt.`,
        );
      }
    }
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
    // A new PID may precede listen: preserve every failure and elapsed time rather than hiding recovery stalls.
    const pidSeenAt = Date.now();
    const attempts = [];
    try {
      await until(
        async () => {
          const startedMs = Date.now() - pidSeenAt;
          try {
            const ready = await connect();
            ready.close();
            attempts.push({ startedMs, endedMs: Date.now() - pidSeenAt, ok: true });
            return true;
          } catch (error) {
            attempts.push({ startedMs, endedMs: Date.now() - pidSeenAt, ok: false, code: error.code ?? null, message: error.message });
            return null;
          } finally {
            fs.writeFileSync(
              path.join(evidence, 'restart-attempts.json'),
              JSON.stringify({ oldPid, newPid, pidSeenAt, firstHelloMs: attempts.find((a) => a.ok)?.endedMs ?? null, attempts }, null, 2),
            );
          }
        },
        { what: 'the replacement Host accepting authenticated hello', ms: 60_000 },
      );
    } finally {
      await saveHostLog('host-after-restart.log');
    }
    for (const { harness, chatId, marker, hello } of saved) {
      const c = await connect();
      if (retire) {
        for (const method of ['chat.subscribe', 'chat.send']) {
          let refused = false;
          try {
            await c.request(method, { chatId, epoch: 1, key: crypto.randomUUID(), text: 'must not revive' });
          } catch (error) {
            refused = error.code === 'session_journal_deleted';
          }
          expect(refused, `${harness}: ${method} revived a retired chat after restart.`);
        }
        const root = path.join(ctx.state.dataDir, 'sessions', crypto.createHash('sha256').update(chatId).digest('hex'));
        const removed = await ctx.m.run(`test -f ${quote(root + '.deleted')} && test ! -e ${quote(root)}`);
        expect(removed.code === 0, `${harness}: a retired journal directory remains after acknowledged deletion.`);
        fs.writeFileSync(path.join(evidence, `${harness}-after.json`), JSON.stringify({ oldPid, newPid, deleted: true, marker }, null, 2));
        continue;
      }
      await c.request('chat.subscribe', { chatId, epoch: 1 });
      const recovered = frames(c, chatId)[0];
      expect(JSON.stringify(recovered.snapshot) === JSON.stringify(hello.snapshot), `${harness}: committed history changed after restart.`);
      expect(recovered.generation === hello.generation && recovered.seq >= hello.seq, `${harness}: cursor numbering changed or rewound.`);
      expect(recovered.inFlightEphemeral.length === 0, 'Transient deltas were replayed after a restart.');
      const resumed = await connect();
      await resumed.request('chat.subscribe', { chatId, epoch: 1, fromRev: 0, generation: hello.generation });
      const tail = frames(resumed, chatId);
      expect(tail[0].snapshot === null && tail.slice(1).length === hello.rev, 'The persisted durable tail could not resume.');
      expect(
        tail.slice(1).every((f) => f.t === 'durable'),
        'Resume included a transient frame.',
      );
      fs.writeFileSync(path.join(evidence, `${harness}-after.json`), JSON.stringify({ oldPid, newPid, recovered, tail, marker }, null, 2));
    }
    return `Killed PID ${oldPid}; restarted PID ${newPid}; authenticated hello ${attempts.find((a) => a.ok)?.endedMs}ms after new PID, ${attempts.filter((a) => !a.ok).length} refused/closed attempts recorded; ${saved.length} real chats ${retire ? 'remain tombstoned; subscribe/send refused and journal directories absent' : 'retain history/cursors; second-client snapshots and durable-only resume verified'}.`;
  },
};
let rows;
try {
  rows = await runSteps({ steps: [...STEPS.filter((s) => ['A1', 'A2', 'A3', 'A4', 'A5'].includes(s.id)), ...probes, restart], ctx });
} finally {
  await saveHostLog('host-before-cleanup.log');
  clients.forEach((c) => c.close());
  fs.writeFileSync(path.join(evidence, 'artifact.json'), JSON.stringify(ctx.state.bundle ?? {}, null, 2));
  await cleanup(ctx);
}
const report = formatReport({
  target: vm,
  rows,
  platform: ctx.state.platform,
  notVerified: [
    'Any real harness turn reported FAIL above (quota/auth failure is not a pass).',
    'Mid-turn native resume, durable Host queue, side-effect intent recovery, GUI/mirror folding and large-history pagination.',
    'Any OS other than the named macOS VM; no login/account/model changes or user app launch.',
  ],
});
fs.writeFileSync(path.join(evidence, 'report.md'), report);
process.stdout.write(report);
process.exitCode = exitCode(rows);
