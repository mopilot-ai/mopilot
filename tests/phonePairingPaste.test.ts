// Adding a computer opens on the camera at once; the system Paste button pairs a copied code in one tap, a text that is no code says what to copy, and a phone too old for the computer is sent to the App Store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
const pairingPath = '../mobile/src/screens/Pairing';
const codePath = '../mobile/src/pairingCode';
const { Pairing } = await import(pairingPath);
const { APP_STORE_URL, isPairingCode } = await import(codePath);

const g = globalThis as any;
const CODE = JSON.stringify({ v: 3, macId: 'mac-1', relay: 'wss://relay.example', code: 'AAAA', exp: 4102444800000 });

async function mount(pair: (...args: any[]) => Promise<void>, props: object = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Pairing, { runtime: { pair }, back: () => {}, ...props })));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const reset = () => {
  g.__phoneCamera = async () => ({ granted: true, canAskAgain: true, status: 'granted' });
  g.__phoneCameraMount = undefined;
  g.__clipboardText = undefined;
  g.__clipboardImage = undefined;
  g.__openedUrls = [];
  g.__linkFails = false;
  g.__setPasteButton(true);
};

test('the sheet opens on the camera with no instruction screen first, and the steps are a link away', async () => {
  reset();
  const view = await mount(async () => {});
  assert.match(view.host.textContent!, /Camera preview/);
  assert.doesNotMatch(view.host.textContent!, /Look for my computer/);
  await click('How to connect');
  assert.match(view.host.textContent!, /Look for my computer/, 'the steps (with the Host tab) are still there');
  await click('Look for my computer');
  assert.match(view.host.textContent!, /Camera preview/, 'and lead back to the camera');
  await view.unmount();
});

test("one tap of the system Paste button pairs a copied code with the phone's own name, in one attempt", async () => {
  reset();
  const sent: any[] = [];
  const view = await mount(async (...args) => void sent.push(args), { defaultName: 'iPhone' });
  g.__clipboardText = `  ${CODE}\n`;
  await click('Paste');
  assert.deepEqual(sent, [[CODE, 'iPhone']], 'the copied text, trimmed, and the name the form never asked for');
  assert.doesNotMatch(view.host.textContent!, /Camera preview/, 'the camera stops once a code is in hand');
  assert.equal(document.querySelector('input[placeholder="Paste pairing code"]'), null, 'no field was opened');
  assert.equal(g.__phonePasteProps.acceptedContentTypes.join(), 'plain-text', 'only text can be pasted');
  await view.unmount();
});

test('a copied text that is no pairing code says what to copy, pairs nothing, and an image is ignored', async () => {
  reset();
  const sent: any[] = [];
  const view = await mount(async (...args) => void sent.push(args));
  g.__clipboardText = 'hello';
  await click('Paste');
  assert.match(view.host.textContent!, /That isn't a MoPilot pairing code\. Copy the code on your computer, then tap Paste\./);
  g.__clipboardImage = true;
  await click('Paste');
  assert.deepEqual(sent, [], 'nothing paired');
  assert.match(view.host.textContent!, /Camera preview/, 'the camera is still running');
  await view.unmount();
});

test("the Paste button's box grows with the text size, from its own height up to 1.6 times it", async () => {
  reset();
  for (const [scale, height] of [
    [undefined, 52],
    [0.8, 52],
    [1.3, 68],
    [3, 83],
  ] as const) {
    g.__phoneFontScale = scale;
    const view = await mount(async () => {});
    assert.equal(g.__phonePasteProps.style.height, height, `font scale ${scale}`);
    await view.unmount();
  }
  g.__phoneFontScale = undefined;
});

test('where the system has no Paste button the paste field is the way in', async () => {
  reset();
  g.__setPasteButton(false);
  const view = await mount(async () => {});
  assert.equal(
    [...document.querySelectorAll('button')].some((b) => b.textContent === 'Paste'),
    false,
  );
  assert.ok(document.querySelector('button[aria-label="Paste code instead"]'));
  await view.unmount();
});

test('a phone too old for the computer says so and offers the App Store; a failure of anything else offers no update', async () => {
  reset();
  let fail!: (e: Error) => void;
  const view = await mount(() => new Promise<void>((_, reject) => (fail = reject)));
  g.__clipboardText = CODE;
  await click('Paste');
  await act(async () => fail(new Error('newer QR')));
  assert.match(view.host.textContent!, /This phone's MoPilot is too old for this computer/);
  await click('Update MoPilot');
  assert.deepEqual(g.__openedUrls, [APP_STORE_URL]);
  g.__linkFails = true;
  await click('Update MoPilot');
  g.__linkFails = false;
  await click('Scan again');
  await click('Paste');
  await act(async () => fail(new Error('relay: taken')));
  assert.doesNotMatch(view.host.textContent!, /Update MoPilot/);
  await view.unmount();
});

test('a person who opened the paste field while the camera was being asked for is not given the camera under it', async () => {
  reset();
  let answer!: (v: any) => void;
  g.__phoneCamera = () => new Promise((resolve) => (answer = resolve));
  const view = await mount(async () => {});
  await click('Paste code instead');
  await act(async () => answer({ granted: true, canAskAgain: true, status: 'granted' }));
  await flush();
  assert.doesNotMatch(view.host.textContent!, /Camera preview/);
  assert.ok(document.querySelector('input[placeholder="Paste pairing code"]'));
  await view.unmount();
});

test("only a text with the pairing code's fields is tried", () => {
  assert.equal(isPairingCode(CODE), true);
  assert.equal(isPairingCode(`\n ${CODE} `), true);
  for (const text of [
    '',
    '   ',
    'hello',
    '[]',
    'null',
    '{',
    '{"v":3}',
    JSON.stringify({ v: 'x', macId: 'a', relay: 'b', code: 'c', exp: 1 }),
  ])
    assert.equal(isPairingCode(text), false, text);
  assert.equal(
    isPairingCode(`{"v":3,"macId":"a","relay":"b","code":"c","exp":1,"pad":"${'x'.repeat(5000)}"}`),
    false,
    'a text too long to be a code',
  );
});
