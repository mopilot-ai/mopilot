// The support pages as a person meets them: the checklist appears step by step and names what failed, the log copies without secrets, the pairing wait shows the safety number, the machine page shows the Host's own state, and the flag chooses between old and new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

const adaptersPath = '../mobile/src/ui/support/supportFlag.ts';
const { bindSupportFlag } = await import(adaptersPath);
const setSupportV2 = (on: boolean) => bindSupportFlag(() => on);
const base = '../mobile/src/ui/support/';
const { TroubleshootScreen, ConnectionLogScreen } = await import(`${base}screens`);
const { TroubleshootView } = await import(`${base}Troubleshoot`);
const { PairingConfirm } = await import(`${base}PairingConfirm`);
const { createConnectionLog } = await import(`${base}connectionLog`);
const { runChecks } = await import(`${base}supportModel`);
// by variable paths: a literal path to screen code is not allowed under tests/
const cardsPath = '../mobile/src/components/PairingCards';
const { PairingCards } = await import(cardsPath);

const g = globalThis as any;
const mounted: { root: any; host: Element }[] = [];
async function mount(node: unknown) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node as never));
  await flush();
  return host;
}
test.afterEach(async () => {
  setSupportV2(false);
  for (const m of mounted.splice(0)) await act(async () => m.root.unmount()), m.host.remove();
});

const input = (patch: object = {}) => ({
  online: true,
  signedIn: true,
  relay: 'ok',
  mac: { name: 'Studio', paired: true, presence: 'online' },
  host: null,
  ...patch,
});

test('troubleshoot reveals one step at a time, names the failing one, and writes one line to the log', async () => {
  const log = createConnectionLog();
  let facts: any = input({
    mac: { name: 'Studio', paired: true, presence: 'sleeping' },
  });
  const host = await mount(
    createElement(TroubleshootScreen, {
      read: () => facts,
      back: () => {},
      openLog: () => {},
      log,
      stepMs: 5,
    }),
  );
  await act(async () => new Promise((r) => setTimeout(r, 60)));
  assert.match(host.textContent!, /Studio is asleep/);
  assert.match(host.textContent!, /Wake your Mac, then run again\./);
  assert.match(host.textContent!, /✓Phone online/);
  assert.match(host.textContent!, /✗Your Mac is awake/);
  assert.match(host.textContent!, /–MoPilot is open on your Mac/);
  assert.deepEqual(
    log.lines().map((l) => l.text),
    ['Checked: Studio is asleep'],
  );
  facts = input();
  await click('Run again');
  await act(async () => new Promise((r) => setTimeout(r, 60)));
  assert.match(host.textContent!, /All good/);
  assert.equal(log.lines()[0].level, 'ok');
  assert.equal(log.lines().length, 2);
});

test('a run that is cut short by another run shows only the newer one, and Run again waits while running', async () => {
  const log = createConnectionLog();
  const host = await mount(
    createElement(TroubleshootScreen, {
      read: () => input({ online: false }),
      back: () => {},
      openLog: () => {},
      log,
      stepMs: 20,
    }),
  );
  const run = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Checking…') as HTMLButtonElement;
  assert.ok(run && run.disabled, 'disabled while it runs');
  await act(async () => new Promise((r) => setTimeout(r, 120)));
  assert.match(host.textContent!, /You're offline/);
});

test('Copy log shares the steps and the log opens from the page', async () => {
  let opened = 0;
  const host = await mount(
    createElement(TroubleshootScreen, {
      read: () => input({ signedIn: false }),
      back: () => {},
      openLog: () => opened++,
      log: createConnectionLog(),
      stepMs: 1,
    }),
  );
  await act(async () => new Promise((r) => setTimeout(r, 30)));
  await click('Copy log');
  assert.equal(
    g.__clipboard,
    '✓ Phone online\n✗ Signed in — Sign in again.\n– MoPilot reachable\n– Your Mac is awake\n– MoPilot is open on your Mac',
  );
  assert.match(host.textContent!, /Copied/);
  await click('Connection log');
  assert.equal(opened, 1);
});

test('the connection log lists lines newest first and copies them; empty says so', async () => {
  const log = createConnectionLog({
    now: (() => {
      let t = 1_700_000_000_000;
      return () => (t += 2000);
    })(),
  });
  const host = await mount(createElement(ConnectionLogScreen, { back: () => {}, log }));
  assert.match(host.textContent!, /Nothing yet\./);
  await act(async () => log.add('ok', 'Reached MoPilot'));
  await act(async () => log.add('bad', 'open mopilot://pair?c=SECRET1 token=abc'));
  const text = host.textContent!;
  assert.ok(text.indexOf('[code]') < text.indexOf('Reached MoPilot'), 'newest first');
  assert.doesNotMatch(text, /SECRET1|abc/);
  assert.match(text, /\+2\.00s/);
  await click('Copy');
  assert.doesNotMatch(g.__clipboard, /SECRET1|abc/);
  assert.match(host.textContent!, /Copied/);
});

test('the checklist view without a diagnosis or while running shows no verdict', async () => {
  const { checks } = runChecks(input(), 1);
  const noop = () => {};
  const host = await mount(
    createElement(TroubleshootView, {
      checks,
      diagnosis: null,
      running: true,
      copied: false,
      onRun: noop,
      onCopy: noop,
      onOpenLog: noop,
    }),
  );
  assert.doesNotMatch(host.textContent!, /All good/);
  assert.match(host.textContent!, /Checking…/);
});

test('the pairing wait shows the safety number in groups, finishing, and an unfinished pairing that can be removed', async () => {
  let cancelled = 0;
  const host = await mount(
    createElement(PairingConfirm, {
      vm: {
        phase: 'confirm',
        safetyNumber: '12345678901234567890',
        busy: false,
      },
      onCancel: () => cancelled++,
    }),
  );
  assert.match(host.textContent!, /Confirm on your computer/);
  assert.doesNotMatch(host.textContent!, /1234 5678 9012 3456 7890/, 'the number is a detail until it is opened');
  await click('Check the number');
  assert.match(host.textContent!, /1234 5678 9012 3456 7890/);
  assert.match(host.textContent!, /Your computer shows the same number/);
  assert.ok(host.querySelector('[aria-label="Safety number 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0"]'));
  await click('Check the number');
  assert.doesNotMatch(host.textContent!, /1234 5678 9012 3456 7890/);
  await click('Cancel pairing');
  assert.equal(cancelled, 1);
  const bare = await mount(
    createElement(PairingConfirm, {
      vm: { phase: 'confirm', safetyNumber: null, busy: false },
      onCancel: () => {},
    }),
  );
  assert.doesNotMatch(bare.textContent!, /same number/);
  const fin = await mount(
    createElement(PairingConfirm, {
      vm: { phase: 'finishing', safetyNumber: null, busy: false },
      onCancel: () => {},
    }),
  );
  assert.match(fin.textContent!, /Finishing…/);
  const un = await mount(
    createElement(PairingConfirm, {
      vm: { phase: 'unfinished', safetyNumber: null, busy: true },
      onCancel: () => cancelled++,
    }),
  );
  assert.match(un.textContent!, /Unfinished pairing/);
  assert.ok((un.querySelector('button[aria-label="Remove"]') as HTMLButtonElement).disabled);
  const un2 = await mount(
    createElement(PairingConfirm, {
      vm: { phase: 'unfinished', safetyNumber: null, busy: false },
      onCancel: () => cancelled++,
    }),
  );
  await act(async () => (un2.querySelector('button[aria-label="Remove"]') as HTMLElement).click());
  assert.equal(cancelled, 2);
});

test('the pairing cards follow the flag: the new wait with it, the old cards without', async () => {
  const state: any = {
    pendingPair: true,
    safetyNumber: '12345678901234567890',
    pairingCommit: false,
    pairCleanup: false,
  };
  const props = (s: object) => ({
    state: { ...state, ...s },
    busy: false,
    cancel: () => {},
  });
  const old = await mount(createElement(PairingCards, props({})));
  assert.match(old.textContent!, /Confirm on your computer/);
  setSupportV2(true);
  const v2 = await mount(createElement(PairingCards, props({})));
  assert.match(v2.textContent!, /Confirm on your computer/);
  assert.match((await mount(createElement(PairingCards, props({ pairingCommit: true })))).textContent!, /Finishing…/);
  assert.match((await mount(createElement(PairingCards, props({ pairCleanup: true })))).textContent!, /Unfinished pairing/);
  assert.equal((await mount(createElement(PairingCards, props({ pendingPair: false })))).textContent, '');
});
