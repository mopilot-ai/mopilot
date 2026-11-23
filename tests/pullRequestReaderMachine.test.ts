// The one PR reader gives a chat on a machine the same badge as a chat on this Mac: the chat's own links first, then its folder's branch, which the machine's Host reports (M51). This Mac's own gh looks the PR up by repository and branch.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
import { machineFolderKey } from '../src/lib/machineFolder.ts';
import { end, start, text, world } from './support/host/remoteChatsKit.ts';
import type { ResponseTurn } from '../src/lib/responsePullRequest.ts';

const { buildAcpTurns } = createRequire(import.meta.url)('../electron/harness/items/acpTranslator.cjs');

const ghCalls: { cwd: string; args: string[] }[] = [];
const hostCalls: unknown[][] = [];
let gh: (args: string[]) => { ok: boolean; stdout: string; stderr?: string };
let status: () => Promise<unknown>;
let localHead = 'local-branch';
let monitored: string | null = null;
let history: ResponseTurn[] | null = null;
const PR = { url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, title: 'Machine work' };
installNativeStub({
  git: {
    run: async () => ({ ok: true, stdout: `${localHead}\n` }),
    gh: async (cwd: string, args: string[]) => (ghCalls.push({ cwd, args }), gh(args)),
  },
  host: { gitStatus: (...a: unknown[]) => (hostCalls.push(a), status()) },
  prMonitor: { snapshot: async () => (monitored ? { url: monitored } : null) },
  pullRequests: { savedReplies: async () => (history ? null : []), saveReplies: async () => undefined },
  peer: { referenceHistory: async ([id]: string[]) => ({ [id]: { turns: history } }) },
  fs: { configRoots: async () => ({ codexHome: '/codex' }), readText: async () => null },
});
stubStore({ nativeOf: (id: string) => id, useStore: Object.assign(() => null, { getState: () => ({ home: '/home', runtime: {} }) }) });
mock.module('../src/lib/windowReady.ts', { namedExports: { windowIsReady: () => true, windowReady: async () => undefined } });
const { readPullRequest } = await import('../src/session/pullRequestReader.ts');
const { resetMachineBranches } = await import('../src/lib/machinePullRequest.ts');

const CHAT = 'acp:host-claude:7a1c0e52-3f0b-4f43-9d54-0d1f7f0e9a11';
// the reader remembers a branch's PR by its folder: each test reads a folder of its own
let seq = 0;
let path = '';
let folder = '';
let version = 0;
// each test reads under its own version: the reader keeps what it settled
const read = (cwd: string, id = CHAT) => readPullRequest(id, cwd, true, `v${++version}`);
const hostStatus = (remote: string | null, branch: string | null = 'feat/machine') => ({
  value: { isRepo: true, branch, head: 'a'.repeat(40), remote, files: [], truncated: false, unreadable: false },
});

beforeEach(() => {
  monitored = null;
  history = null;
  path = `/srv/app${++seq}`;
  folder = machineFolderKey('m1', path);
  ghCalls.length = 0;
  hostCalls.length = 0;
  resetMachineBranches();
  gh = () => ({ ok: true, stdout: JSON.stringify([PR]) });
  status = async () => hostStatus('https://github.com/o/r');
});

test("a chat on a machine takes its PR from the branch its Host reports, found by this Mac's gh in that repository", async () => {
  const pr = await read(folder);
  assert.equal(pr?.url, PR.url);
  assert.equal(pr?.state, 'open');
  assert.equal(pr?.number, 7);
  assert.deepEqual(hostCalls[0], ['m1', { path }]);
  const list = ghCalls.find((c) => c.args[1] === 'list')!;
  // run where this Mac's gh is signed in, never in the machine's path
  assert.equal(list.cwd, '/home');
  assert.deepEqual(list.args.slice(0, 7), [
    'pr',
    'list',
    '--repo=github.com/o/r',
    '--head=feat/machine',
    '--state=all',
    '--limit=1',
    '--json',
  ]);
  // nothing ran in the machine's path on this Mac
  assert.equal(
    ghCalls.some((c) => c.cwd === path),
    false,
  );
});

test("the Host is asked once for the folder, however many reads of the minute's rows and the menu follow", async () => {
  await read(folder);
  await read(folder);
  await read(folder, 'acp:host-claude:other-chat');
  assert.equal(hostCalls.length, 1);
});

test('a branch with no PR shows nothing, and an empty gh answer reads as none', async () => {
  gh = () => ({ ok: true, stdout: '[]' });
  assert.equal(await read(folder), null);
  gh = () => ({ ok: true, stdout: '' });
  assert.equal(await read(folder), null);
});

test('a machine folder with no usable branch or GitHub remote shows nothing and runs no gh', async () => {
  for (const answer of [{ value: { isRepo: false } }, hostStatus('https://github.com/o/r', null), hostStatus(null)]) {
    resetMachineBranches();
    status = async () => answer;
    assert.equal(await read(folder), null);
  }
  assert.equal(
    ghCalls.some((c) => c.args[1] === 'list'),
    false,
  );
});

test('an old, refusing or offline Host leaves the badge as the chat gave it, with no error', async () => {
  status = async () => ({ error: { message: 'Update the Host on that machine.', code: 'host_outdated' } });
  assert.equal(await read(folder), null);
  status = async () => {
    throw new Error('offline');
  };
  assert.equal(await read(folder), null);
  assert.equal(
    ghCalls.some((c) => c.args[1] === 'list'),
    false,
  );
});

test('gh failing on the lookup leaves the badge empty', async () => {
  gh = () => ({ ok: false, stdout: '', stderr: 'not signed in' });
  assert.equal(await read(folder), null);
});

for (const [harness, family] of [
  ['host-codex', 'codex'],
  ['host-claude', 'claude'],
  ['gemini', 'acp'],
] as const) {
  test(`${family}: a saved cloud merge report identifies the PR even when the checkout's origin has no match`, async () => {
    const id = `acp:${harness}:cloud-merge`;
    const report = `Merged [PR #7](${PR.url}) into remote \`main\` and verified that it contains fix commit \`e9cb0bd\` and merge commit \`db81efa\`.`;
    const items = [start(), text(report), end()].map((item) => ({ ...item, family }));
    const { host, chats, items: transcript } = world();
    host.reply = { snapshot: { rev: items.length, items }, patches: null, generation: 'g1', inflight: [] };
    try {
      await chats.follow(id);
      await chats.settled(id);
      history = buildAcpTurns(transcript.records, id, path);
    } finally {
      chats.dispose();
    }

    status = async () => hostStatus('https://github.com/o/old-repo');
    const savedVersion = `v${++version}`;
    const refresh = () => readPullRequest(id, folder, true, savedVersion);
    const requests = () => ghCalls.filter(({ args }) => args[0] === 'pr').map(({ args }) => args.slice(-2));
    gh = (args) => (args[1] === 'list' ? { ok: true, stdout: '[]' } : { ok: false, stdout: '', stderr: 'GitHub could not be reached' });
    assert.deepEqual(await refresh(), { url: PR.url, number: 7, state: 'merged', source: 'response' });
    assert.deepEqual(requests(), [['--', PR.url]]);

    gh = () => ({ ok: true, stdout: JSON.stringify({ ...PR, state: 'CLOSED' }) });
    const live = await refresh();
    assert.equal(live?.state, 'closed', 'GitHub is authoritative when it can answer');
    assert.equal(live?.source, undefined);
    assert.deepEqual(readPullRequest.known(id, folder, savedVersion), live);
    assert.deepEqual(await readPullRequest.listed(id, savedVersion), [live]);
    assert.equal(hostCalls.length, 0);
  });
}

test("a chat of this Mac still reads its own folder's branch with gh pr view in that folder", async () => {
  gh = () => ({ ok: true, stdout: JSON.stringify(PR) });
  const pr = await read('/work/app', 'codex-local-chat');
  assert.equal(pr?.url, PR.url);
  assert.equal(hostCalls.length, 0);
  const view = ghCalls.find((c) => c.args[1] === 'view')!;
  assert.equal(view.cwd, '/work/app');
  assert.equal(
    ghCalls.some((c) => c.args[1] === 'list'),
    false,
  );
});

test("a chat that carries its own PR link is read by that link in this Mac's home, and its Host is never asked", async () => {
  monitored = PR.url;
  gh = () => ({ ok: true, stdout: JSON.stringify(PR) });
  const pr = await read(folder);
  assert.equal(pr?.url, PR.url);
  assert.equal(hostCalls.length, 0);
  const view = ghCalls.find((c) => c.args[1] === 'view')!;
  assert.equal(view.cwd, '/home');
  assert.deepEqual(view.args.slice(-2), ['--', PR.url]);
});

test('a Host that no longer gives a branch between the branch read and the PR lookup leaves the badge empty', async () => {
  let clock = 1_000;
  const now = mock.method(Date, 'now', () => clock);
  let asked = 0;
  // the first answer takes longer than the read stands: the lookup asks again and the folder is no repository any more
  status = async () => {
    if (asked++ > 0) return { value: { isRepo: false } };
    clock += 40_000;
    return hostStatus('https://github.com/o/r', 'gone-soon');
  };
  try {
    assert.equal(await read(folder), null);
  } finally {
    now.mock.restore();
  }
  assert.equal(hostCalls.length, 2);
  assert.equal(
    ghCalls.some((c) => c.args[1] === 'list'),
    false,
  );
});
