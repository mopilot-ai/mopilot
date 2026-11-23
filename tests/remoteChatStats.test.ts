// The "+N −M" in a phone's chat list: summed from Git once per folder, reused briefly, never waited on for long, and left out when it cannot be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { createChatStats, TTL_MS, FAILED_TTL_MS, MAX_FOLDERS } = require('../electron/remote/review/chatStats.cjs');

const numstat = (...files: [number, number, string][]) => files.map(([a, r, f]) => `${a}\t${r}\t${f}\0`).join('');

function git(replies: Record<string, string | null>) {
  const calls: string[] = [];
  const run = async (_cmd: string, args: string[], o: { cwd: string }) => {
    calls.push(`${o.cwd}: ${args.join(' ')}`);
    const out = replies[o.cwd];
    return out === null || out === undefined ? { ok: false, stdout: '', stderr: 'fatal' } : { ok: true, stdout: out, stderr: '' };
  };
  return { run, calls };
}
const cwds: Record<string, string | null> = { a: '/repo', b: '/repo', c: '/other', d: null, e: '/plain' };

test('a chat gets the lines its folder changed since the last commit, and chats in one folder share one read', async () => {
  const g = git({ '/repo': numstat([3, 1, 'a.ts'], [4, 0, 'b.ts'], [0, 0, 'bin.png']), '/other': '' });
  const stats = createChatStats({ run: g.run, cwdOf: async (id: string) => cwds[id] });
  const found = await stats.statsFor(['a', 'b', 'c']);
  assert.deepEqual(
    [...found],
    [
      ['a', { added: 7, removed: 1 }],
      ['b', { added: 7, removed: 1 }],
      ['c', { added: 0, removed: 0 }],
    ],
  );
  assert.equal(g.calls.filter((c) => c.startsWith('/repo:')).length, 1, 'one read for the folder');
  assert.match(g.calls[0], /--no-optional-locks diff HEAD .*--numstat -z/, 'a list read never takes the index lock');
});

test('a folder is read again only after the numbers are old', async () => {
  let t = 1000;
  const g = git({ '/repo': numstat([1, 1, 'a.ts']) });
  const stats = createChatStats({ run: g.run, cwdOf: async () => '/repo', now: () => t });
  await stats.statsFor(['a']);
  t += TTL_MS - 1;
  await stats.statsFor(['a']);
  assert.equal(g.calls.length, 1);
  t += 1;
  await stats.statsFor(['a']);
  assert.equal(g.calls.length, 2);
});

test('a chat with no folder, a folder that fails, or a lookup that throws is left out, never an error', async () => {
  const g = git({ '/repo': numstat([1, 0, 'a.ts']), '/plain': null });
  const stats = createChatStats({
    run: g.run,
    cwdOf: async (id: string) => {
      if (id === 'x') throw new Error('gone');
      return cwds[id];
    },
  });
  const found = await stats.statsFor(['a', 'd', 'e', 'x']);
  assert.deepEqual([...found.keys()], ['a']);
});

test('a folder Git is slow for does not hold the list: it is left out now and has its numbers next time', async () => {
  let release: (v: { ok: boolean; stdout: string; stderr: string }) => void = () => {};
  const slow = new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => (release = resolve));
  const run = async (_c: string, _a: string[], o: { cwd: string }) =>
    o.cwd === '/slow' ? slow : { ok: true, stdout: numstat([2, 2, 'f']), stderr: '' };
  const stats = createChatStats({ run, cwdOf: async (id: string) => (id === 's' ? '/slow' : '/repo') });
  const first = await stats.statsFor(['s', 'a'], 20);
  assert.deepEqual([...first.keys()], ['a']);
  release({ ok: true, stdout: numstat([5, 0, 'g']), stderr: '' });
  const next = await stats.statsFor(['s', 'a'], 500);
  assert.deepEqual(next.get('s'), { added: 5, removed: 0 });
});

test('the folders remembered are bounded', async () => {
  const g = git({});
  let n = 0;
  const run = async (c: string, a: string[], o: { cwd: string }) => {
    n++;
    return g.run(c, a, o);
  };
  const stats = createChatStats({ run, cwdOf: async (id: string) => `/f${id}` });
  const ids = Array.from({ length: MAX_FOLDERS + 1 }, (_, i) => String(i));
  await stats.statsFor(ids, 5000);
  const before = n;
  await stats.statsFor(['0'], 5000);
  assert.ok(n > before, 'the oldest folder was forgotten when the bound was reached');
});

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const all = [
  { id: 'c0', title: 'One', harness: 'codex', at: 10, project: null },
  { id: 'c1', title: 'Two', harness: 'claude', at: 9, project: null },
];

test('chats.recent adds `changes` to the chats the Mac has numbers for, and nothing for the others', async () => {
  const asked: string[][] = [];
  const r = rig({
    ops: {
      recent: async () => all,
      review: {
        statsFor: async (ids: string[]) => (asked.push(ids), new Map([['c0', { added: 4, removed: 2 }]])),
      },
    },
  });
  const page = ok(await r.phone('p1').ask('chats.recent', { limit: 10 }));
  assert.deepEqual(asked, [['c0', 'c1']]);
  assert.ok(Math.abs(page.now - Date.now()) < 5000, 'the Mac says what time it is, for a phone whose clock differs');
  assert.deepEqual(page.chats[0].changes, { added: 4, removed: 2 });
  assert.equal('changes' in page.chats[1], false);
});

test('chats.recent still answers where the Mac reads no numbers', async () => {
  const none = ok(
    await rig({ ops: { recent: async () => all } })
      .phone('p1')
      .ask('chats.recent', { limit: 10 }),
  );
  assert.equal('changes' in none.chats[0], false);
  const plain = ok(
    await rig({ ops: { recent: async () => all, review: {} } })
      .phone('p1')
      .ask('chats.recent', { limit: 10 }),
  );
  assert.equal('changes' in plain.chats[0], false);
});

test('a folder Git cannot answer for is asked about again only after a longer wait', async () => {
  let t = 1000;
  const g = git({ '/plain': null });
  const stats = createChatStats({ run: g.run, cwdOf: async () => '/plain', now: () => t });
  assert.equal((await stats.statsFor(['e'])).size, 0);
  await new Promise((r) => setImmediate(r));
  const calls = g.calls.length;
  t += TTL_MS + 1;
  await stats.statsFor(['e']);
  assert.equal(g.calls.length, calls, 'not on the ordinary wait');
  t += FAILED_TTL_MS;
  await stats.statsFor(['e']);
  assert.ok(g.calls.length > calls);
});
