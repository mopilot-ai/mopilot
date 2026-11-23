// The errand allowance through the browser tools (hostActionGate.cjs, script.cjs): the text the agent types and the message_kind it
// declares reach the site table's check with the send, from browser_computer (and chrome_computer, which runs it) and from
// browser_script's click and press options; an earlier call's declaration never carries over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OriginGrants, world } from './support/browser-host-tools/fixture';
import { ops, loc } from './support/browser-script/fixture';

const SEND_BUTTON = { tag: 'button', role: 'button', name: 'Send', button: true };

function sendWorld() {
  const confirms: any[] = [];
  const grants = new OriginGrants({
    file: null,
    anchor: () => 'ask',
    ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
    confirmAction: async ({ signal: _s, ...q }: any) => (confirms.push(q), q.errand ? 'errand' : true),
  });
  grants.set('https://a.example', 'write');
  return { ...world({ grants }), confirms, grants };
}

test('browser_computer: typed text and message_kind go with the Send click; once allowed, the next ordinary one needs no card', async () => {
  const w = sendWorld();
  await w.call('browser_computer', { action: 'type', text: 'Where is my order W100200300?' });
  w.tabs.intentValue = SEND_BUTTON;
  await w.call('browser_computer', { action: 'left_click', coordinate: [5, 5], message_kind: 'ordinary' });
  assert.equal(w.confirms.length, 1);
  assert.equal(w.confirms[0].errand, true);
  assert.equal(w.grants.errands.has('c1', 'https://a.example'), true);
  w.tabs.intentValue = null;
  await w.call('browser_computer', { action: 'type', text: 'What can you offer for the delay?' });
  w.tabs.intentValue = SEND_BUTTON;
  await w.call('browser_computer', { action: 'left_click', coordinate: [5, 5], message_kind: 'ordinary' });
  assert.equal(w.confirms.length, 1, 'covered');
  // a click that declares nothing asks, though the call before it declared ordinary
  w.tabs.intentValue = null;
  await w.call('browser_computer', { action: 'type', text: 'Thanks.' });
  w.tabs.intentValue = SEND_BUTTON;
  await w.call('browser_computer', { action: 'left_click', coordinate: [5, 5] });
  assert.equal(w.confirms.length, 2);
  assert.equal(w.confirms[1].commits, 'the agent did not say what kind of message it is');
  // accepting an offer asks whatever the agent says
  w.tabs.intentValue = null;
  await w.call('browser_computer', { action: 'type', text: 'Yes, apply the credit.' });
  w.tabs.intentValue = SEND_BUTTON;
  await w.call('browser_computer', { action: 'left_click', coordinate: [5, 5], message_kind: 'ordinary' });
  assert.equal(w.confirms.at(-1).commits, 'it may accept or decline an offer');
});

test("browser_script: fill, type and raw typing carry their text to the gate; click and press take messageKind from the locator's options", async () => {
  const acts: any[] = [];
  const w = ops({ act: async (_tab: any, a: any) => void acts.push(a) });
  const { d, tabs } = w;
  tabs.st = { ...tabs.st, tag: 'textarea', editable: true };
  await d('loc.act', loc({ action: 'fill', value: 'Where is my order?' }));
  await d('loc.act', loc({ action: 'type', value: ' Thanks.' }));
  await d('cua.type', { tab: 't1', text: '!' });
  assert.deepEqual(
    acts.splice(0).map((a) => [a.kind, a.value ?? a.text]),
    [
      ['fill', 'Where is my order?'],
      ['type', ' Thanks.'],
      ['type', '!'],
    ],
  );
  tabs.st = { ...tabs.st, tag: 'button', editable: false };
  await d('loc.act', loc({ action: 'click', options: { messageKind: 'ordinary' } }));
  await d('loc.act', loc({ action: 'press', value: 'Enter', options: { messageKind: 'commits' } }));
  assert.deepEqual(
    acts.map((a) => [a.kind, a.messageKind]),
    [
      ['click', 'ordinary'],
      ['key', 'commits'],
    ],
  );
});
