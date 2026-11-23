// A message waiting behind a turn is held by a spend limit and goes when the limit allows (host/src/sessions.mjs spendHeld, drainChat; plan U5): it is never dropped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
// @ts-ignore
import { createPaths } from '../host/src/paths.mjs';
// @ts-ignore
import { createHostSessions } from '../host/src/sessions.mjs';

const AGENT = path.join(import.meta.dirname, 'fixtures/fake-acp-agent.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-spend-queue-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('a limit keeps the next waiting message queued after the running turn ends, and raising it sends the message', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: {
        label: 'Fake',
        bin: process.execPath,
        args: [AGENT],
        env: { FAKE_ACP_STATE: path.join(dir, 's'), FAKE_ACP_LOG: path.join(dir, 'log') },
      },
    }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 5000 } });
  let held = false;
  const reports: string[] = [];
  const sessions = createHostSessions({ paths, env: {}, runtime, report: (m: string) => reports.push(m) });
  sessions.holdBy(() => held);
  try {
    const key = 'acp:fake:held';
    const ends: string[] = [];
    sessions.chatRuntime.host.on('event', (e: any) => e.kind === 'turnEnd' && ends.push(e.turnId));
    await sessions.chatRuntime.send({ key, text: 'SLOW first', cwd: dir });
    await until(() => sessions.state.snapshot(key).turn === 'running');
    assert.equal((await sessions.chatRuntime.send({ key, text: 'second' })).action, 'queued');
    held = true; // the running turn crossed the limit: it ends on its own terms
    sessions.chatRuntime.host.cancel(key); // the agent's turn waits for Stop
    await until(() => ends.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sessions.state.snapshot(key).queue.length, 1, 'the waiting message was not started over the limit, and was not lost');
    assert.equal(ends.length, 1);
    held = false;
    await sessions.drainChat(key);
    await until(() => ends.length === 2);
    assert.equal(sessions.state.snapshot(key).queue.length, 0);
    // a chat with nothing waiting has nothing to send
    await sessions.drainChat('acp:fake:nothing');
    assert.deepEqual(reports, []);
  } finally {
    sessions.close();
    runtime.close();
  }
});
