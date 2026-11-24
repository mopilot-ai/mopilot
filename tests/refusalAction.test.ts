// The one action a Host's refusal offers on a queued message (src/session/refusalAction.ts): its button words and what pressing it calls.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { useFakeNative } from './support/ports/native.ts';

const calls: unknown[][] = [];
mock.module('../src/lib/hostInstall.ts', {
  namedExports: { startInstall: async (...a: unknown[]) => void calls.push(['install', ...a]), installLine: () => '' },
});
mock.module('../src/lib/hostSignin.ts', {
  namedExports: { startSignin: async (...a: unknown[]) => void calls.push(['signIn', ...a]), RUNNING: new Set<string>() },
});
const opened: unknown[][] = [];
mock.module('../src/store/chats.ts', { namedExports: { openMachines: () => void opened.push(['connections', 'other']) } });
const carried: unknown[][] = [];
mock.module('../src/session/refusalNewChat.ts', {
  namedExports: { newChatWithMessage: async (...a: unknown[]) => (carried.push(a), true) },
});
const configs: unknown[][] = [];
mock.module('../src/store/projects.ts', { namedExports: { setChatConfig: (...a: unknown[]) => void configs.push(a) } });
const sentAgain: unknown[][] = [];
let sendResult: boolean | void = undefined;
mock.module('../src/store/send.ts', { namedExports: { sendMessage: async (...a: unknown[]) => (sentAgain.push(a), sendResult) } });
const drafts: unknown[][] = [];
const toasts: unknown[][] = [];
const BEFORE = { hostId: 'box', harness: 'codex', value: 'default' };
mock.module('../src/store/core.ts', {
  namedExports: {
    get: () => ({ chatConfig: { c1: { hostPermission: BEFORE } } }),
    setDraft: (...a: unknown[]) => void drafts.push(a),
    toast: (...a: unknown[]) => void toasts.push(a),
  },
});
const { picksFolder, refusalActionLabel, runRefusalAction } = await import('../src/session/refusalAction.ts');

const r = (action: string | null, agent: string | undefined = 'codex') =>
  ({ code: 'x', action, retry: false, hostId: 'box', machine: 'mini', ...(agent ? { agent } : {}) }) as any;

test('each action has its button words, and a refusal with no action has none', () => {
  assert.deepEqual(
    ['install', 'signIn', 'orgSignIn', 'update', 'openMachines', 'newChat', null].map((a) => refusalActionLabel(r(a))),
    ['Install on mini', 'Sign in', 'Sign in', null, 'Machine settings', 'New chat on mini', null],
  );
});

test('an Update is labelled only where the machine row offers one', () => {
  const m = (o: object) => ({ id: 'box', name: 'mini', status: 'online', agents: [], ...o }) as any;
  assert.equal(refusalActionLabel(r('update'), m({ hostStale: true })), 'Update');
  assert.equal(refusalActionLabel(r('update'), m({ hostStale: true, update: 'failed' })), 'Try again');
  assert.equal(refusalActionLabel(r('update'), m({ hostNewer: true })), null);
  assert.equal(refusalActionLabel(r('update'), m({ id: 'relay:x', hostStale: true })), null);
  assert.equal(refusalActionLabel(r('update'), m({})), null);
  assert.equal(refusalActionLabel(r('update')), null, 'a machine that is not listed');
  assert.equal(refusalActionLabel(r('install'), m({ hostNewer: true })), 'Install on mini', 'other actions do not depend on the version');
});

test('pressing it calls what the app already does elsewhere, on the machine and the agent; no action does nothing', async (t) => {
  useFakeNative(t, {
    host: { orgSignIn: async () => void calls.push(['orgSignIn']), update: async (id: string) => void calls.push(['update', id]) },
  });
  for (const action of ['install', 'signIn', 'orgSignIn', 'update', 'openMachines', null]) await runRefusalAction(r(action));
  assert.deepEqual(calls, [['install', 'box', 'codex'], ['signIn', 'box', 'codex'], ['orgSignIn'], ['update', 'box']]);
  // the machine's page is where access is granted or the machine added again
  assert.deepEqual(opened, [['connections', 'other']]);
  // a refusal that names no agent installs and signs in nothing it cannot name
  calls.length = 0;
  const unnamed = (action: string) => ({ ...r(action), agent: undefined });
  await runRefusalAction(unnamed('install'));
  await runRefusalAction(unnamed('signIn'));
  assert.deepEqual(calls, [
    ['install', 'box', ''],
    ['signIn', 'box', ''],
  ]);
});

test('New chat carries the queued message and removes its row once the chat is there; with no message to carry it does nothing', async () => {
  const removed: string[] = [];
  const queued = { chatId: 'old', text: 'carry me', attachments: [], removeRow: async () => void removed.push('row') };
  await runRefusalAction(r('newChat'), queued);
  assert.deepEqual(carried, [[r('newChat'), queued, undefined]]);
  assert.deepEqual(removed, ['row']);
  carried.length = 0;
  removed.length = 0;
  await runRefusalAction(r('newChat'));
  assert.deepEqual([carried, removed], [[], []]);
});

test('Choose a folder carries the message to a new chat in the folder picked; without a folder it starts nothing', async () => {
  const removed: string[] = [];
  const queued = { chatId: 'old', text: 'carry me', attachments: [], removeRow: async () => void removed.push('row') };
  carried.length = 0;
  assert.equal(picksFolder(r('chooseFolder')), true);
  assert.equal(picksFolder(r('newChat')), false);
  assert.equal(refusalActionLabel(r('chooseFolder')), 'Choose a folder');
  await runRefusalAction(r('chooseFolder'), queued);
  assert.deepEqual([carried, removed], [[], []]);
  await runRefusalAction(r('chooseFolder'), queued, '/srv/other');
  assert.deepEqual(carried, [[r('chooseFolder'), queued, '/srv/other']]);
  assert.deepEqual(removed, ['row']);
});

test('"Use Read-only": the chat’s pick becomes the most the machine allows, the refused message leaves the queue and goes out again under it, with what it was queued with; without the mode, the message or a family it does nothing', async () => {
  const use = (o: object = {}) => ({ ...r('useMode'), mode: 'read-only', ...o });
  assert.equal(refusalActionLabel(use()), 'Use Read-only');
  assert.equal(refusalActionLabel(use({ mode: 'auto-review' })), 'Use Approve for me');
  assert.equal(refusalActionLabel(use({ mode: 'odd' })), 'Use odd');
  assert.equal(refusalActionLabel(r('useMode')), null, 'no mode to name');
  const removed: unknown[] = [];
  let taken: boolean | void = true;
  const queued = (opts?: object) =>
    ({ chatId: 'c1', text: 'do it', attachments: [], opts, removeRow: async () => (removed.push('row'), taken) }) as any;
  await runRefusalAction(use(), queued());
  assert.deepEqual(configs, [['c1', { hostPermission: { hostId: 'box', harness: 'codex', value: 'read-only' } }]]);
  assert.deepEqual(removed, ['row']);
  assert.deepEqual(sentAgain, [['c1', 'do it', [], {}]]);
  // a message queued under Plan (its mode was frozen as `plan`), with a goal and a model pick, goes out as it was
  sentAgain.length = configs.length = 0;
  await runRefusalAction(use(), queued({ hostMode: 'plan', goal: 'ship', model: 'm', effort: 'low', prefix: 'p', human: true }));
  assert.deepEqual(sentAgain, [['c1', 'do it', [], { plan: true, goal: 'ship', model: 'm', effort: 'low', prefix: 'p', human: true }]]);
  // the row was not taken out by this click (another window did, or it could not be): nothing is sent twice and the pick goes back
  sentAgain.length = configs.length = 0;
  taken = false;
  await runRefusalAction(use(), queued());
  assert.deepEqual(sentAgain, []);
  assert.deepEqual(configs.at(-1), ['c1', { hostPermission: BEFORE }]);
  // the send did not go (the send said why): the words are back in the composer, and the pick is what it was
  taken = true;
  sendResult = false;
  configs.length = sentAgain.length = 0;
  await runRefusalAction(use(), queued());
  assert.deepEqual(drafts, [['c1', { text: 'do it', attachments: [] }]]);
  assert.deepEqual(configs.at(-1), ['c1', { hostPermission: BEFORE }]);
  sendResult = undefined;
  configs.length = sentAgain.length = removed.length = 0;
  await runRefusalAction(use(), undefined);
  await runRefusalAction(use({ mode: undefined }), queued());
  await runRefusalAction(use({ agent: 'kimi' }), queued());
  await runRefusalAction(use({ agent: undefined }), queued());
  assert.deepEqual([configs, sentAgain, removed], [[], [], []]);
});

test('a Mac the machine does not know is offered Pair again: over ssh for a machine the Mac can ssh to, in Settings for one added by command', async (t) => {
  const asked: string[] = [];
  let out: any = { ok: true, paired: true, error: '', id: 'ssh:me@box', steps: [] };
  useFakeNative(t, { host: { add: async (destination: string) => (asked.push(destination), out) } });
  const unknown = (hostId: string) => ({ ...r('openMachines'), code: 'unknown_client', hostId });
  assert.equal(refusalActionLabel(unknown('ssh:me@box')), 'Pair again');
  opened.length = 0;
  await runRefusalAction(unknown('ssh:me@box'));
  assert.deepEqual([asked, toasts, opened], [['me@box'], [['Paired mini again']], []]);
  // the add did not pair: its reason is the failure the row shows
  out = { ok: true, paired: false, error: 'That is not the pairing code.', id: 'ssh:me@box', steps: [] };
  await assert.rejects(runRefusalAction(unknown('ssh:me@box')), /not the pairing code/);
  out = { ok: false, paired: false, error: '', id: '', steps: [] };
  await assert.rejects(runRefusalAction(unknown('ssh:me@box')), /Could not pair with mini again/);
  // a machine added by command has no ssh to do it from
  asked.length = 0;
  await runRefusalAction(unknown('relay:abc'));
  assert.deepEqual([asked, opened], [[], [['connections', 'other']]]);
});
