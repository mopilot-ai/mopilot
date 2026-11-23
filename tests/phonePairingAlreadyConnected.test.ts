// A pairing code for the Mac this phone is connected to now is not paired again (that would drop a working connection): the sheet says the Mac is already connected and Done closes it; the same Mac while away, or another Mac, still pairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText, openCodeEntry } from './support/phone/component-kit';
import './support/phone/camera';
const pairingPath = '../mobile/src/screens/Pairing';
const checkPath = '../mobile/src/alreadyConnected';
const { Pairing } = await import(pairingPath);
const { connectedPairFor } = await import(checkPath);

const g = globalThis as any;
const ONLINE = { phase: 'online', selectedPair: 'p', pairs: [{ pairId: 'p', macId: 'mac-1', name: 'Studio Mac' }] };
const code = (macId: unknown) => JSON.stringify({ v: 3, macId, relay: 'wss://relay.example' });

test('connectedPairFor: only the selected pair, only while online, only a code that names its Mac', () => {
  assert.equal(connectedPairFor(code('mac-1'), ONLINE)?.pairId, 'p');
  assert.equal(connectedPairFor(`  ${code('mac-1')}\n`, ONLINE)?.pairId, 'p', 'a pasted code keeps its spaces');
  assert.equal(connectedPairFor(code('mac-1'), { ...ONLINE, phase: 'offline' }), null, 'a Mac that is away may be paired again');
  assert.equal(connectedPairFor(code('mac-1'), { ...ONLINE, selectedPair: 'q' }), null);
  assert.equal(connectedPairFor(code('mac-2'), ONLINE), null, 'another Mac');
  assert.equal(connectedPairFor(code(7), ONLINE), null);
  assert.equal(connectedPairFor('null', ONLINE), null);
  assert.equal(connectedPairFor('not a code', ONLINE), null, 'pairing itself says what is wrong with it');
  assert.equal(connectedPairFor(code('mac-1'), undefined), null);
});

async function mount(snapshot: any) {
  g.__phoneCamera = async () => ({ granted: true, canAskAgain: true, status: 'granted' });
  const sent: unknown[] = [];
  let closed = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime = { pair: async (...args: unknown[]) => void sent.push(args), snapshot: () => snapshot };
  await act(async () => root.render(createElement(Pairing, { start: 'scan', runtime, back: () => closed++ })));
  await flush();
  const paste = async (text: string) => {
    await openCodeEntry();
    await inputText('Paste pairing code', text);
    await click('Connect');
  };
  return {
    host,
    sent,
    paste,
    closed: () => closed,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('pasting the connected Mac’s code says so and does not pair; Done closes the sheet', async () => {
  const v = await mount(ONLINE);
  await v.paste(code('mac-1'));
  assert.deepEqual(v.sent, [], 'the working connection is not replaced');
  assert.match(v.host.textContent!, /Studio Mac is already connected\./);
  await click('Done');
  assert.equal(v.closed(), 1);
  await v.unmount();
  const unnamed = await mount({ ...ONLINE, pairs: [{ pairId: 'p', macId: 'mac-1', name: '  ' }] });
  await unnamed.paste(code('mac-1'));
  assert.match(unnamed.host.textContent!, /This computer is already connected\./);
  await unnamed.unmount();
});

test('the same Mac while away, and another Mac, still pair', async () => {
  const away = await mount({ ...ONLINE, phase: 'offline' });
  await away.paste(code('mac-1'));
  assert.equal(away.sent.length, 1, 'mending a broken pairing still works');
  await away.unmount();
  const other = await mount(ONLINE);
  await other.paste(code('mac-2'));
  assert.equal(other.sent.length, 1);
  assert.doesNotMatch(other.host.textContent!, /already connected/);
  await other.unmount();
});
