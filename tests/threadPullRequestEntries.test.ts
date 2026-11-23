// A chat's PRs as the sidebar badge counts and lists them (src/lib/threadPullRequest.ts, #1581): every attached PR and
// every PR its replies identified, the latest first, at most MAX_ENTRIES, each with GitHub's line counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestReader, MAX_ENTRIES, MAX_LISTED } from '../src/lib/threadPullRequest.ts';

const url = 'https://github.com/org/repo/pull/42';
const attachment = (url: string, createdAt = 1) => ({
  id: String(createdAt),
  attachmentType: 'pull_request',
  identityKey: url,
  payload: { url },
  createdAt,
});
const page = (data: ReturnType<typeof attachment>[] = []) => ({ data, nextCursor: null });

test('a chat with several PRs lists them all, latest first, with GitHub’s line counts (#1581)', async () => {
  const gh: string[] = [];
  const read = createPullRequestReader({
    head: async () => null,
    legacy: async () => null,
    attachments: async () => page([attachment(url, 1), attachment(url.replace('42', '43'), 5), attachment(url.replace('42', '41'), 2)]),
    responses: async () => [
      { status: 'completed', items: [{ type: 'agentMessage', text: `Opened [PR #50](${url.replace('42', '50')}).` }] },
      // a PR the reply only cites is not the chat's
      { status: 'completed', items: [{ type: 'agentMessage', text: `Upstream fixed this first: ${url.replace('42', '60')}` }] },
      // the attached #43 reported again: listed once
      { status: 'completed', items: [{ type: 'agentMessage', text: `Merged PR #43: ${url.replace('42', '43')}` }] },
    ],
    gh: async (link) => {
      gh.push(link!);
      const n = Number(link!.split('/').at(-1));
      // #41 has no counts; #42 has a malformed one
      const counts = n === 41 ? {} : n === 42 ? { additions: -1, deletions: 2 } : { additions: n, deletions: 1 };
      return { ok: true, stdout: JSON.stringify({ state: 'OPEN', title: `PR ${n}`, ...counts }) };
    },
  });
  const pr = await read('chat');
  assert.deepEqual(
    pr?.entries?.map((e) => [e.number, e.additions, e.deletions]),
    [
      // attached newest first (#43 at 5, #41 at 2, #42 at 1), then the one only a reply identified
      [43, 43, 1],
      [41, undefined, undefined],
      [42, undefined, undefined],
      [50, 50, 1],
    ],
  );
  assert.equal(pr?.number, 43);
  assert.deepEqual(gh.sort(), [url.replace('42', '41'), url, url.replace('42', '43'), url.replace('42', '50')].sort());
});

test('an unreadable attached PR uses its own report when a different repo reports the same number later', async () => {
  const other = 'https://github.com/org/other/pull/42';
  const read = createPullRequestReader({
    attachments: async () => page([attachment(url)]),
    head: async () => null,
    legacy: async () => null,
    responses: async () => [
      { status: 'completed', items: [{ type: 'agentMessage', text: `Merged [PR #42](${url}).` }] },
      { status: 'completed', items: [{ type: 'agentMessage', text: `Opened [PR #42](${other}).` }] },
    ],
    gh: async () => ({ ok: false, stdout: '' }),
  });
  const pr = await read('chat');
  assert.equal(pr?.state, 'merged');
  const statuses = [
    [url, 'merged', 'response'],
    [other, 'open', 'response'],
  ];
  assert.deepEqual(
    pr?.entries?.map((entry) => [entry.url, entry.state, entry.source]),
    statuses,
  );
  assert.deepEqual(
    (await read.listed('chat', 'v')).map((entry) => [entry.url, entry.state, entry.source]),
    statuses,
  );
});

test('a chat’s badge reads at most MAX_ENTRIES PRs, and lists a PR GitHub could not answer for with unknown status', async () => {
  const many = Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => attachment(url.replace('42', String(100 + i)), 100 + i));
  const read = createPullRequestReader({
    head: async () => null,
    legacy: async () => null,
    attachments: async () => page(many),
    gh: async (link) => ({ ok: true, stdout: JSON.stringify({ state: 'MERGED', url: link }) }),
  });
  const pr = await read('chat');
  assert.equal(pr?.entries?.length, MAX_ENTRIES);
  assert.equal(pr?.number, 100 + MAX_ENTRIES + 2);
  // a failing status read still lists the PR, with unknown status
  const flaky = createPullRequestReader({
    head: async () => null,
    legacy: async () => null,
    attachments: async () => page([attachment(url, 2), attachment(url.replace('42', '43'), 1)]),
    gh: async (link) => (link === url ? { ok: true, stdout: JSON.stringify({ state: 'OPEN' }) } : { ok: false, stdout: '' }),
  });
  assert.deepEqual((await flaky('chat'))?.entries, [
    { url, number: 42, state: 'open' },
    { url: url.replace('42', '43'), number: 43, state: 'unknown' },
  ]);
});

test('a merged PR is read from GitHub once, even by a fresh read; an open one is read again', async () => {
  const gh: string[] = [];
  const read = createPullRequestReader({
    head: async () => null,
    legacy: async () => null,
    attachments: async () => page([attachment(url, 2), attachment(url.replace('42', '43'), 1)]),
    gh: async (link) => {
      gh.push(link!);
      return { ok: true, stdout: JSON.stringify({ state: link === url ? 'OPEN' : 'MERGED' }) };
    },
  });
  await read('chat', '', true);
  await read('chat', '', true);
  await read('chat', '', true);
  // the merged #43 once; the open #42 on every fresh read of the chat's own PR
  assert.deepEqual(gh, [url, url.replace('42', '43'), url, url]);
});

test('the chat’s other open PRs refresh on the cache’s minute, not on every fresh read of its own PR', async () => {
  const gh: string[] = [];
  let at = 0;
  const read = createPullRequestReader({
    now: () => at,
    head: async () => null,
    legacy: async () => null,
    attachments: async () => page([attachment(url, 2), attachment(url.replace('42', '43'), 1)]),
    gh: async (link) => (gh.push(link!), { ok: true, stdout: JSON.stringify({ state: 'OPEN' }) }),
  });
  await read('chat', '', true);
  await read('chat', '', true);
  assert.deepEqual(gh, [url, url.replace('42', '43'), url]);
  at = 61_000;
  await read('chat', '', true);
  assert.deepEqual(gh, [url, url.replace('42', '43'), url, url, url.replace('42', '43')]);
});

test('the inbox lists up to MAX_LISTED of a chat, apart from what a badge knows, and one PR or none reads plainly', async () => {
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  const replies: Record<string, unknown[]> = {
    many: Array.from({ length: MAX_LISTED + 5 }, (_, i) => ({
      status: 'completed',
      items: [{ type: 'agentMessage', text: `Opened [PR #${i + 1}](${url(i + 1)}).` }],
    })),
    one: [{ status: 'completed', items: [{ type: 'agentMessage', text: `Opened [PR #900](${url(900)}).` }] }],
    none: [],
  };
  const read = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => null,
    gh: async (link) => ({ ok: true, stdout: JSON.stringify({ url: link, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' }) }),
    responses: async (id) => replies[id] as never,
  });
  const many = await read.listed('many', 'v');
  assert.equal(many.length, MAX_LISTED);
  assert.ok(MAX_LISTED > MAX_ENTRIES);
  assert.equal(read.known('many', '', 'v'), undefined);
  assert.equal(((await read('many', '', false, 'v'))?.entries ?? []).length, MAX_ENTRIES);
  assert.deepEqual(
    (await read.listed('one', 'v')).map((pr) => pr.number),
    [900],
  );
  assert.deepEqual(await read.listed('none', 'v'), []);
});
