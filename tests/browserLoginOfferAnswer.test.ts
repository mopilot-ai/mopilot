// The user's answer to a "Save password?" offer (loginAssist.cjs answer, ipc/browserLogins.cjs): it names the offer its
// bar showed, so a Save never stores a newer sign-in that replaced it unseen (#1988), and it closes the bar everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakePage } from './helpers/loginAssistPage.ts';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createLoginAssist } = require('../electron/capabilities/browser/loginAssist.cjs');
const { register } = require('../electron/app/ipc/browserLogins.cjs');

const prefixOf = (code: string) => code.match(/"(mopilot-login:[^"]+:)"/)![1];
const send = (wc: any, message: string) => wc.emit('console-message', { message });
/** The offer id main last told the pane about: the one its bar shows and answers. */
const lastOffer = (notes: any[]) => notes.findLast((n) => n.kind === 'offer')?.offerId;

test('Save on the bar of an offer a newer sign-in replaced stores nothing; the newer one stays offered', async () => {
  const notes: any[] = [];
  const saved: any[] = [];
  const store = {
    available: () => true,
    isNever: () => false,
    list: () => [],
    get: () => null,
    save: (...a: any[]) => (saved.push(a), true),
    setNever: () => true,
  };
  const assist = createLoginAssist({
    store: () => store,
    confirm: async () => true,
    isAgent: () => false,
    notify: (wc: any, d: any) => notes.push({ page: wc.id, ...d }),
  });
  const wc = fakePage();
  let signedIn: any = { origin: 'https://a.test', username: 'bob', password: 'b' };
  wc.answer = (code: string) => (code.includes('.take()') ? signedIn : undefined);
  assist.attach(wc);
  wc.emit('dom-ready');
  const submit = async () => {
    send(wc, `${prefixOf(wc.scripts[0].code)}submitted`);
    await tick();
    await tick();
    wc.emit('did-navigate');
  };
  await submit();
  const bob = lastOffer(notes);
  signedIn = { origin: 'https://a.test', username: 'cy', password: 'c' };
  await submit();
  const cy = lastOffer(notes);
  assert.notEqual(bob, cy);
  assert.equal(assist.answer(7, 'save', bob), 'gone');
  assert.equal(assist.answer(7, 'save', undefined), 'gone');
  assert.deepEqual(saved, []);
  assert.deepEqual(
    notes.map((n) => n.kind),
    ['offer', 'offer'],
    'the newer offer stays on the bar',
  );
  assert.equal(assist.answer(7, 'save', cy), 'saved');
  assert.deepEqual(saved, [['https://a.test', 'cy', 'c']]);
});

test('answering an offer closes the bar in every window showing the page', async () => {
  const notes: any[] = [];
  const store = { available: () => true, isNever: () => false, list: () => [], get: () => null, save: () => true, setNever: () => true };
  const assist = createLoginAssist({
    store: () => store,
    confirm: async () => true,
    isAgent: () => false,
    notify: (wc: any, d: any) => notes.push({ page: wc.id, ...d }),
  });
  const wc = fakePage();
  wc.answer = (code: string) => (code.includes('.take()') ? { origin: 'https://a.test', username: '', password: 'p' } : undefined);
  assist.attach(wc);
  wc.emit('dom-ready');
  send(wc, `${prefixOf(wc.scripts[0].code)}submitted`);
  await tick();
  await tick();
  wc.emit('did-navigate');
  assert.equal(assist.answer(7, 'dismiss', lastOffer(notes)), 'dismissed');
  assert.deepEqual(
    notes.map((n) => n.kind),
    ['offer', 'offer_gone'],
  );
});

test('IPC browser:answerLoginOffer: the page id, choice and offer id go to main; anything else is gone', async () => {
  const handlers: Record<string, Function> = {};
  const calls: any[] = [];
  register(
    { handle: (ch: string, fn: Function) => (handlers[ch] = fn) },
    {
      store: () => ({ list: () => [] }),
      assist: () => ({ answer: (id: number, c: string, o: string) => (calls.push([id, c, o]), 'saved') }),
      webContents: { fromId: () => null },
      panelSessions: () => [],
      confirm: async () => true,
    },
  );
  assert.equal(await handlers['browser:answerLoginOffer']({}, 7, 'save', 'o1'), 'saved');
  assert.equal(await handlers['browser:answerLoginOffer']({}, 7, undefined), 'saved');
  assert.equal(await handlers['browser:answerLoginOffer']({}, '7', 'save', 'o1'), 'gone');
  assert.deepEqual(calls, [
    [7, 'save', 'o1'],
    [7, 'undefined', 'undefined'],
  ]);
});
