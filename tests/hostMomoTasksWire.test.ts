// The wire method for what is not an intent (host.momoTasks): the tasks as the clients draw them, a new task, a new watch, and resuming a paused watch; who may call it, and what it takes from a client. (shared/host/methods/momoTasks.mjs, host/src/methods/momoTasks.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import wire from '../shared/host/methods/momoTasks.mjs';
// @ts-ignore
import hostMethods from '../host/src/methods/momoTasks.mjs';
import { ask, tasksWorld } from './support/host/momoTasksWorld.ts';

const desktop = { kind: 'desktop' };
const kit = {
  bad: (m: string) => new Error(m),
  matchOf: (v: unknown, re: RegExp, m: string) => {
    if (typeof v === 'string' && re.test(v)) return v;
    throw new Error(m);
  },
};
const parse = wire(kit).methods['host.momoTasks'].parse;

test('the wire method takes only what a client may name', () => {
  const bads: [object, RegExp][] = [
    [{ op: 'nothing' }, /not something to do with a task/],
    [{ op: 'resume' }, /not a task id/],
    [{ op: 'create', title: '', doneMeans: 'x' }, /not a title/],
    [{ op: 'create', title: 'x', doneMeans: 'y'.repeat(1001) }, /not what done means/],
    [{ op: 'create', title: 'x', doneMeans: 'y', where: { machineId: 'm1' } }, /not an agent/],
    [{ op: 'createWatch', title: 'x', doneMeans: 'y', watch: [] }, /not something to watch/],
  ];
  for (const [p, re] of bads) assert.throws(() => parse(p), re, JSON.stringify(p));
  assert.deepEqual(parse({ op: 'create', title: 'x', doneMeans: 'y', where: { machineId: 'm1', harness: 'claude' }, extra: 1 }), {
    op: 'create',
    title: 'x',
    doneMeans: 'y',
    where: { machineId: 'm1', harness: 'claude' },
  });
  assert.deepEqual(parse({ op: 'view', extra: 1 }), { op: 'view' });
  assert.deepEqual(parse({ op: 'resume', id: 't1' }), { op: 'resume', id: 't1' });
});

test('only the owner of a granted home may call it, and a refusal of the tasks keeps its words and code', async (t) => {
  const w = await tasksWorld(t);
  const host = hostMethods({ momo: w.home });
  const veil = host.veils['host.momoTasks'];
  assert.deepEqual([veil(desktop), veil({ kind: 'phone' }), veil({ kind: 'cli' }), veil(null)], [true, true, false, false]);
  assert.equal(hostMethods({}).veils['host.momoTasks'](desktop), false);
  await assert.rejects(
    host.handlers['host.momoTasks']({ op: 'resume', id: 'nope' }),
    (e: any) => e.code === 'unknown_item' && /No such task/.test(e.message),
  );
  // anything that is not a refusal is not hidden
  w.home.service = () => ({ view: async () => Promise.reject(new TypeError('boom')) });
  await assert.rejects(host.handlers['host.momoTasks']({ op: 'view' }), /boom/);
});

test('a client reads the tasks, starts one, watches a page, and a resume of what is not paused is refused', async (t) => {
  const w = await tasksWorld(t);
  const host = hostMethods({ momo: w.home });
  const call = (p: object) => host.handlers['host.momoTasks'](parse(p));
  assert.deepEqual((await call({ op: 'view' })).tasks, []);
  const made = await call({ op: 'create', title: ask.title, doneMeans: ask.doneMeans });
  assert.equal(made.item.origin, 'asked');
  const watch = await call({
    op: 'createWatch',
    title: 'Status page',
    doneMeans: 'Tell me when it changes',
    watch: { kind: 'http', url: 'https://status.example.com/x', everyMinutes: 5 },
  });
  assert.equal(watch.item.state, 'watching');
  assert.deepEqual((await call({ op: 'view' })).tasks.map((v: any) => v.state).sort(), ['watching', 'working']);
  await assert.rejects(call({ op: 'resume', id: watch.item.id }), /not a paused watch/);
  await w.tasks.stop(watch.item.id);
  assert.equal((await call({ op: 'resume', id: watch.item.id })).state, 'watching');
});
