// The Host's data-dir lock (host/src/hostLock.mjs): a pid that now names another process no longer holds it, and a real second Host still does, also for the npm pid file that signals what it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startedAfterWriting } from '../host/src/children.mjs';
import { takeLock } from '../host/src/hostLock.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { startServer } from '../host/src/server.mjs';

const HOUR = 3_600_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-lock-'));
const paths = () => createPaths({ dataDir: tmp(), env: {} });

/** A lock file naming `pid`, written long ago (before a reboot, say). */
function oldLock(lockPath: string, pid: number) {
  fs.writeFileSync(lockPath, String(pid));
  const then = new Date(Date.now() - HOUR);
  fs.utimesSync(lockPath, then, then);
}

test('I: a lock whose pid now names an unrelated process, started after the lock was written, is replaced and that process is left alone', async (t) => {
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await new Promise((r) => other.once('spawn', r));
  const p = paths();
  oldLock(p.lockPath, other.pid!);
  const server = await startServer({ paths: p });
  assert.equal(fs.readFileSync(p.lockPath, 'utf8'), String(process.pid));
  assert.equal(other.exitCode, null);
  assert.equal(other.signalCode, null);
  await server.close();
});

test('I: a lock naming this very pid from before a reboot does not make the Host refuse itself', async () => {
  const p = paths();
  oldLock(p.lockPath, process.pid);
  await (await startServer({ paths: p })).close();
});

test('B: an empty lock (a crash between creating and writing it), or one naming no process, is replaced', async () => {
  for (const text of ['', '0', '-5']) {
    const p = paths();
    fs.writeFileSync(p.lockPath, text);
    await takeLock({ lockPath: p.lockPath, socketPath: p.socketPath });
    assert.equal(fs.readFileSync(p.lockPath, 'utf8'), String(process.pid));
  }
});

test('W: a real second Host is refused even when its lock looks old, because it answers on the socket', async (t) => {
  const p = paths();
  const server = await startServer({ paths: p });
  t.after(() => server.close());
  oldLock(p.lockPath, process.pid);
  await assert.rejects(startServer({ paths: p }), /Another Host \(pid \d+\) already uses/);
});

test('W: a holder that started before its lock was written holds it, also with no socket yet (a Host still starting)', async () => {
  const p = paths();
  fs.writeFileSync(p.lockPath, String(process.pid));
  await assert.rejects(takeLock({ lockPath: p.lockPath, socketPath: p.socketPath }), /already uses/);
});

test("I: a lock whose pid now names another user's process is replaced, not held for that process's life: the real core dates it", async () => {
  const p = paths();
  // init holds the number, and started after this lock from before it
  fs.writeFileSync(p.lockPath, '1');
  fs.utimesSync(p.lockPath, new Date(1000), new Date(1000));
  await takeLock({ lockPath: p.lockPath, socketPath: p.socketPath });
  assert.equal(fs.readFileSync(p.lockPath, 'utf8'), String(process.pid));
});

test('B: when the core cannot say when the holder started, the lock is held: a refused start is safer than two Hosts', async () => {
  const p = paths();
  oldLock(p.lockPath, process.pid);
  await assert.rejects(takeLock({ lockPath: p.lockPath, socketPath: p.socketPath, startOf: () => null }), /already uses/);
});

test('B: a socket that neither connects nor fails counts as a Host answering, and the wait is bounded', async () => {
  const p = paths();
  oldLock(p.lockPath, process.pid);
  const silent = new EventEmitter() as EventEmitter & { destroy: () => void };
  let destroyed = 0;
  silent.destroy = () => void destroyed++;
  await assert.rejects(
    takeLock({ lockPath: p.lockPath, socketPath: p.socketPath, connect: () => silent as any, answerMs: 5 }),
    /already uses/,
  );
  assert.equal(destroyed, 1);
});

test('A: a socket that connects is closed again and holds the lock', async (t) => {
  const p = paths();
  const listener = net.createServer((s) => s.destroy()).listen(p.socketPath);
  t.after(() => listener.close());
  await new Promise((r) => listener.once('listening', r));
  oldLock(p.lockPath, process.pid);
  await assert.rejects(takeLock({ lockPath: p.lockPath, socketPath: p.socketPath }), /already uses/);
});

test('A: another starter that took the lock during the socket check keeps it', async () => {
  const p = paths();
  oldLock(p.lockPath, process.pid);
  const failing = new EventEmitter() as EventEmitter & { destroy: () => void };
  failing.destroy = () => undefined;
  await assert.rejects(
    takeLock({
      lockPath: p.lockPath,
      socketPath: p.socketPath,
      connect: () => {
        // the other starter's lock lands while this one waits for the socket
        fs.rmSync(p.lockPath);
        fs.writeFileSync(p.lockPath, '4242');
        setImmediate(() => failing.emit('error', new Error('ECONNREFUSED')));
        return failing as any;
      },
    }),
    /already uses/,
  );
  assert.equal(fs.readFileSync(p.lockPath, 'utf8'), '4242');
});

test('I: startedAfterWriting allows for a clock stepping a little, and is false when the core cannot say', async () => {
  const written = 1_000_000;
  assert.equal(await startedAfterWriting(1, written, () => written + 1000), false);
  assert.equal(await startedAfterWriting(1, written, async () => written + 60_000), true);
  assert.equal(await startedAfterWriting(1, written, async () => null), false);
});
