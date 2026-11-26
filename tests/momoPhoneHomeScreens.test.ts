// MoMo's phone home and chat chrome: header pill, banners, Where MoMo runs, the move and the first run, and the door that only opens for allowed accounts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mount,
  find,
  placeholder,
  tap,
  homeIs,
  kinds,
  act,
  createElement,
  createRoot,
  flush,
  fixtureView,
  createMomoStore,
  MomoPhone,
  ref,
  type Any,
} from './support/phone/momo-screens';
const entryPath = '../mobile/src/screens/momoPhone/MomoEntry';
const hookPath = '../mobile/src/screens/momoPhone/useMomoHome';
const { MomoEntry } = await import(entryPath);
const { forgetMomoHomeAnswers } = await import(hookPath);
const { fakeDraft } = await import('./support/phone/drafts');

test('the chat shows MoMo in serif, the header pill, the card and the composer hint; Back leaves MoMo', async () => {
  const m = await mount();
  assert.match(m.text(), /MoMo · Studio/);
  assert.match(m.text(), /The quote sheet is ready/);
  assert.match(m.text(), /Send this email\?/);
  assert.equal(placeholder(), 'Message MoMo');
  await tap('Back');
  assert.deepEqual(m.backs, ['back']);
});

test('the tabs switch between Chat, Tasks and Notes', async () => {
  const m = await mount();
  await tap('Tasks');
  assert.match(m.text(), /Build the Acme quote sheet/);
  await tap('Notes');
  assert.match(m.text(), /Acme/);
  await tap('Chat');
  assert.equal(placeholder(), 'Message MoMo');
});

test('before the first read the screen is empty', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const store = createMomoStore({
    load: () => new Promise(() => undefined),
    send: async () => ({ ok: true }),
    subscribe: () => () => undefined,
  });
  await act(async () => root.render(createElement(MomoPhone, { store, back: () => undefined })));
  await flush();
  assert.equal(host.textContent, '‹Back');
  await act(async () => root.unmount());
  host.remove();
});

test('a sleeping home says so, Wake asks the home, Move MoMo opens Where MoMo runs', async () => {
  const m = await mount(homeIs('asleep'));
  assert.match(m.text(), /MoMo's home went to sleep at 1:12 PM/);
  assert.equal(placeholder(), 'Message MoMo · sends when Studio is back');
  await tap('Wake Studio');
  assert.deepEqual(kinds(m), ['wake']);
  assert.doesNotMatch(m.text(), /went to sleep/);
  const n = await mount(homeIs('asleep'));
  await tap('Move MoMo');
  assert.match(n.text(), /Move MoMo to/);
  assert.deepEqual(kinds(n), []);
});

test('an out-of-date home and a signed-out agent offer their one-tap fixes', async () => {
  const a = await mount(homeIs('needs-update'));
  assert.match(a.text(), /MoPilot on Studio is out of date/);
  await tap('Update Studio');
  assert.deepEqual(a.sent, [{ kind: 'update-machine', machineId: 'studio' }]);
  const b = await mount(homeIs('needs-sign-in'));
  assert.match(b.text(), /Claude Code is signed out on Studio/);
  await tap('Use Codex');
  await tap('Sign in on Studio');
  assert.deepEqual(kinds(b), ['sign-in-agent', 'sign-in-agent']);
});

test('a machine that is no longer home says where MoMo went', async () => {
  const m = await mount(
    homeIs('running', { movedAway: { machine: { machineId: 'mac', name: 'This Mac' }, at: new Date(2026, 10, 24, 15, 2).getTime() } }),
  );
  assert.match(m.text(), /MoMo moved to This Mac at 3:02 PM\./);
  await tap('Open This Mac');
  assert.deepEqual(m.sent, [{ kind: 'choose-home', machineId: 'mac' }]);
});

test('delivery problems show their sentence and fix; a refused intent shows its cause and Dismiss', async () => {
  const m = await mount((v) =>
    v.problems.push({
      id: 'push:1',
      code: 'notifications_off',
      cause: 'Notifications are off.',
      fix: { id: 'f9', label: 'Open Settings' },
      since: 1,
    }),
  );
  assert.match(m.text(), /Notifications are off\./);
  m.transport.fail({ ok: false, cause: 'Studio did not answer.', fix: { kind: 'wake' }, fixLabel: 'Wake Studio' });
  await tap('Open Settings');
  assert.match(m.text(), /Studio did not answer\./);
  await tap('Wake Studio');
  assert.doesNotMatch(m.text(), /Studio did not answer\./);
  m.transport.fail({ ok: false, cause: 'No.' });
  await tap('Open Settings');
  assert.match(m.text(), /No\./);
  await tap('Got it');
  assert.doesNotMatch(m.text(), /No\./);
});

const moveOf = (step: string, extra: object = {}) => ({
  moveId: 'm',
  from: ref('studio', 'Studio'),
  to: ref('mini', 'Mac mini'),
  step,
  outcome: 'running',
  finishedAt: null,
  failure: null,
  oldMachineOffline: false,
  ...extra,
});

test('a machine that is offline has no Move', async () => {
  const m = await mount((v) => (v.home.machines[1].status = 'offline'));
  await tap('MoMo · Studio');
  assert.match(m.text(), /This Mac/);
  assert.equal(find('This Mac'), undefined, 'a row with no action is not a button');
});

test('Back closes the page that is open, and leaves MoMo only from a tab', async () => {
  const m = await mount();
  await tap('MoMo · Studio');
  await tap('Back');
  assert.doesNotMatch(m.text(), /Move MoMo to/);
  await tap('Notes');
  await tap('Back');
  assert.deepEqual(m.backs, ['back']);
  const t = await mount();
  await tap('Tasks');
  await tap('Build the Acme quote sheet');
  await tap('Stop');
  await tap('Back');
  assert.match(t.text(), /Done means/);
  assert.doesNotMatch(t.text(), /Stop this task\?/);
  const e = await mount((v) => (v.notes = []));
  await tap('Notes');
  await tap('Write your own note');
  await tap('Back');
  assert.match(e.text(), /Nothing here yet\./);
  await tap('Write your own note');
  await tap('Cancel');
  assert.match(e.text(), /Nothing here yet\./);
});

test('Where MoMo runs lists the machines; Move starts a move with steps and Cancel; Set up, Update and Add a machine ask the home', async () => {
  const m = await mount();
  await tap('MoMo · Studio');
  assert.match(m.text(), /MoMo is here/);
  assert.match(m.text(), /Claude Code and Codex signed in/);
  assert.match(m.text(), /Mac mini.*out of date/);
  await tap('This Mac');
  assert.match(m.text(), /Moving MoMo to This Mac/);
  assert.match(m.text(), /✓|●/);
  await tap('Cancel');
  assert.deepEqual(kinds(m), ['move', 'move-cancel']);
  await tap('Mac mini');
  await tap('Cloud machine');
  await tap('Add a machine');
  assert.deepEqual(kinds(m).slice(2), ['update-machine', 'move', 'add-machine']);
  await tap('MoMo · Studio');
  assert.doesNotMatch(m.text(), /Move MoMo to/);
});

test('a move that is switching has no Cancel; a failed one offers Retry and Stay; one that finished late says Got it', async () => {
  const a = await mount(homeIs('moving', { move: moveOf('switching') }));
  assert.match(a.text(), /It cannot be cancelled now/);
  assert.equal(find('Cancel'), undefined);
  const b = await mount(
    homeIs('running', {
      move: moveOf('copied', { outcome: 'failed', failure: { cause: 'Mac mini stopped answering.', failedAt: 'copied' } }),
    }),
  );
  assert.match(b.text(), /Move didn't finish/);
  assert.match(b.text(), /Last step reached: Copied/);
  await tap('Retry');
  await tap('Stay on Studio');
  assert.deepEqual(kinds(b), ['move-retry', 'move-stay']);
  const c = await mount(homeIs('running', { move: moveOf('cleaning-up', { outcome: 'moved', oldMachineOffline: true }) }));
  assert.match(c.text(), /Studio is offline and still holds a copy/);
  await tap('Got it');
  assert.deepEqual(kinds(c), ['move-ack']);
  assert.doesNotMatch(c.text(), /still holds a copy/);
  const d = await mount(homeIs('running', { move: moveOf('copied', { outcome: 'cancelled' }) }));
  assert.doesNotMatch(d.text(), /Moving MoMo/);
});

test('the first run recommends a machine and continues with it', async () => {
  const m = await mount((v) => (v.setup.step = 'where'));
  assert.match(m.text(), /Where should MoMo live\?/);
  assert.match(m.text(), /Recommended/);
  await tap('Continue with Studio');
  assert.deepEqual(m.sent, [{ kind: 'choose-home', machineId: 'studio' }]);
  const n = await mount((v) => (v.setup.step = 'where'));
  await tap('This Mac');
  await tap('Continue with This Mac');
  assert.deepEqual(n.sent, [{ kind: 'choose-home', machineId: 'mac' }]);
  const none = await mount((v) => {
    v.setup.step = 'where';
    v.home.machines.forEach((x: Any) => (x.recommended = false));
  });
  assert.equal(find('Continue with'), undefined);
  assert.match(none.text(), /Pick the machine that stays on\./);
});

test('the door shows the home screens only to an account the computer allows; everyone else keeps the classic MoMo', async () => {
  const mk = (hello: unknown) => {
    const calls: string[] = [];
    const listeners: Any[] = [];
    const runtime: Any = {
      snapshot: () => ({ phase: 'online', generation: 1, user: { id: 'u' }, selectedPair: 'p' }),
      subscribe: () => () => undefined,
      onEvent: (l: Any) => (listeners.push(l), () => undefined),
      request: async (method: string) => {
        calls.push(method);
        if (method === 'machine.hello') return hello;
        if (method === 'momo.home.view') return { view: fixtureView().view };
        throw new Error(`no ${method}`);
      },
    };
    return { runtime, calls, listeners };
  };
  const draw = async (hello: unknown, phase = 'online') => {
    forgetMomoHomeAnswers();
    const { runtime, calls, listeners } = mk(hello);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      runtime,
      state: { phase, outbox: [], generation: 1, user: { id: 'u' }, pairs: [], selectedPair: 'p' },
      cache: Promise.resolve(null),
      back: () => undefined,
      focus: null,
      media: undefined,
      computers: undefined,
      drafts: fakeDraft(),
    };
    await act(async () => root.render(createElement(MomoEntry, props)));
    await flush();
    await flush();
    const pushed = fixtureView().view;
    pushed.home.machineName = 'Pushed';
    await act(async () => listeners.forEach((l) => l({ ev: 'momo.home.changed', view: pushed })));
    const text = `${host.textContent ?? ''}${host.textContent?.includes('Pushed') ? ' pushed' : ''}`;
    await act(async () => root.unmount());
    host.remove();
    return { text, calls };
  };
  const yes = await draw({ capabilities: { momo: true, momoHome: true } });
  assert.match(yes.text, /MoMo · Pushed/);
  assert.ok(yes.calls.includes('momo.home.view'));
  const uninvited = await draw({ capabilities: { momo: false, momoHome: true } });
  assert.doesNotMatch(uninvited.text, /MoMo · /);
  assert.equal(uninvited.calls.includes('momo.home.view'), false, 'an uninvited account never asks for the home view');
  const old = await draw({ capabilities: { momo: true } });
  assert.doesNotMatch(old.text, /MoMo · /);
  assert.equal(old.calls.includes('momo.home.view'), false);
  const offline = await draw({ capabilities: { momo: true, momoHome: true } }, 'offline');
  assert.equal(offline.calls.includes('momo.home.view'), false, 'a computer that is away is not asked');
});
