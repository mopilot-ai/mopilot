// A chat's sidebar PR from its PR monitor binding (any harness), and from a reply that writes the link in parentheses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestReader } from '../src/lib/threadPullRequest.ts';
import { responsePullRequests } from '../src/lib/responsePullRequest.ts';

const bound = 'https://github.com/org/repo/pull/3041';
const attached = 'https://github.com/org/repo/pull/7';
const open = (url: string) => ({
  ok: true,
  stdout: JSON.stringify({ url, state: 'OPEN', isDraft: false, title: `PR ${url.split('/').at(-1)}` }),
});
const reply = (text: string) => ({ status: 'completed', items: [{ type: 'agentMessage', text, phase: 'final_answer' }] });
const reader = (o: { monitored?: (id: string) => Promise<string | null>; attachments?: string[]; head?: string | null } = {}) => {
  const gh: unknown[] = [];
  const read = createPullRequestReader({
    attachments: async () => ({
      data: (o.attachments ?? []).map((url, i) => ({
        id: String(i),
        attachmentType: 'pull_request',
        identityKey: url,
        payload: { url },
        createdAt: i + 1,
      })),
      nextCursor: null,
    }),
    legacy: async () => null,
    head: async () => o.head ?? null,
    gh: async (url, cwd, head) => {
      gh.push([url, cwd, head]);
      return url ? open(url) : { ok: false, stdout: '' };
    },
    monitored: o.monitored,
  });
  return { read, gh };
};

test("a chat's PR monitor binding is its PR on any harness, even when the worktree's branch has another PR or none", async () => {
  const { read, gh } = reader({ monitored: async (id) => (id === 'claude:chat' ? bound : null), head: 'mopilot/0c9b' });
  const pr = await read('claude:chat', '/worktree', true);
  assert.deepEqual([pr?.url, pr?.state, pr?.title], [bound, 'open', 'PR 3041']);
  assert.deepEqual(gh, [[bound, '', undefined]], 'the branch is not guessed once the chat is bound');
  // an unbound chat still falls back to its folder's branch
  assert.equal(await read('claude:other', '/worktree', true), null);
  assert.deepEqual(gh.at(-1), [null, '/worktree', 'mopilot/0c9b']);
});

test('the monitor binding is the latest PR; older attachments stay listed after it', async () => {
  const { read } = reader({ monitored: async () => bound, attachments: [attached] });
  const pr = await read('codex-chat', '', true);
  assert.equal(pr?.url, bound);
  assert.deepEqual(
    pr?.entries?.map((e) => e.url),
    [bound, attached],
  );
});

test('an unreadable or malformed binding falls back to the other sources', async () => {
  for (const monitored of [
    async () => {
      throw new Error('Unknown app window');
    },
    async () => 'https://github.com/org/repo/issues/3',
    async () => null,
  ]) {
    const { read } = reader({ monitored, attachments: [attached] });
    assert.equal((await read('chat', '', true))?.url, attached);
  }
  // a reader without the binding (older wiring) behaves as before
  const { read } = reader({ attachments: [attached] });
  assert.equal((await read('chat', '', true))?.url, attached);
});

test('a PR link in parentheses or brackets is the PR, not a link with the bracket on it', () => {
  for (const text of [
    'The change is up as PR #3041 (https://github.com/org/repo/pull/3041), but it has not merged yet.',
    'Opened PR #3041 [https://github.com/org/repo/pull/3041].',
    'Opened PR #3041 (https://github.com/org/repo/pull/3041).',
    "Opened PR #3041 'https://github.com/org/repo/pull/3041'.",
  ])
    assert.deepEqual(
      responsePullRequests([reply(text)]).map((p) => [p.url, p.state]),
      [[bound, 'open']],
      text,
    );
});

test('a state reported of a PR linked in brackets still counts: "PR #7 (link) is merged"', () => {
  for (const [text, state] of [
    [`PR #3041 (${bound}) is merged.`, 'merged'],
    [`The PR #3041 [${bound}] was closed.`, 'closed'],
  ])
    assert.deepEqual(
      responsePullRequests([reply(text)]).map((p) => [p.url, p.state]),
      [[bound, state]],
      text,
    );
});
