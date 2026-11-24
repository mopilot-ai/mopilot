import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestReader, legacyPullRequests, pullRequestUrl } from '../src/lib/threadPullRequest.ts';

const url = 'https://github.com/org/repo/pull/42';
const attachment = (url: string, createdAt = 1, attachmentType = 'pull_request') => ({
  id: String(createdAt),
  attachmentType,
  identityKey: url,
  payload: { url },
  createdAt,
});
const page = (data: ReturnType<typeof attachment>[] = [], nextCursor: string | null = null) => ({ data, nextCursor });
const desktop = (records: unknown[]) =>
  JSON.stringify({ 'electron-persisted-atom-state': { 'pull-request-attachment-records-v3': records } });

test('PR URLs are canonicalized and unsafe or unrelated links are ignored', () => {
  assert.equal(pullRequestUrl(url + '/?tab=files#top'), url);
  for (const bad of [
    null,
    'javascript:alert(1)',
    'https://github.com.evil.test/org/repo/pull/42',
    'https://user@github.com/org/repo/pull/42',
    'https://github.com/org/repo/issues/42',
    'https://github.com/org/repo/pull/0',
    'http://github.com/org/repo/pull/42',
  ])
    assert.equal(pullRequestUrl(bad), null);
});

test('legacy links are scoped to the local conversation and ordered by last touch', () => {
  const text = desktop([
    {
      conversationId: 'chat',
      hostId: 'local',
      attachments: [
        { url, touchedAt: 1 },
        { url: url.replace('42', '43'), touchedAt: 2 },
      ],
    },
    { conversationId: 'remote', hostId: 'remote-host', attachments: [{ url }] },
    { conversationId: 'bad', hostId: 'local', attachments: [null, { url: 'javascript:alert(1)' }] },
  ]);
  assert.deepEqual({ ...legacyPullRequests(text) }, { chat: [url.replace('42', '43'), url] });
  assert.deepEqual(legacyPullRequests('broken JSON'), {});
  assert.deepEqual({ ...legacyPullRequests(null) }, {});
});

test('app-server attachments take precedence, including the newest PR on later pages', async () => {
  const calls: unknown[] = [];
  const read = createPullRequestReader({
    head: async () => 'topic',
    attachments: async (id, cursor) => {
      calls.push([id, cursor]);
      return cursor
        ? page([attachment(url.replace('42', '43'), 3)])
        : page([attachment(url), attachment(url.replace('42', '99'), 4, 'worktree')], 'next');
    },
    legacy: async () => {
      assert.fail('core attachments should not read desktop state');
    },
    gh: async (link) => {
      calls.push(link);
      return { ok: true, stdout: JSON.stringify({ state: 'MERGED', title: 'Fix' }) };
    },
  });
  const newest = { url: url.replace('42', '43'), number: 43, state: 'merged', title: 'Fix' };
  // the newest attached PR leads; both attached PRs are the chat's, so both are its entries (#1581)
  assert.deepEqual(await read('chat'), { ...newest, entries: [newest, { url, number: 42, state: 'merged', title: 'Fix' }] });
  assert.deepEqual(calls, [['chat', null], ['chat', 'next'], url.replace('42', '43'), url]);
});

test('older servers fall back to saved attachments without guessing from the current branch', async () => {
  const read = createPullRequestReader({
    head: async () => 'topic',
    attachments: async () => {
      throw new Error('Method not found');
    },
    legacy: async () => desktop([{ conversationId: 'old-chat', hostId: 'local', attachments: [{ url }] }]),
    gh: async () => ({ ok: false, stdout: '' }),
  });
  assert.equal(await read('unrelated-chat'), null);
  assert.deepEqual(await read('old-chat'), { url, number: 42, state: 'unknown' });
});

for (const [state, isDraft, expected] of [
  ['OPEN', false, 'open'],
  ['OPEN', true, 'draft'],
  ['MERGED', true, 'merged'],
  ['CLOSED', true, 'closed'],
  ['unexpected', false, 'unknown'],
] as const) {
  test(`GitHub ${state}, draft=${isDraft} produces ${expected}`, async () => {
    const read = createPullRequestReader({
      head: async () => 'topic',
      attachments: async () => page([attachment(url)]),
      legacy: async () => null,
      gh: async () => ({ ok: true, stdout: JSON.stringify({ state, isDraft }) }),
    });
    assert.equal((await read('chat'))?.state, expected);
  });
}

test('coalesces GitHub and legacy reads across rows, then refreshes after a minute', async () => {
  let now = 0,
    githubReads = 0,
    legacyReads = 0;
  let state = 'OPEN';
  const read = createPullRequestReader({
    head: async () => 'topic',
    now: () => now,
    attachments: async () => page(),
    legacy: async () => {
      legacyReads++;
      return desktop(['a', 'b'].map((conversationId) => ({ conversationId, hostId: 'local', attachments: [{ url }] })));
    },
    gh: async () => {
      githubReads++;
      return { ok: true, stdout: JSON.stringify({ state }) };
    },
  });
  await Promise.all([read('a'), read('b')]);
  assert.equal(githubReads, 1);
  assert.equal(legacyReads, 1);
  state = 'MERGED';
  now = 60_001;
  assert.equal((await read('a'))?.state, 'merged');
  assert.equal(githubReads, 2);
  assert.equal(legacyReads, 2);
});

test('malformed GitHub output and failures preserve the link with unknown status', async () => {
  for (const gh of [
    async () => ({ ok: true, stdout: 'not JSON' }),
    async () => {
      throw new Error('offline');
    },
  ]) {
    const read = createPullRequestReader({
      head: async () => 'topic',
      attachments: async () => page([attachment(url)]),
      legacy: async () => null,
      gh,
    });
    assert.equal((await read('chat'))?.state, 'unknown');
  }
});

test('GitHub lookups run at most three at once and queued requests complete', async () => {
  let active = 0,
    maximum = 0;
  const read = createPullRequestReader({
    head: async () => 'topic',
    attachments: async (id) => page([attachment(url.replace('42', id))]),
    legacy: async () => null,
    gh: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { ok: true, stdout: '{"state":"OPEN"}' };
    },
  });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => read(String(i + 1))));
  assert.equal(maximum, 3);
  assert.equal(active, 0);
  assert.equal(results.length, 10);
  assert.ok(results.every((pr) => pr?.state === 'open'));
});

test('legacy records tolerate missing timestamps and malformed local records', () => {
  const records = [
    null,
    { hostId: 'local', conversationId: 42, attachments: [] },
    { hostId: 'local', conversationId: 'missing' },
    { hostId: 'local', conversationId: 'chat', attachments: [{ url }, { url: url.replace('42', '43') }] },
  ];
  assert.deepEqual({ ...legacyPullRequests(desktop(records)) }, { chat: [url, url.replace('42', '43')] });
  assert.deepEqual({ ...legacyPullRequests('null') }, {});
  assert.deepEqual(
    {
      ...legacyPullRequests(
        desktop([{ hostId: 'local', conversationId: 'newest', attachments: [{ url }, { url: url.replace('42', '43'), touchedAt: 10 }] }]),
      ),
    },
    { newest: [url.replace('42', '43'), url] },
  );
});

test('attachment payloads must be objects with safe links and repeated cursors terminate', async () => {
  const cursors: (string | null)[] = [];
  const read = createPullRequestReader({
    head: async () => 'topic',
    attachments: async (_, cursor) => {
      cursors.push(cursor);
      return {
        data: [null, [], 'bad', { url: 'not a URL' }].map((payload, i) => ({ ...attachment(url, i), payload })) as any,
        nextCursor: 'repeat',
      };
    },
    legacy: async () => {
      throw new Error('desktop state unreadable');
    },
    gh: async () => {
      assert.fail('invalid links must not reach GitHub');
    },
  });
  assert.equal(await read('chat'), null);
  assert.deepEqual(cursors, [null, 'repeat']);
});

test('PR URLs reject passwords and non-default ports', () => {
  assert.equal(pullRequestUrl('https://user:password@github.com/org/repo/pull/42'), null);
  assert.equal(pullRequestUrl('https://github.com:8443/org/repo/pull/42'), null);
});

test('an unattached branch PR refreshes from open to merged without waiting for the cache TTL', async () => {
  const calls: unknown[] = [];
  let state = 'OPEN';
  const read = createPullRequestReader({
    head: async () => 'topic',
    now: () => 0,
    attachments: async () => page(),
    legacy: async () => null,
    gh: async (link, cwd) => {
      calls.push([link, cwd]);
      return { ok: true, stdout: JSON.stringify({ url, state, title: 'Branch PR' }) };
    },
  });
  assert.equal((await read('chat', '/worktree'))?.state, 'open');
  state = 'MERGED';
  assert.equal((await read('chat', '/worktree', true))?.state, 'merged');
  assert.deepEqual(calls, [
    [null, '/worktree'],
    [null, '/worktree'],
  ]);
});

test('attached PR status refresh bypasses a settled cache but coalesces fresh in-flight reads', async () => {
  const { deferred } = await import('./support/async-scenarios.ts');
  const request = deferred<{ ok: boolean; stdout: string }>();
  let calls = 0;
  const read = createPullRequestReader({
    head: async () => 'topic',
    now: () => 0,
    attachments: async () => page([attachment(url)]),
    legacy: async () => null,
    gh: async () => (++calls === 1 ? { ok: true, stdout: '{"state":"OPEN"}' } : request.promise),
  });
  assert.equal((await read('chat'))?.state, 'open');
  assert.equal((await read('chat'))?.state, 'open');
  const first = read('chat', '', true);
  const second = read('other-chat', '', true);
  request.resolve({ ok: true, stdout: '{"state":"MERGED"}' });
  assert.deepEqual(
    (await Promise.all([first, second])).map((pr) => pr?.state),
    ['merged', 'merged'],
  );
  assert.equal(calls, 2);
});

test('branch caches coalesce the same cwd, isolate folders including delimiters, and retry failures', async () => {
  const calls: string[] = [];
  let fail = true;
  const read = createPullRequestReader({
    head: async () => 'topic',
    now: () => 0,
    attachments: async () => page(),
    legacy: async () => null,
    gh: async (_, cwd) => {
      calls.push(cwd);
      if (fail) throw new Error('offline');
      return { ok: true, stdout: JSON.stringify({ url: url.replace('42', cwd === '/a:b' ? '43' : '44'), state: 'MERGED' }) };
    },
  });
  assert.deepEqual(await Promise.all([read('a', '/a:b'), read('b', '/a:b')]), [null, null]);
  assert.deepEqual(calls, ['/a:b']);
  fail = false;
  const results = await Promise.all([read('a', '/a:b', true), read('a:b', '/a', true)]);
  assert.deepEqual(
    results.map((pr) => pr?.number),
    [43, 44],
  );
  assert.deepEqual(calls, ['/a:b', '/a:b', '/a']);
});

test('branch lookup validates boundary data and retains only safe links with explicit unknown status', async () => {
  for (const response of [
    { ok: false, stdout: '' },
    ...['broken', 'null', '[]', '"text"', '{}', '{"url":42}', '{"url":"javascript:alert(1)"}'].map((stdout) => ({ ok: true, stdout })),
  ]) {
    const read = createPullRequestReader({
      head: async () => 'topic',
      attachments: async () => page(),
      legacy: async () => null,
      gh: async () => response,
    });
    assert.equal(await read('chat', '/repo'), null, response.stdout);
  }
  for (const payload of [{ url }, { url, state: 42, title: 5 }, { url, state: 'OPEN', isDraft: 'false' }]) {
    const read = createPullRequestReader({
      head: async () => 'topic',
      attachments: async () => page(),
      legacy: async () => null,
      gh: async () => ({ ok: true, stdout: JSON.stringify(payload) }),
    });
    assert.equal((await read('chat', '/repo'))?.state, 'unknown');
  }
});

test('an attached PR remains authoritative when its worktree is deleted or points at another branch', async () => {
  for (const stdout of ['null', '[]', '42', '{"state":42}', '{"state":"MERGED","url":"https://evil.test"}']) {
    const read = createPullRequestReader({
      head: async () => 'topic',
      attachments: async () => page([attachment(url)]),
      legacy: async () => null,
      gh: async (link, cwd) => {
        assert.equal(link, url);
        assert.equal(cwd, '');
        return { ok: true, stdout };
      },
    });
    assert.equal((await read('chat', '/deleted'))?.url, url);
  }
});

test('a branch switch in the same cwd does not coalesce with the retired branch read', async () => {
  const { deferred } = await import('./support/async-scenarios.ts');
  for (const reject of [false, true]) {
    const old = deferred<{ ok: boolean; stdout: string }>();
    let head = 'old';
    const read = createPullRequestReader({
      head: async () => head,
      attachments: async () => page(),
      legacy: async () => null,
      gh: async (_, cwd, branch) => {
        assert.equal(cwd, '/repo');
        return branch === 'old' ? old.promise : { ok: true, stdout: JSON.stringify({ url, state: 'MERGED' }) };
      },
    });
    const retired = read('chat', '/repo');
    await new Promise((resolve) => setImmediate(resolve));
    head = 'new';
    assert.equal((await read('chat', '/repo', true))?.state, 'merged');
    if (reject) old.reject(new Error('retired failure'));
    else old.resolve({ ok: true, stdout: JSON.stringify({ url: url.replace('42', '41'), state: 'OPEN' }) });
    assert.equal(await retired, null);
    assert.equal((await read('chat', '/repo'))?.state, 'merged');
  }
});

test('detached, missing or unreadable worktrees never guess a branch PR', async () => {
  for (const head of [
    async () => null,
    async () => {
      throw new Error('missing worktree');
    },
  ]) {
    const read = createPullRequestReader({
      head,
      attachments: async () => page(),
      legacy: async () => null,
      gh: async () => assert.fail('no current branch'),
    });
    assert.equal(await read('chat', '/deleted'), null);
  }
});

test('a failed branch refresh keeps the known safe PR link with unavailable status, then recovers', async () => {
  let fail = false;
  const read = createPullRequestReader({
    head: async () => 'topic',
    attachments: async () => page(),
    legacy: async () => null,
    gh: async () => (fail ? { ok: false, stdout: '' } : { ok: true, stdout: JSON.stringify({ url, state: 'MERGED' }) }),
  });
  assert.equal((await read('chat', '/repo'))?.state, 'merged');
  fail = true;
  assert.deepEqual(await read('chat', '/repo', true), { url, number: 42, state: 'unknown' });
  fail = false;
  assert.equal((await read('chat', '/repo', true))?.state, 'merged');
});

test('a failed post-lookup HEAD recheck is observed and a later refresh can retry', async () => {
  let calls = 0;
  const read = createPullRequestReader({
    head: async () => {
      if (++calls === 2) throw new Error('worktree removed during gh');
      return 'topic';
    },
    attachments: async () => page(),
    legacy: async () => null,
    gh: async () => ({ ok: true, stdout: JSON.stringify({ url, state: 'MERGED' }) }),
  });
  assert.equal(await read('chat', '/repo'), null);
  assert.equal((await read('chat', '/repo', true))?.state, 'merged');
});

test('completed response reports keep a PR visible when GitHub and its old worktree are unavailable', async () => {
  const read = createPullRequestReader({
    attachments: async () => page(),
    legacy: async () => null,
    head: async () => null,
    responses: async () => [{ status: 'completed', items: [{ type: 'agentMessage', text: `Merged [PR #42](${url}) into main.` }] }],
    gh: async () => ({ ok: false, stdout: '' }),
  });
  assert.deepEqual(await read('chat'), { url, number: 42, state: 'merged', source: 'response' });
});

test('GitHub status overrides a reported status, while malformed output falls back only for the matching PR', async () => {
  for (const output of [
    { ok: true, stdout: JSON.stringify({ state: 'OPEN', title: 'Verified' }) },
    { ok: true, stdout: 'broken JSON' },
    { ok: true, stdout: JSON.stringify({ state: 7 }) },
  ]) {
    const read = createPullRequestReader({
      attachments: async () => page([attachment(url)]),
      legacy: async () => null,
      head: async () => null,
      responses: async () => [{ status: 'completed', items: [{ type: 'agentMessage', text: 'PR #42 is merged.' }] }],
      gh: async () => output,
    });
    assert.equal((await read('chat'))?.state, output.stdout.includes('Verified') ? 'open' : 'merged');
    assert.equal((await read('chat'))?.source, output.stdout.includes('Verified') ? undefined : 'response');
  }
  const read = createPullRequestReader({
    attachments: async () => page([attachment(url)]),
    legacy: async () => null,
    head: async () => null,
    responses: async () => [{ status: 'completed', items: [{ type: 'agentMessage', text: `Merged PR #43. ${url.replace('42', '43')}` }] }],
    gh: async () => ({ ok: false, stdout: '' }),
  });
  // the attached PR keeps its own unknown status; the reported one is listed beside it with its reported state
  const attached = { url, number: 42, state: 'unknown' };
  assert.deepEqual(await read('chat'), {
    ...attached,
    entries: [attached, { url: url.replace('42', '43'), number: 43, state: 'merged', source: 'response' }],
  });
});

test('a branch-discovered PR can use a short response report after GitHub becomes unavailable', async () => {
  let available = true;
  const read = createPullRequestReader({
    attachments: async () => page(),
    legacy: async () => null,
    head: async () => 'topic',
    responses: async () => [{ status: 'completed', items: [{ type: 'agentMessage', text: 'PR #42 is merged.' }] }],
    gh: async () => ({ ok: available, stdout: JSON.stringify({ url, state: 'OPEN' }) }),
  });
  assert.equal((await read('chat', '/repo', true))?.state, 'open');
  available = false;
  assert.deepEqual(await read('chat', '/repo', true), { url, number: 42, state: 'merged', source: 'response' });
});

test('response history failures preserve GitHub discovery and remain retryable without caching inferred status across chats', async () => {
  let failing = true;
  const read = createPullRequestReader({
    attachments: async () => page([attachment(url)]),
    legacy: async () => null,
    head: async () => null,
    responses: async (id) => {
      if (failing) throw new Error('history unavailable');
      return [
        {
          status: 'completed',
          items: [{ type: 'agentMessage', text: id === 'merged' ? 'PR #42 is merged.' : 'PR #42 is not merged yet.' }],
        },
      ];
    },
    gh: async () => {
      throw new Error('offline');
    },
  });
  assert.equal((await read('merged'))?.state, 'unknown');
  failing = false;
  assert.equal((await read('merged'))?.state, 'merged');
  assert.equal((await read('queued'))?.state, 'open');
});

test("a message's PR link reads one PR's status through the chats' cache, and a merged PR is read once", async () => {
  let now = 0;
  const reads: (string | null)[] = [];
  const pullRequest = { url, state: 'OPEN', title: 'Fix it', mergeCommit: { oid: 'a'.repeat(40) } };
  const read = createPullRequestReader({
    head: async () => null,
    now: () => now,
    attachments: async () => page([attachment(url)]),
    legacy: async () => null,
    gh: async (link) => (reads.push(link), { ok: true, stdout: JSON.stringify(pullRequest) }),
  });
  await read('chat');
  assert.deepEqual(await read.status(url), { url, number: 42, state: 'open', title: 'Fix it' });
  assert.deepEqual(reads, [url], 'the chat and the link share one read');
  pullRequest.state = 'MERGED';
  now = 60_001;
  assert.equal((await read.status(url)).state, 'merged');
  now = 999_999;
  assert.equal((await read.status(url, true)).state, 'merged');
  assert.deepEqual(reads, [url, url], 'a merged PR is final');
});
