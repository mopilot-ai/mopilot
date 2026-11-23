// An approval of Claude Code or Codex on a machine says what This Mac's card says for the same tool (audit turn:T10): the Host's tool call is the data, the words are the same; a basic agent's card keeps its own.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import {
  mockStore,
  autoMock,
  stubComponent,
  render,
  resetStore,
  moduleCalls,
  nativeCalls,
  impl,
  settle,
  setStore,
  native,
  callsTo,
} from './support/thread-kit.ts';

mockStore();
const { fileChangeToDiff, parseUnifiedDiff } = await import('../src/lib/diff.ts');
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff'), fileChangeToDiff, parseUnifiedDiff });
autoMock('src/components/ui/Popover.tsx', 'popover', await import('./support/thread-approvals-popover.ts'));
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { Approvals } = await import('../src/components/thread/Approvals.tsx');

const HOST = 'acp:host-claude:t1';
native.computer = { answer: async () => true };
const options = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
];
const text = (el: Element | null) => el?.textContent ?? '';
const show = async (toolCall: object, opts: object[] = options, T = HOST) => {
  useSessions.setState({
    sessions: {
      [T]: { ...EMPTY_SESSION, rev: 1, approvals: [{ id: 'r1', method: 'acp/permission', params: { toolCall, options: opts } }] },
    },
  });
  return render(h(Approvals, { threadId: T, cwd: '/repo' }));
};

beforeEach(() => {
  resetStore();
  useSessions.setState({ sessions: {} });
  moduleCalls.length = 0;
  nativeCalls.length = 0;
  for (const k of Object.keys(impl)) delete impl[k];
  impl['store:chatHarnessLabel'] = () => 'Claude Code';
  impl['store:chatOf'] = (id: string) => `chat:${id}`;
});
afterEach(() => {
  document.body.innerHTML = '';
});

test('a command, an edit, a fetch and a plan on a machine read as This Mac’s cards do, and the first allow is "Allow once"', async () => {
  let v = await show({ kind: 'execute', title: 'Run ls', rawInput: { command: 'ls -la' } });
  assert.equal(text(v.$('.approval-kind')), 'Terminal');
  assert.equal(text(v.$('.approval-message')), 'Allow Claude Code to run this command?');
  assert.equal(text(v.$('.approval-cmd')), 'ls -la');
  assert.ok([...v.host.querySelectorAll('button')].some((b) => text(b).startsWith('Allow once')));
  await v.unmount();

  v = await show({ kind: 'edit', title: 'Edit a.ts', content: [{ type: 'diff', path: '/repo/a.ts', oldText: null, newText: 'x' }] });
  assert.equal(text(v.$('.approval-kind')), 'Edit');
  assert.equal(text(v.$('.approval-message')), 'Allow Claude Code to edit a.ts?');
  await v.unmount();

  v = await show({
    kind: 'edit',
    title: 'Edit two',
    content: [
      { type: 'diff', path: '/repo/a.ts', oldText: null, newText: 'x' },
      { type: 'diff', path: '/repo/b.ts', oldText: null, newText: 'y' },
    ],
  });
  assert.equal(text(v.$('.approval-message')), 'Allow Claude Code to edit 2 files?');
  await v.unmount();

  v = await show({ kind: 'fetch', title: 'Fetch', rawInput: { url: 'https://x.dev' } });
  assert.equal(text(v.$('.approval-kind')), 'Network');
  assert.equal(text(v.$('.approval-message')), 'Allow Claude Code to fetch https://x.dev?');
  await v.unmount();

  const plan = [
    { optionId: 'allow', name: 'Approve plan', kind: 'allow_once' },
    { optionId: 'deny', name: 'Keep planning', kind: 'reject_once' },
  ];
  v = await show({ kind: 'switch_mode', title: 'Approve this plan?' }, plan);
  assert.equal(text(v.$('.approval-kind')), 'Plan');
  assert.equal(text(v.$('.approval-message')), 'Ready to start on this plan?');
  assert.ok(
    [...v.host.querySelectorAll('button')].some((b) => text(b).startsWith('Approve plan')),
    'the Host’s own name for it stays',
  );
  await v.unmount();
});

test('a tool with no command, file, URL or plan keeps the generic line; the answer is still the option picked', async () => {
  const v = await show({ kind: 'read', title: 'Read a', rawInput: { path: '/a' } });
  assert.equal(text(v.$('.approval-message')), 'Claude Code wants to: Read a');
  assert.equal(text(v.$('.approval-kind')), 'Tool');
  await settle(() => ([...v.host.querySelectorAll('button')].find((b) => text(b).startsWith('Allow once')) as HTMLElement).click());
  assert.deepEqual(callsTo('store:resolveRequest')[0].slice(-1), [{ optionId: 'allow_once' }]);
  await v.unmount();
  // a fetch that names no URL has nothing to say but its title
  const bare = await show({ kind: 'fetch', title: 'Fetch it' });
  assert.equal(text(bare.$('.approval-message')), 'Claude Code wants to: Fetch it');
  await bare.unmount();
});

test('Codex on a machine reads the same; a basic agent on a machine, a chat the Host moved to one, and any chat on this Mac keep the generic card', async () => {
  const run = { kind: 'execute', title: 'Run ls', rawInput: { command: 'ls' } };
  impl['store:chatHarnessLabel'] = () => 'Codex';
  let v = await show(run, options, 'acp:host-codex:t2');
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to run this command?');
  await v.unmount();
  v = await show(run, options, 'acp:kimi:t3');
  assert.equal(text(v.$('.approval-message')), 'Codex wants to: Run ls');
  assert.ok(
    [...v.host.querySelectorAll('button')].some((b) => text(b).startsWith('Allow') && !text(b).startsWith('Allow once')),
    'the Host’s own name for it',
  );
  await v.unmount();
  v = await show(run, options, 't4');
  assert.equal(text(v.$('.approval-message')), 'Codex wants to: Run ls');
  await v.unmount();
  // the Host moved a Claude Code chat to a basic agent: it reads as that agent's; one moved to Codex reads as Codex's
  setStore({ chatConfig: { 'acp:host-claude:t5': { hostAgent: 'acp:kimi' }, 'acp:kimi:t6': { hostAgent: 'codex' } } });
  v = await show(run, options, 'acp:host-claude:t5');
  assert.equal(text(v.$('.approval-message')), 'Codex wants to: Run ls');
  await v.unmount();
  v = await show(run, options, 'acp:kimi:t6');
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to run this command?');
  await v.unmount();
});
