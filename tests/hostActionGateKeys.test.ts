// The browser action gate reads the focused element for every key press (#5599): Backspace, Delete and arrows in a plain text field are ordinary on a high-risk site, so its saved or task allowance covers them; a key on a control nobody could read still asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { createActionGate } = require('../electron/capabilities/browser/hostActionGate.cjs');

const CHASE = 'https://secure.chase.com/web/auth/dashboard';
const CHASE_ORIGIN = 'https://secure.chase.com';
const ctx = { chatId: 'c1', segmentId: 's1' };

/** What the page agent reports for a plain text field ("Where to?"). */
const field = (o: any = {}) => ({
  name: 'Where to?',
  button: false,
  role: 'textbox',
  editable: true,
  secret: false,
  payment: false,
  consent: null,
  submits: false,
  form: null,
  ...o,
});

function gate(answer: (req: any) => any, focused: () => any) {
  const asked: any[] = [];
  const reads: any[] = [];
  const grants = new OriginGrants({ confirmAction: async (req: any) => (asked.push(req), answer(req)), ask: async () => null });
  const tabs = {
    intent: async (_tab: any, target: any) => (reads.push(target), focused()),
    awaitUser: async (_tab: any, promise: Promise<any>) => promise,
  };
  const act = createActionGate({ tabs, grants, pageGate: async () => undefined, checkPage: () => undefined, refused: null });
  const press = (keys: string) => act({ url: CHASE }, ctx, { kind: 'key', keys, summary: `press ${keys}` });
  return { press, asked, reads, grants };
}

test('one yes to a Backspace in a text field on a banking site covers the next editing and arrow keys for good', async () => {
  const { press, asked, reads, grants } = gate((req) => (req.always ? 'always' : true), field);
  assert.equal(await press('BackSpace'), true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].always, true, 'the card offers Always allow on this site');
  assert.equal(asked[0].summary, 'press BackSpace');
  assert.equal(grants.actionsAllowed('c1', CHASE_ORIGIN), true);
  for (const keys of ['BackSpace', 'Delete', 'ArrowDown', 'Escape', 'Tab']) assert.equal(await press(keys), false, keys);
  assert.equal(asked.length, 1);
  // the focus was read for each press, and again after the one card
  assert.deepEqual(reads, Array(7).fill({}));
});

test('a key while the focus is on a button, in an unreadable frame or nowhere readable still asks once each time', async () => {
  for (const focused of [() => field({ button: true, role: 'button', editable: false }), () => ({ unreadable: true }), () => null]) {
    const { press, asked, grants } = gate(() => true, focused);
    grants.allowActions(CHASE_ORIGIN);
    assert.equal(await press('BackSpace'), true);
    assert.equal(await press('BackSpace'), true);
    assert.equal(asked.length, 2);
    assert.equal(asked[0].always, undefined);
  }
});

test('a submitting key is still read and asks on a saved site; the field changing under an answered card refuses the key', async () => {
  const saved = gate(() => true, field);
  saved.grants.allowActions(CHASE_ORIGIN);
  assert.equal(await saved.press('Enter'), true);
  assert.equal(saved.asked[0].always, undefined);

  let reads = 0;
  const moved = gate(
    () => true,
    () => (reads++ ? field({ button: true, role: 'button', editable: false }) : field()),
  );
  await assert.rejects(moved.press('BackSpace'), /The control changed while you answered/);
});

test('a key after a Tab lands on a control nobody read and asks; a key that leaves a bot check is not refused, typing into one is', async () => {
  const saved = gate(() => true, field);
  saved.grants.allowActions(CHASE_ORIGIN);
  for (const keys of ['Tab ArrowDown', 'shift+Tab Delete']) assert.equal(await saved.press(keys), true, keys);
  assert.equal(saved.asked.length, 2);
  assert.equal(saved.asked[0].always, undefined);
  assert.equal(await saved.press('ArrowDown Tab'), false, 'a Tab that ends the sequence moves on from a read field');

  const bot = gate(
    () => true,
    () => ({ ...field(), botCheck: true }),
  );
  for (const keys of ['Escape', 'Tab', 'PageDown']) assert.equal(await bot.press(keys), true, keys);
  await assert.rejects(bot.press('x'), (e: any) => e.code === 'bot_check');
  await assert.rejects(bot.press('Enter'), (e: any) => e.code === 'bot_check');
});
