// What a screen reader gets: headings, labelled controls and fields, selected choices, a safety number read digit by digit, and live status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { groupSafety, speakSafety } from '../shared/remote/safetyNumber.mjs';
const appPath = '../mobile/src/MobileApp';
const uiPath = '../mobile/src/components/ui';
const { MobileApp } = await import(appPath);
const { Button, Field, Heading, Title } = await import(uiPath);

const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return host;
}

test('the safety number is grouped for comparing and spoken digit by digit', () => {
  assert.equal(groupSafety('123456'), '123 456');
  assert.equal(groupSafety('1234'), '123 4');
  assert.equal(groupSafety('ab12'), 'ab12', 'anything that is not only digits is shown as it came');
  assert.equal(groupSafety(''), '');
  assert.equal(groupSafety(null), '');
  assert.equal(groupSafety(undefined), '');
  assert.equal(speakSafety('123456'), '1 2 3 4 5 6');
  assert.equal(speakSafety('12 34'), '1 2 3 4');
});

test('buttons are labelled and report disabled and selected; headings and fields are named', async () => {
  const host = await mount(
    createElement(
      'div',
      null,
      createElement(Button, { title: 'Open', onPress: () => {} }),
      createElement(Button, { title: 'Open', label: 'Open Studio Mac', disabled: true, onPress: () => {} }),
      createElement(Button, { title: '✓ Fast', selected: true, onPress: () => {} }),
      createElement(Button, { title: 'Slow', selected: false, onPress: () => {} }),
      createElement(Heading, null, 'Computers'),
      createElement(Title, null, 'Settings'),
      createElement(Field, { placeholder: 'Phone name', value: '', onChangeText: () => {} }),
      createElement(Field, { placeholder: 'Message', accessibilityLabel: 'Message this chat', value: '', onChangeText: () => {} }),
      createElement(Field, { placeholder: 'Name', accessibilityLabel: undefined, value: '', onChangeText: () => {} }),
    ),
  );
  const buttons = [...host.querySelectorAll('button')];
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('aria-label')),
    ['Open', 'Open Studio Mac', 'Fast', 'Slow'],
  );
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('aria-disabled')),
    ['false', 'true', 'false', 'false'],
  );
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('aria-selected')),
    [null, null, 'true', 'false'],
  );
  assert.equal(buttons[2].textContent, '✓ Fast', 'the visible mark stays; the label does not repeat the state');
  assert.deepEqual(
    [...host.querySelectorAll('[role="header"]')].map((h) => h.textContent),
    ['Computers', 'Settings'],
  );
  assert.deepEqual(
    [...host.querySelectorAll('input')].map((i) => i.getAttribute('aria-label')),
    ['Phone name', 'Message this chat', 'Name'],
  );
});

const pairing = {
  phase: 'ready',
  generation: 1,
  user: { id: 'u' },
  pairs: [],
  selectedPair: null,
  safetyNumber: '123456',
  pendingPair: true,
  error: null,
};
const appWith = async (snap: any, handler: (m: string, p: any) => unknown = () => ({ chats: [] })) => {
  const s = scripted(handler, snap);
  s.runtime.start = async () => {};
  return mount(createElement(MobileApp, { runtime: s.runtime }));
};

test('pairing shows the number grouped, read by digit, and says what to do when the numbers differ, without making comparing a step', async () => {
  const host = await appWith(pairing);
  assert.doesNotMatch(host.textContent!, /123 456/, 'the number is a detail, not the first thing on the screen');
  assert.equal(host.querySelector('[aria-label^="Safety number"]'), null);
  assert.equal(host.querySelector('button[aria-label="Check the number"]')?.getAttribute('aria-expanded'), 'false');
  await click('Check the number');
  assert.equal(host.querySelector('button[aria-label="Check the number"]')?.getAttribute('aria-expanded'), 'true');
  assert.match(host.textContent!, /123 456/);
  assert.ok(host.querySelector('[aria-label="Safety number 1 2 3 4 5 6"]'));
  assert.match(host.textContent!, /If it doesn't, decline there\./);
  assert.equal(host.querySelector('[role="alert"]'), null);
  const waiting = await appWith({ ...pairing, safetyNumber: null });
  assert.match(waiting.textContent!, /Click Connect in MoPilot on your computer\./);
  assert.equal(waiting.querySelector('[aria-label^="Safety number"]'), null);
});

test('a new install signs in with one button, then is walked through turning it on at the computer and pairing', async () => {
  const host = await appWith({ ...pairing, phase: 'signedOut', user: null, pendingPair: false, safetyNumber: null });
  assert.ok(host.querySelector('button[aria-label="Sign in"]'));
  assert.doesNotMatch(host.textContent!, /1\. Sign in/);
  const signedIn = await appWith({ ...pairing, pendingPair: false, safetyNumber: null });
  assert.match(signedIn.textContent!, /No computer of yours yet/);
  assert.match(signedIn.textContent!, /Add a computer to see its chats here\./);
  assert.ok(signedIn.querySelector('button[aria-label="Add a computer"]'));
  assert.doesNotMatch(signedIn.textContent!, /Sign in with your MoPilot account/, 'already signed in');
});

test('chat rows name their chat, and the chat screen labels Send and Stop and its message field', async () => {
  const online = {
    ...pairing,
    phase: 'online',
    pairs: [{ pairId: 'p', macId: 'm' }],
    selectedPair: 'p',
    pendingPair: false,
    safetyNumber: null,
  };
  const host = await appWith(online, (m) =>
    m === 'chats.recent'
      ? { chats: [{ id: 'c1', title: 'Fix login' }, { id: 'c2' }] }
      : m === 'chat.follow'
        ? { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] }
        : {},
  );
  // idle chats are in the list like any other: no fold hides them from a screen reader
  assert.equal(host.querySelector('button[aria-label^="Quiet"]'), null);
  assert.ok(host.querySelector('button[aria-label="Open chat Fix login"]'));
  assert.ok(host.querySelector('button[aria-label="Open chat Untitled chat"]'));
  await click('Open chat');
  assert.ok(host.querySelector('button[aria-label="Send message"]'));
  // one round button: Send now, Stop while a turn runs and nothing is typed (see phoneComposer.test.ts)
  assert.equal(host.querySelector('button[aria-label="Stop this chat’s turn"]'), null);
  // progress is announced only while the turn waits for the person, never as a running clock: phoneTurnLine.test.ts holds that contract
  assert.ok(host.querySelector('input[aria-label="Message this chat"]'));
});
