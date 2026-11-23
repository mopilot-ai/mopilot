// The "+ New session" capsule on the Chats home and the sheet it opens: shown only where a chat can be started, never offering full access, and honest about a start that may have gone through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText } from './support/phone/component-kit';
import { scripted, fakeMedia } from './support/phone/m3';
const appPath = '../mobile/src/MobileApp';
const unconfirmedPath = '../mobile/src/remote/unconfirmed';
const { MobileApp } = await import(appPath);
const { unconfirmedNotice } = await import(unconfirmedPath);

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u', name: 'Dana' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
  selectedPair: 'p',
  error: null,
};
const mounted: any[] = [];
async function mount(handler: (m: string, p: any) => unknown = () => undefined, props: any = {}, snap: any = online) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const s = scripted((m, p) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'A chat', state: 'idle' }] } : handler(m, p)), snap);
  s.runtime.start = async () => {};
  const listeners = new Set<() => void>();
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, ...props })));
  await flush();
  const change = async (patch: object) => {
    s.state.snap = { ...s.state.snap, ...patch };
    await act(async () => listeners.forEach((f) => f()));
    await flush();
  };
  return { host, s, change };
}
const capsule = (host: HTMLElement) => host.querySelector('button[aria-label="New session"]') as HTMLButtonElement | null;

test('the capsule is on the chat list where a chat can be started, and nowhere else', async () => {
  const bare = await mount();
  assert.equal(capsule(bare.host), null, 'no media, no new chats');
  const v = await mount(undefined, { media: fakeMedia().media });
  assert.ok(capsule(v.host));
  assert.match(capsule(v.host)!.textContent!, /New session/);
  await click('Settings');
  assert.equal(capsule(v.host.querySelector('[data-screen="settings"]') as HTMLElement), null, 'not on the Settings sheet');
  await click('Close');
  assert.ok(capsule(v.host));
  await v.change({ phase: 'offline', generation: 2, selectedPair: null });
  assert.equal(capsule(v.host), null, 'a chat cannot be started while the computer is away');
});

test('the capsule opens the sheet, whose project, chips and composer start the chat, and Cancel returns to the list', async () => {
  const v = await mount((m) => (m === 'chat.start' ? { chatId: 'claude:new' } : undefined), { media: fakeMedia().media });
  await click('New session');
  assert.ok(v.host.querySelector('button[aria-label="Project, No project"]'));
  assert.ok(v.host.querySelector('button[aria-label^="Agent,"]'));
  assert.ok(v.host.querySelector('input[placeholder="Describe a task or ask a question"]'));
  assert.equal(v.host.querySelector('[data-screen="newChat"] button[aria-label="New session"]'), null, 'the capsule is the list’s');
  await click('Back');
  assert.ok(capsule(v.host));
  await click('New session');
  await inputText('Describe a task or ask a question', 'Fix it');
  await click('Start chat');
  assert.ok(v.s.calls.some(([m]) => m === 'chat.start'));
  assert.ok(v.host.querySelector('button[aria-label="Back to chats"]'), 'the new chat opens');
});

test('a start that was in flight as the connection went is not confirmed, keeps the prompt, and starting again is the same start', async () => {
  let attempts = 0;
  const v = await mount(
    (m) => {
      if (m !== 'chat.start') return undefined;
      if (++attempts === 1) throw new Error('relay disconnected');
      return { chatId: 'claude:new' };
    },
    { media: fakeMedia().media },
  );
  await click('New session');
  await inputText('Describe a task or ask a question', 'Fix it');
  await click('Start chat');
  assert.match(v.host.textContent!, /Start not confirmed\. Check your chats before trying again\./);
  assert.doesNotMatch(v.host.textContent!, /relay disconnected|offline or asleep/);
  assert.equal(v.host.querySelector<HTMLInputElement>('input[placeholder="Describe a task or ask a question"]')!.value, 'Fix it');
  await click('Start chat');
  const starts = v.s.calls.filter(([m]) => m === 'chat.start').map(([, p]) => p);
  assert.equal(starts[0].startId, starts[1].startId, 'one chat, however many times it is asked for');
  assert.doesNotMatch(v.host.textContent!, /not confirmed/);
});

test('the notices say what to check: the chat for a send, stop or answer; the list for a start', () => {
  assert.deepEqual(unconfirmedNotice('start'), { lead: 'Start not confirmed.', text: 'Check your chats before trying again.' });
  assert.equal(unconfirmedNotice('stop').text, 'Check the chat before trying again.');
});

test('the permission chip never offers full access, however the Mac lists it', async () => {
  const v = await mount(
    (m) =>
      m === 'options.get'
        ? {
            models: [{ id: 'm', label: 'Model', efforts: [] }],
            model: 'm',
            permission: {
              value: 'default',
              rows: [
                { id: 'default', label: 'Ask first' },
                { id: 'auto-review', label: 'Auto review' },
                { id: 'full-access', label: 'Full access' },
              ],
            },
          }
        : undefined,
    { media: fakeMedia().media },
  );
  await click('New session');
  await click('Model, Model');
  await click('Permissions, Ask first');
  assert.match(v.host.textContent!, /Auto review/);
  assert.doesNotMatch(v.host.textContent!, /Full access|full-access/i);
});

const MODELS = {
  models: [
    { id: 'm1', label: 'Fast', efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low' },
    {
      id: 'm2',
      label: 'Deep',
      efforts: [
        { id: 'high', label: 'High' },
        { id: 'max', label: 'Max' },
      ],
      defaultEffort: 'high',
    },
  ],
  model: 'm1',
  effort: 'low',
};
const PERMISSIONS = (current: string) => ({
  value: current,
  rows: [
    { id: 'read-only', label: 'Read only' },
    { id: 'default', label: 'Ask first' },
    { id: 'full-access', label: 'Full access' },
  ],
});

test('when the Mac is on a permission the phone may not set, a careful one stands in; the chat never starts on the Mac’s own', async () => {
  const v = await mount(
    (m) => (m === 'options.get' ? { ...MODELS, permission: PERMISSIONS('full-access') } : m === 'chat.start' ? { chatId: 'c' } : undefined),
    { media: fakeMedia().media },
  );
  await click('New session');
  await click('Model, Fast Low');
  assert.ok(v.host.querySelector('button[aria-label="Permissions, Read only"]'), 'the most careful one allowed');
  await click('Close');
  await inputText('Describe a task or ask a question', 'go');
  await click('Start chat');
  assert.equal(v.s.calls.find(([m]) => m === 'chat.start')![1].permission, 'read-only');
});

test('a model that does not list the picked effort replaces it with its own default, one that does keeps it', async () => {
  const v = await mount(
    (m) => (m === 'options.get' ? { ...MODELS, permission: PERMISSIONS('default') } : m === 'chat.start' ? { chatId: 'c' } : undefined),
    {
      media: fakeMedia().media,
    },
  );
  await click('New session');
  await click('Model, Fast Low');
  await click('Deep');
  await inputText('Describe a task or ask a question', 'go');
  await click('Start chat');
  assert.deepEqual(
    [v.s.calls.find(([m]) => m === 'chat.start')![1].model, v.s.calls.find(([m]) => m === 'chat.start')![1].effort],
    ['m2', 'high'],
  );
  const same = await mount(
    (m) =>
      m === 'options.get'
        ? {
            ...MODELS,
            models: [
              { ...MODELS.models[0], efforts: [{ id: 'low', label: 'Low' }] },
              { ...MODELS.models[0], id: 'm3', label: 'Twin' },
            ],
            permission: PERMISSIONS('default'),
          }
        : m === 'chat.start'
          ? { chatId: 'c' }
          : undefined,
    { media: fakeMedia().media },
  );
  await click('New session');
  await click('Model, Fast Low');
  await click('Twin');
  await inputText('Describe a task or ask a question', 'go');
  await click('Start chat');
  assert.equal(same.s.calls.find(([m]) => m === 'chat.start')![1].effort, 'low');
});

test('with no project on the computer there is no project chip', async () => {
  const v = await mount((m) => (m === 'projects.list' ? { projects: [] } : undefined), { media: fakeMedia().media });
  await click('New session');
  assert.equal(v.host.querySelector('button[aria-label^="Project,"]'), null);
  assert.ok(v.host.querySelector('button[aria-label^="Agent,"]'));
});

test('a start whose answer was lost as the connection went is still not confirmed when the sheet comes back, is the same start if asked again, and Cancel forgets it', async () => {
  let fail: (e: Error) => void = () => {};
  let starts = 0;
  const v = await mount(
    (m) => {
      if (m !== 'chat.start') return undefined;
      return ++starts === 1 ? new Promise((_ok, no) => (fail = no)) : { chatId: 'claude:new' };
    },
    { media: fakeMedia().media },
  );
  await click('New session');
  await inputText('Describe a task or ask a question', 'Fix it');
  await click('Start chat');
  // the connection goes: the sheet is taken down with it, and the pending start fails
  await v.change({ phase: 'offline', generation: 2, selectedPair: null });
  await act(async () => fail(new Error('Connection closed')));
  await v.change({ phase: 'online', generation: 3, selectedPair: 'p' });
  assert.match(v.host.textContent!, /Start not confirmed\. Check your chats before trying again\./);
  assert.equal(v.host.querySelector<HTMLInputElement>('input[placeholder="Describe a task or ask a question"]')!.value, 'Fix it');
  await click('Start chat');
  const ids = v.s.calls.filter(([m]) => m === 'chat.start').map(([, p]) => p.startId);
  assert.equal(ids[0], ids[1], 'the same start: one chat');
  // leaving the sheet forgets what was lost
  const w = await mount((m) => (m === 'chat.start' ? Promise.reject(new Error('relay disconnected')) : undefined), {
    media: fakeMedia().media,
  });
  await click('New session');
  await inputText('Describe a task or ask a question', 'again');
  await click('Start chat');
  assert.match(w.host.textContent!, /not confirmed/);
  await click('Back');
  await click('New session');
  assert.doesNotMatch(w.host.textContent!, /not confirmed/);
});

test('the model pill opens Select model and ✕ closes it, and a model with no default effort leaves none picked', async () => {
  const v = await mount(
    (m) =>
      m === 'options.get'
        ? {
            models: [
              { id: 'm1', label: 'Fast', efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low' },
              { id: 'm2', label: 'Plain', efforts: [] },
            ],
            model: 'm1',
            effort: 'low',
            permission: PERMISSIONS('default'),
          }
        : m === 'chat.start'
          ? { chatId: 'c' }
          : undefined,
    { media: fakeMedia().media },
  );
  await click('New session');
  await click('Model, Fast Low');
  assert.match(v.host.textContent!, /Select model/);
  assert.match(v.host.textContent!, /Effort/);
  await click('Close');
  assert.doesNotMatch(v.host.textContent!, /Select model/, 'closed again');
  await click('Model, Fast Low');
  await click('Plain');
  assert.ok(v.host.querySelector('button[aria-label="Model, Plain"]'));
  await inputText('Describe a task or ask a question', 'go');
  await click('Start chat');
  assert.equal(v.s.calls.find(([m]) => m === 'chat.start')![1].effort, undefined);
});

test('Start opens the chat page at once with your message; the answer names the chat, which shows the message and the Mac’s warning', async () => {
  let answer: (v: unknown) => void = () => {};
  const v = await mount(
    (m) =>
      m === 'chat.start'
        ? new Promise((r) => (answer = r))
        : m === 'chat.follow'
          ? { rev: 1, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] }
          : undefined,
    { media: fakeMedia().media },
  );
  await click('New session');
  await inputText('Describe a task or ask a question', 'Fix it');
  await click('Start chat');
  // the Mac has not answered: the chat page is up with the message
  assert.ok(v.host.querySelector('[data-screen^="starting:"]'));
  assert.match(v.host.querySelector('[data-screen^="starting:"]')!.textContent!, /Fix it/);
  await act(async () =>
    answer({
      chatId: 'claude:new',
      warning: 'Started, but the permission could not be set.',
    }),
  );
  await flush();
  assert.equal(v.host.querySelector('[data-screen^="starting:"]'), null);
  assert.ok(v.host.querySelector('button[aria-label="Back to chats"]'), 'the new chat opens');
  assert.match(v.host.textContent!, /Fix it/);
  assert.match(v.host.textContent!, /Started, but the permission could not be set\./);
});

test('a refused start goes back to New chat with the text and the error; Back on the starting page leaves it', async () => {
  let refuse: (e: Error) => void = () => {};
  const v = await mount((m) => (m === 'chat.start' ? new Promise((_ok, no) => (refuse = no)) : undefined), { media: fakeMedia().media });
  const field = () => v.host.querySelector<HTMLInputElement>('input[placeholder="Describe a task or ask a question"]');
  await click('New session');
  await inputText('Describe a task or ask a question', 'Fix it');
  await click('Start chat');
  assert.ok(v.host.querySelector('[data-screen^="starting:"]'));
  await act(async () => refuse(new Error('Codex is not set up.')));
  await flush();
  assert.equal(v.host.querySelector('[data-screen^="starting:"]'), null);
  assert.equal(field()!.value, 'Fix it');
  assert.match(v.host.textContent!, /Codex is not set up\./);
  // a second start, left with the system's swipe back: New chat is under it again
  await click('Start chat');
  assert.ok(v.host.querySelector('[data-screen^="starting:"]'));
  await click('Swipe back');
  assert.equal(v.host.querySelector('[data-screen^="starting:"]'), null);
  assert.equal(field()!.value, '', 'the in-flight composer is clear while the recovery draft is retained');
});

test('Back on the starting page restores New chat while its original request remains pending', async () => {
  const v = await mount((m) => (m === 'chat.start' ? new Promise(() => {}) : undefined), { media: fakeMedia().media });
  await click('New session');
  await inputText('Describe a task or ask a question', 'Keep this draft');
  await click('Start chat');
  assert.ok(v.host.querySelector('[data-screen^="starting:"]'));
  const starting = v.host.querySelector('[data-screen^="starting:"]')!;
  await act(async () => (starting.querySelector('button[aria-label="Back"]') as HTMLButtonElement).click());
  await flush();
  assert.equal(v.host.querySelector('[data-screen^="starting:"]'), null);
  assert.ok(v.host.querySelector('[data-screen="newChat"]'));
  assert.equal(v.s.calls.filter(([m]) => m === 'chat.start').length, 1, 'Back does not dispatch a second start');
});

test('changing accounts during a start removes its page and rejects its late reply', async () => {
  let answer: (value: unknown) => void = () => {};
  const v = await mount((m) => (m === 'chat.start' ? new Promise((resolve) => (answer = resolve)) : undefined), {
    media: fakeMedia().media,
  });
  await click('New session');
  await inputText('Describe a task or ask a question', 'Private pending prompt');
  await click('Start chat');
  assert.ok(v.host.querySelector('[data-screen^="starting:"]'));
  await v.change({ user: { id: 'other', name: 'Other' }, generation: 2 });
  assert.equal(v.host.querySelector('[data-screen^="starting:"]'), null);
  await act(async () => answer({ chatId: 'c1' }));
  await flush();
  assert.doesNotMatch(v.host.textContent!, /Private pending prompt/);
  assert.equal(v.host.querySelector('[data-screen="chat:c1"]'), null);
});

test('a new owner reopening the same chat id cannot inherit the first prompt or warning', async () => {
  const v = await mount((m) => (m === 'chat.start' ? { chatId: 'c1', warning: 'Private start warning' } : undefined), {
    media: fakeMedia().media,
  });
  await click('New session');
  await inputText('Describe a task or ask a question', 'Private first prompt');
  await click('Start chat');
  assert.match(v.host.textContent!, /Private first prompt/);
  assert.match(v.host.textContent!, /Private start warning/);
  await click('Back to chats');
  await v.change({ user: null, phase: 'signedOut', selectedPair: null, generation: 2 });
  assert.doesNotMatch(v.host.textContent!, /Private first prompt|Private start warning/);
  await v.change({ user: { id: 'other', name: 'Other' }, phase: 'online', selectedPair: 'p', generation: 3 });
  await click('Open chat A chat');
  assert.ok(v.host.querySelector('[data-screen="chat:c1"]'));
  assert.doesNotMatch(v.host.textContent!, /Private first prompt|Private start warning/);
});

test('an image-only new session shows its preview on Starting and keeps it in the chat before the first follow answers', async () => {
  let answer!: (value: unknown) => void;
  const v = await mount(
    (method) =>
      method === 'chat.start' ? new Promise((resolve) => (answer = resolve)) : method === 'chat.follow' ? new Promise(() => {}) : undefined,
    { media: fakeMedia().media },
  );
  await click('New session');
  await click('Add to session');
  await click('Photos');
  await flush();
  await click('Start chat');
  const starting = v.host.querySelector('[data-screen^="starting:"]')!;
  assert.ok(starting);
  assert.equal(starting.querySelectorAll('img[src="data:image/jpeg;base64,QUJD"]').length, 1);
  await act(async () => answer({ chatId: 'claude:photo' }));
  await flush();
  assert.equal(v.host.querySelector('[data-screen^="starting:"]'), null);
  assert.equal(v.host.querySelectorAll('img[src="data:image/jpeg;base64,QUJD"]').length, 1);
});
