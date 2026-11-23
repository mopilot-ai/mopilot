// The Host's fake Codex app-server speaks goals as the real one does, so a goal round-trip through a Host is exercised end to end (tests/fixtures/fake-codex-app-server.mjs, used by the e2e Host): `thread/goal/set` answers with the goal and tells `thread/goal/updated`, an active goal that was not running starts a turn of its own, an edit keeps the status, and `thread/goal/clear` tells `thread/goal/cleared`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { waitFor } from './support/waitFor.ts';

const FAKE = path.resolve(import.meta.dirname, 'fixtures/fake-codex-app-server.mjs');

/** The fake over its stdin and stdout: `ask` sends a request and resolves its answer, `seen` is every line it wrote. */
function server(t: { after: (fn: () => void) => void }) {
  const child = spawn(process.execPath, [FAKE, 'app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const seen: any[] = [];
  const waiting = new Map<number, (r: any) => void>();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    seen.push(msg);
    if (msg.id !== undefined && msg.method === undefined) waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const ask = (method: string, params: object = {}) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const until = (fn: () => unknown) => waitFor(fn, 'the fake to say it');
  return { ask, seen, until };
}
const methods = (s: { seen: any[] }) => s.seen.filter((m) => m.method).map((m) => m.method);

test('A goal set on a thread is answered, told to every client and worked on by a turn of its own; the turn waits to be interrupted when the objective says slow', async (t) => {
  const s = server(t);
  const { result } = await s.ask('thread/start', { cwd: '/work' });
  const threadId = result.thread.id;
  assert.deepEqual((await s.ask('thread/goal/get', { threadId })).result, { goal: null });
  const set = (await s.ask('thread/goal/set', { threadId, objective: 'make it SLOW', status: 'active' })).result.goal;
  assert.deepEqual([set.objective, set.status, set.tokenBudget], ['make it SLOW', 'active', null]);
  await s.until(() => methods(s).includes('turn/started'));
  const told = s.seen.find((m) => m.method === 'thread/goal/updated');
  assert.deepEqual([told.params.threadId, told.params.goal.objective], [threadId, 'make it SLOW']);
  // the turn is still running: nothing ended it, and an interrupt does
  assert.ok(!methods(s).includes('turn/completed'));
  assert.deepEqual((await s.ask('thread/goal/get', { threadId })).result.goal.status, 'active');
  await s.ask('turn/interrupt', { threadId, turnId: 'x' });
  await s.until(() => s.seen.some((m) => m.method === 'turn/completed' && m.params.turn.status === 'interrupted'));
});

test('A paused goal stays paused through an edit and a budget, resuming runs a turn again, and clearing tells it once', async (t) => {
  const s = server(t);
  const threadId = (await s.ask('thread/start', { cwd: '/work' })).result.thread.id;
  // an objective that is not slow is worked on and finished by its turn
  await s.ask('thread/goal/set', { threadId, objective: 'tidy up', status: 'active' });
  await s.until(() => s.seen.some((m) => m.method === 'turn/completed'));
  const paused = (await s.ask('thread/goal/set', { threadId, status: 'paused' })).result.goal;
  assert.equal(paused.status, 'paused');
  const turns = () => methods(s).filter((m) => m === 'turn/started').length;
  const before = turns();
  const edited = (await s.ask('thread/goal/set', { threadId, objective: 'tidy up more', tokenBudget: 5000 })).result.goal;
  assert.deepEqual(
    [edited.objective, edited.status, edited.tokenBudget, edited.createdAt],
    ['tidy up more', 'paused', 5000, paused.createdAt],
  );
  assert.equal(turns(), before, 'a paused goal starts no turn');
  assert.equal((await s.ask('thread/goal/set', { threadId, status: 'active' })).result.goal.status, 'active');
  await s.until(() => turns() === before + 1);
  assert.deepEqual((await s.ask('thread/goal/clear', { threadId })).result, { cleared: true });
  await s.until(() => methods(s).includes('thread/goal/cleared'));
  assert.deepEqual((await s.ask('thread/goal/clear', { threadId })).result, { cleared: false });
  assert.deepEqual((await s.ask('thread/goal/get', { threadId })).result, { goal: null });
  assert.equal(methods(s).filter((m) => m === 'thread/goal/cleared').length, 1);
});
