// A chat that stays open while its computer goes away and comes back reads its controls (the model pill, the ⋯ settings) again: its way to the computer is bound to the connection it is on now, not to the offline one it was drawn under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';

import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const ownedPath = '../mobile/src/remote/useOwnedRequest';
const { Thread } = await import(threadPath);
const { useOwnedRequest } = await import(ownedPath);

const OPTIONS = {
  models: [{ id: 'm1', label: 'Dev Fast', efforts: [], defaultEffort: null }],
  model: 'm1',
  accounts: [],
  permissions: [],
  macOnly: [],
};

test('the controls are read when the computer comes back to a chat drawn while it was away', async () => {
  const link = { selectedPair: null as string | null, generation: 2 };
  const asked: string[] = [];
  const runtime: any = {
    snapshot: () => ({ ...link }),
    onEvent: () => () => {},
    request: async (method: string) => {
      // away: nothing answers
      if (link.selectedPair === null) throw new Error('Computer is offline');
      asked.push(method);
      if (method === 'chat.follow')
        return { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [{ role: 'user', text: 'Hi' }] };
      return method === 'options.get' ? OPTIONS : {};
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const screen = (offline: boolean) => createElement(Thread, { runtime, chatId: 'c', back: () => {}, offline, drafts: fakeDraft('') });
  // drawn while the computer is away: nothing answers
  await act(async () => root.render(screen(true)));
  await flush();
  assert.equal(asked.length, 0);
  // the computer is back: the same screen reads what the pill and the menu need
  link.selectedPair = 'p';
  await act(async () => root.render(screen(false)));
  await flush();
  assert.ok(asked.includes('options.get'), 'the controls are read once the computer is back');
  assert.match(host.textContent!, /Dev Fast/, 'and the model pill shows');
  await act(async () => root.unmount());
  host.remove();
});

function Probe({ runtime, out }: any) {
  out.request = useOwnedRequest(runtime);
  return null;
}

test('the way to the computer is kept while the connection stays and made again when it changes', async () => {
  const link = { selectedPair: 'p' as string | null, generation: 1 };
  const runtime: any = { snapshot: () => ({ ...link }), request: async () => ({}) };
  const out: any = {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(async () => root.render(createElement(Probe, { runtime, out })));
  await render();
  const first = out.request;
  await render();
  assert.equal(out.request, first, 'the same connection keeps it');
  link.generation = 2;
  await render();
  assert.notEqual(out.request, first, 'a new generation binds a new one');
  const second = out.request;
  link.selectedPair = null;
  await render();
  assert.equal(out.request, second, 'the computer going away keeps it (it is refused until the same computer is back)');
  await act(async () => root.unmount());
  host.remove();
});

test('a screen never takes another computer than the one it was opened on, and one opened while away takes the first that connects', async () => {
  const link = { selectedPair: 'a' as string | null, generation: 1 };
  const sent: string[] = [];
  const runtime: any = { snapshot: () => ({ ...link }), request: async (method: string) => (sent.push(method), {}) };
  const out: any = {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(async () => root.render(createElement(Probe, { runtime, out })));
  await render();
  await out.request('one');
  // the computer goes away and the same one returns: the screen reaches it again
  link.selectedPair = null;
  await render();
  await assert.rejects(out.request('while away'), /changed/);
  link.selectedPair = 'a';
  link.generation = 2;
  await render();
  await out.request('two');
  // another computer is selected: this screen is not its screen
  link.selectedPair = 'b';
  link.generation = 3;
  await render();
  await assert.rejects(out.request('other'), /changed/);
  assert.deepEqual(sent, ['one', 'two']);
  await act(async () => root.unmount());
  host.remove();
  // opened while away: the first computer that connects is its own
  const away = { selectedPair: null as string | null, generation: 5 };
  const late: any = { snapshot: () => ({ ...away }), request: async (method: string) => (sent.push(method), {}) };
  const host2 = document.createElement('div');
  document.body.append(host2);
  const root2 = createRoot(host2);
  const out2: any = {};
  const render2 = () => act(async () => root2.render(createElement(Probe, { runtime: late, out: out2 })));
  await render2();
  away.selectedPair = 'c';
  await render2();
  await out2.request('three');
  away.selectedPair = 'd';
  await render2();
  await assert.rejects(out2.request('four'), /changed/);
  assert.deepEqual(sent, ['one', 'two', 'three']);
  await act(async () => root2.unmount());
  host2.remove();
});
