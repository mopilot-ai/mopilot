// A Host killed hard mid-turn (kill -9) leaves neither children running nor chats running for ever: the next Host on the data dir ends the children it left (host/src/children.mjs), and ends the turns for the chats' clients as interrupted (host/src/runJournal.mjs). The Host here is a real process (tests/fixtures/host-recovery-driver.mjs) with a Codex app-server and an ACP agent as children.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCodex } from './support/hostCodexKit.ts';

const ROOT = path.join(import.meta.dirname, '..');
const DRIVER = path.join(ROOT, 'tests/fixtures/host-recovery-driver.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-kill-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => any, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** The driver Host as a process: the lines it prints as objects, and when it exits. */
function run(mode: string, dir: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [DRIVER, mode, dir], { env: { ...env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` } });
  const lines: any[] = [];
  let stderr = '';
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      // the driver's results are JSON lines; a note the code printed (an ignored error) is not one
      try {
        lines.push(JSON.parse(line));
      } catch {
        stderr += `${line}\n`;
      }
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, lines, exited, stderr: () => stderr };
}

test('I: a Host killed with SIGKILL mid-turn leaves its children and its turns; the next Host ends the children and ends the turns as interrupted', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'k-'));
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: {
        label: 'Fake',
        bin: process.execPath,
        args: [path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs')],
        env: { FAKE_ACP_STATE: path.join(dir, 's'), FAKE_STAY: '1' },
      },
    }),
  );
  // the Claude Code CLI the Host is told to use only has to exist: the SDK is a fake that starts its own stand-in through the harness's spawn
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n');
  const env = { ...installCodex(dir).env, FAKE_STAY: '1', MOPILOT_CLAUDE_BIN: path.join(dir, 'claude') };
  const first = run('start', dir, env);
  try {
    const ready = await until(() => first.lines.find((l) => l.ready), 20000).catch((e) => {
      throw new Error(`${e.message}: ${first.stderr()}`);
    });
    // a Codex app-server, an ACP agent and a Claude Code CLI, all started by this Host
    const labels = ready.children.map((c: any) => c.label).sort();
    assert.deepEqual(labels, ['codex', 'node', 'node']);
    const pids: number[] = ready.children.map((c: any) => c.pid);
    assert.ok(pids.every(alive));

    first.child.kill('SIGKILL');
    await first.exited;
    // nothing ended them: the Host that started them is gone
    assert.ok(pids.every(alive), 'the children outlive a Host killed hard');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'running.json'), 'utf8'))).length, 3);

    const second = run('restart', dir, env);
    const report = await until(() => second.lines.find((l) => l.recovered), 20000).catch((e) => {
      throw new Error(`${e.message}: ${second.stderr()}`);
    });
    await second.exited;
    assert.deepEqual([...report.recovered.ended].sort(), [...pids].sort());
    await until(() => pids.every((p) => !alive(p)), 5000);
    assert.equal(report.recovered.interrupted, 3);
    // a client that subscribes to either chat is told its turn was interrupted, not left running
    for (const chatId of ['cx-recover', 'acp:fake:recover', 'claude:6f1d1b0e-2c1a-4f6e-9a55-0d3f6a1b7c42']) {
      const items = report.snapshots[chatId].items;
      const end = items.find((i: any) => i.t === 'event' && i.event.kind === 'turnEnd');
      assert.equal(end.event.stopReason, 'cancelled');
      assert.match(end.event.error.message, /host stopped/);
      assert.equal(items.find((i: any) => i.t === 'assistant').stopReason, 'cancelled');
    }
    assert.equal(report.idle, true);
    // the journal and the registry now hold nothing of the dead run
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'running.json'), 'utf8')), {});
  } finally {
    first.child.kill('SIGKILL');
    for (const p of (first.lines.find((l) => l.ready)?.children ?? []).map((c: any) => c.pid)) {
      try {
        process.kill(-p, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});
