import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archivedClaudeMissing, mergeChatSearch, readAllPages } from '../src/lib/chatSearch.ts';

const t = (id: string, title: string, updatedAt: number, extra: object = {}) => ({ id, title, updatedAt, ...extra });
const base = { titleOf: (x: { title: string }) => x.title, limit: 20 };

test('local chats of every harness are searched by title; Codex hits do not replace them', () => {
  const local = [t('claude:a', 'Fix login bug', 5), t('c1', 'Codex login page', 4), t('acp:k:z', 'Other', 9)];
  const codex = [t('c1', 'Codex login page', 4), t('c2', 'Old login chat', 1)];
  const r = mergeChatSearch({ ...base, term: 'login', local, codex });
  assert.deepEqual(
    r.map((x) => x.id),
    ['claude:a', 'c1', 'c2'],
  );
});

test('title matches come before matches found inside a chat, then newest first', () => {
  const r = mergeChatSearch({
    ...base,
    term: 'needle',
    local: [t('a', 'has needle in title', 1)],
    claude: [t('claude:b', 'Something', 50)],
    codex: [t('c', 'Else', 60)],
    sage: [t('acp:k:d', 'Needle too', 2)],
  });
  assert.deepEqual(
    r.map((x) => x.id),
    ['acp:k:d', 'a', 'c', 'claude:b'],
  );
});

test('a chat found twice shows once; archived, temporary and side chats stay out', () => {
  const r = mergeChatSearch({
    ...base,
    term: 'x',
    local: [t('a', 'x one', 1), t('e', 'x eph', 3, { ephemeral: true })],
    claude: [t('a', 'x one', 1), t('claude:arch', 'x archived', 4), t('s', 'x side', 5, { parentThreadId: 'a' })],
    archived: { 'claude:arch': 1 },
  });
  assert.deepEqual(
    r.map((x) => x.id),
    ['a'],
  );
});

test('without a term it keeps the local order and caps at the limit', () => {
  const local = [t('b', 'B', 1), t('a', 'A', 9), t('c', 'C', 5)];
  assert.deepEqual(
    mergeChatSearch({ ...base, term: ' ', local, limit: 2 }).map((x) => x.id),
    ['b', 'a'],
  );
});

test('readAllPages walks past the first page, stops at a short page or the cap, and keeps rows when a later page fails', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => i);
  const page = async (o: number, n: number) => rows.slice(o, o + n);
  assert.equal((await readAllPages(page, 200, 5000)).length, 450);
  assert.equal((await readAllPages(page, 200, 300)).length, 300);
  let calls = 0;
  const flaky = async (o: number, n: number) => {
    if (++calls === 2) throw new Error('boom');
    return rows.slice(o, o + n);
  };
  const cut = { truncated: false };
  assert.equal((await readAllPages(flaky, 200, 5000, cut)).length, 200);
  assert.equal(cut.truncated, true);
  const whole = { truncated: false };
  await readAllPages(page, 200, 5000, whole);
  assert.equal(whole.truncated, false);
  await assert.rejects(
    readAllPages(
      async () => {
        throw new Error('first');
      },
      200,
      5000,
    ),
  );
});

test('archived Claude chats the session list did not return are the ones read from their files (D-38)', () => {
  const archived = { 'claude:a': 1, 'claude:b': 2, 'acp:k:z': 3, c1: 4 };
  const known = new Set(['claude:a']);
  assert.deepEqual(
    archivedClaudeMissing(archived, known, (id) => id.startsWith('claude:')),
    ['claude:b'],
  );
  assert.deepEqual(
    archivedClaudeMissing({}, known, () => true),
    [],
  );
});

test('pagination enforces its total cap even when a provider overfills the requested page', async () => {
  for (const length of [6, 250_000]) {
    let calls = 0;
    const rows = Array.from({ length }, (_, index) => index);
    const result = await readAllPages(
      async (offset, limit) => {
        calls++;
        assert.equal(offset, 0);
        assert.equal(limit, 2);
        return rows;
      },
      2,
      3,
    );
    assert.deepEqual(result, [0, 1, 2]);
    assert.equal(calls, 1);
  }
  assert.deepEqual(await readAllPages(async () => [], 200, 5000), []);
});

test('pagination preserves earlier rows and clips an oversized final page to the remaining cap', async () => {
  const requested: number[][] = [];
  const result = await readAllPages(
    async (offset, limit) => {
      requested.push([offset, limit]);
      return offset === 0 ? ['a', 'b'] : ['c', 'd', 'e'];
    },
    2,
    3,
  );
  assert.deepEqual(result, ['a', 'b', 'c']);
  assert.deepEqual(requested, [
    [0, 2],
    [2, 1],
  ]);
});

test('titleOnly keeps only chats whose title holds the term, as the @ list matches (#1931)', () => {
  const r = mergeChatSearch({
    ...base,
    term: 'calc',
    titleOnly: true,
    local: [t('a', 'Calculate reorder needs', 3), t('b', 'Unrelated', 9)],
    codex: [t('c', 'Found only inside', 60), t('d', 'calc.py bug', 2)],
  });
  assert.deepEqual(
    r.map((x) => x.id),
    ['a', 'd'],
  );
});

test("titleOnly matches the chat's own title, not the title of a part of a switched chat", () => {
  const segments = { chat: [{ nativeId: 'chat' }, { nativeId: 'claude:part' }] } as any;
  const known = { chat: t('chat', 'Renamed chat', 5) };
  const hit = [t('claude:part', 'calc part title', 5)];
  const run = (titleOnly: boolean) =>
    mergeChatSearch({ ...base, term: 'calc', titleOnly, local: [], claude: hit, segments, knownChats: known }).map((x) => x.id);
  assert.deepEqual(run(true), []);
  // the search palette still finds the chat by its part's title
  assert.deepEqual(run(false), ['chat']);
});
