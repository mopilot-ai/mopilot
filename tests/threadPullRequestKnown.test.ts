// A chat's last settled PR, which a menu or remounted row shows at once: scoped to its folder and history version,
// and never replaced by an older read that settles late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestReader } from '../src/lib/threadPullRequest.ts';

const link = (n: number) => `https://github.com/org/repo/pull/${n}`;
const pending: { resolve: (n: number | null) => void; reject: (error: Error) => void }[] = [];
const reader = () =>
  createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => 'topic',
    gh: () =>
      new Promise((resolve, reject) =>
        pending.push({
          resolve: (n) => resolve({ ok: true, stdout: JSON.stringify(n === null ? null : { url: link(n), state: 'OPEN' }) }),
          reject,
        }),
      ),
  });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the last settled read is known for its own chat, folder and version only', async () => {
  pending.length = 0;
  const read = reader();
  assert.equal(read.known('chat', '/work', 'v1'), undefined, 'nothing is known before a read settles');
  const first = read('chat', '/work', true, 'v1');
  await settle();
  assert.equal(read.known('chat', '/work', 'v1'), undefined, 'a pending read is not known');
  pending[0].resolve(1);
  assert.equal((await first)?.url, link(1));
  assert.equal(read.known('chat', '/work', 'v1')?.url, link(1));
  for (const [id, cwd, version] of [
    ['other', '/work', 'v1'],
    ['chat', '/other', 'v1'],
    ['chat', '/work', 'v2'],
    ['chat', '/work', undefined],
  ] as const)
    assert.equal(read.known(id, cwd, version), undefined, `${id} ${cwd} ${version}`);
  // a settled "no PR" is known too, so the menu shows none
  const none = read('fresh-chat', '/fresh', true, 'v1');
  await settle();
  pending[1].resolve(null);
  await none;
  assert.equal(read.known('fresh-chat', '/fresh', 'v1'), null);
  assert.equal(read.known('chat'), undefined, 'defaults name no folder or version');
});

test('an older read settling after a newer one cannot replace what is known', async () => {
  pending.length = 0;
  const read = reader();
  // a chat moved to another folder: reads of different folders do not share GitHub work, so they can cross
  const older = read('chat', '/old', true, 'v1');
  await settle();
  const newer = read('chat', '/new', true, 'v2');
  await settle();
  pending[1].resolve(2);
  await newer;
  pending[0].resolve(1);
  await older;
  assert.equal(read.known('chat', '/new', 'v2')?.url, link(2));
  assert.equal(read.known('chat', '/old', 'v1'), undefined);
  // in the other order the newer read still wins
  const a = read('chat', '/a', true, 'v3');
  await settle();
  const b = read('chat', '/b', true, 'v4');
  await settle();
  pending[2].resolve(3);
  await a;
  assert.equal(read.known('chat', '/a', 'v3')?.url, link(3));
  pending[3].resolve(4);
  await b;
  assert.equal(read.known('chat', '/b', 'v4')?.url, link(4));
  assert.equal(read.known('chat', '/a', 'v3'), undefined);
});

test('with a maximum age, a settled read older than that is not known, and one exactly that old is (#2963)', async () => {
  pending.length = 0;
  let clock = 1000;
  const read = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => 'topic',
    gh: async () => ({ ok: true, stdout: JSON.stringify({ url: link(7), state: 'OPEN' }) }),
    now: () => clock,
  });
  await read('chat', '/work', true, 'v1');
  clock += 60_000;
  assert.equal(read.known('chat', '/work', 'v1', 60_000)?.url, link(7));
  clock += 1;
  assert.equal(read.known('chat', '/work', 'v1', 60_000), undefined);
  assert.equal(read.known('chat', '/work', 'v1')?.url, link(7), 'without a maximum age it is known however old');
});
