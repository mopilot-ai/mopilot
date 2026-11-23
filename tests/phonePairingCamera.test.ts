// Pairing through the camera as the real expo-camera behaves: every frame reports the code, a camera can fail to start, and only the listed barcode types are read. The paste field always works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText, openCodeEntry } from './support/phone/component-kit';
import { CameraView, useCameraPermissions } from './support/phone/camera';
const pairingPath = '../mobile/src/screens/Pairing';
const { Pairing } = await import(pairingPath);

const g = globalThis as any;
async function mount(pair: (...args: any[]) => Promise<void>, props: object = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Pairing, { start: 'scan', runtime: { pair }, back: () => {}, ...props })));
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
  g.__phoneScanFrames = undefined;
  g.__phoneCameraProps = undefined;
};

test('the sheet opens on the camera; a code it reports in every frame pairs at once and only once, and only QR codes are asked for', async () => {
  reset();
  const sent: any[] = [];
  const view = await mount(async (...args) => void sent.push(args));
  await flush();
  assert.deepEqual(g.__phoneCameraProps.barcodeScannerSettings, { barcodeTypes: ['qr'] });
  await click('Camera preview');
  assert.doesNotMatch(view.host.textContent!, /Camera preview/, 'the scanner closes after the first read');
  assert.deepEqual(sent, [['scanned code', 'Phone']], 'a scan pairs at once, once');
  await view.unmount();
});

test('while a scanned code pairs the viewfinder says so; a failure says why and the next scan is a tap away, not a loop on the old code', async () => {
  reset();
  let fail!: (e: Error) => void;
  const attempts: Array<Promise<void>> = [];
  const view = await mount(
    () => {
      const attempt = new Promise<void>((_, reject) => (fail = reject));
      attempts.push(attempt);
      return attempt;
    },
    { account: 'ann@example.com' },
  );
  await flush();
  await click('Camera preview');
  assert.match(view.host.textContent!, /Connecting…/);
  assert.equal(document.querySelector('input[placeholder="Paste pairing code"]'), null, 'the scanned code is not put in a field');
  await act(async () => fail(new Error('relay: forbidden')));
  assert.match(view.host.textContent!, /This computer uses a different MoPilot account\. You're signed in as ann@example\.com\./);
  assert.doesNotMatch(view.host.textContent!, /Use the same account on both|Code read/, 'the line says it: no log under it');
  assert.doesNotMatch(view.host.textContent!, /relay: forbidden|Camera preview/);
  await click('Scan again');
  assert.match(view.host.textContent!, /Camera preview/);
  assert.doesNotMatch(view.host.textContent!, /different MoPilot account/, 'the old error goes with the new scan');
  await click('Camera preview');
  assert.equal(attempts.length, 2);
  await act(async () => fail(new Error('relay: taken')));
  await view.unmount();
});

test("the form starts with the phone's own name, which the person may change", async () => {
  reset();
  const sent: any[] = [];
  const view = await mount(async (...args) => void sent.push(args), { defaultName: 'iPhone' });
  await openCodeEntry();
  assert.doesNotMatch(view.host.textContent!, /Camera preview/, 'the camera stops for the form');
  assert.equal(document.querySelector('input[placeholder="Phone name"]'), null, 'the name is behind Advanced');
  assert.match(view.host.textContent!, /Paste the code you copied from MoPilot on your computer\./);
  await inputText('Paste pairing code', 'pasted code');
  await click('Connect');
  await click('Advanced');
  assert.equal((document.querySelector('input[placeholder="Phone name"]') as HTMLInputElement).value, 'iPhone');
  await inputText('Phone name', 'Ann’s iPhone');
  await click('Connect');
  assert.deepEqual(sent, [
    ['pasted code', 'iPhone'],
    ['pasted code', 'Ann’s iPhone'],
  ]);
  await click('Scan instead');
  await flush();
  assert.match(view.host.textContent!, /Camera preview/, 'back to a running camera');
  await view.unmount();
});

test('a camera that cannot start closes the scanner and leaves the paste field, and is only retried when asked', async () => {
  reset();
  g.__phoneCameraMount = 'error';
  const sent: any[] = [];
  const view = await mount(async (...args) => void sent.push(args));
  await flush();
  await flush();
  assert.match(view.host.textContent!, /The camera could not start\. Paste a copied code instead\./);
  assert.ok(document.querySelector('input[placeholder="Paste pairing code"]'), 'the code field is open');
  // Scan instead goes back to the viewfinder, where the camera can be tried again
  await click('Scan instead');
  await flush();
  assert.ok(document.querySelector('button[aria-label="Turn on the camera"]'));
  g.__phoneCameraMount = undefined;
  await click('Turn on the camera');
  assert.match(view.host.textContent!, /Camera preview/);
  await openCodeEntry();
  await inputText('Paste pairing code', 'pasted code');
  await click('Connect');
  assert.deepEqual(sent, [['pasted code', 'Phone']]);
  await view.unmount();
});

test('a camera refused for now can be asked for again from the viewfinder', async () => {
  reset();
  g.__phoneCamera = async () => ({ granted: false, canAskAgain: true, status: 'undetermined' });
  const view = await mount(async () => {});
  await flush();
  assert.doesNotMatch(view.host.textContent!, /Camera preview|Camera access is off/);
  assert.ok(document.querySelector('button[aria-label="Paste code instead"]'), 'the other way in stays');
  g.__phoneCamera = async () => ({ granted: true, canAskAgain: true, status: 'granted' });
  await click('Turn on the camera');
  assert.match(view.host.textContent!, /Camera preview/);
  await view.unmount();
});

test('a camera only Settings can turn on says so, opens Settings, and starts when the person comes back with it on', async () => {
  reset();
  g.__phoneOpenedSettings = false;
  g.__phoneCamera = async () => ({ granted: false, canAskAgain: false, status: 'denied' });
  const view = await mount(async () => {});
  await flush();
  assert.match(view.host.textContent!, /Camera access is off\. Turn it on in Settings, or paste a copied code\./);
  await click('Open Settings');
  assert.equal(g.__phoneOpenedSettings, true);
  // back with it still off: nothing changes
  await act(async () => g.__phoneForeground());
  assert.match(view.host.textContent!, /Camera access is off/);
  g.__phoneCamera = async () => ({ granted: true, canAskAgain: true, status: 'granted' });
  await act(async () => g.__phoneForeground());
  assert.match(view.host.textContent!, /Camera preview/);
  assert.doesNotMatch(view.host.textContent!, /Camera access is off/);
  assert.equal(g.__phoneForeground, undefined, 'it stops watching once the camera runs');
  await view.unmount();
});

test('the sheet says where the code is on the computer, and says computer, never Mac', async () => {
  reset();
  const view = await mount(async () => {});
  await flush();
  assert.match(view.host.textContent!, /Scan the code on your computer/);
  assert.match(view.host.textContent!, /Connect your phone/);
  assert.doesNotMatch(view.host.textContent!, /Mac\b/);
  await view.unmount();
});

test('the camera stand-in answers as expo-camera does: a permission with a granted flag, and no scan unless the type is asked for', async () => {
  reset();
  g.__phoneCamera = async () => ({ canAskAgain: true });
  const [, request] = (useCameraPermissions as any)();
  await assert.rejects(request(), /granted/, 'a permission answer always says whether it is granted');
  const scans: Array<{ type: string; data: string }> = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(CameraView as any, { onBarcodeScanned: (e: any) => scans.push(e) })));
  await click('Camera preview');
  assert.equal(scans.length, 0, 'a camera that was not told to read QR codes reads nothing');
  await act(async () =>
    root.render(
      createElement(CameraView as any, {
        barcodeScannerSettings: { barcodeTypes: ['ean13'] },
        onBarcodeScanned: (e: any) => scans.push(e),
      }),
    ),
  );
  await click('Camera preview');
  assert.equal(scans.length, 0, 'nor one told to read other types');
  await act(async () =>
    root.render(
      createElement(CameraView as any, { barcodeScannerSettings: { barcodeTypes: ['qr'] }, onBarcodeScanned: (e: any) => scans.push(e) }),
    ),
  );
  await click('Camera preview');
  assert.deepEqual(
    scans.map((s) => [s.type, s.data]),
    [
      ['qr', 'scanned code'],
      ['qr', 'scanned code'],
    ],
    'it reports the code in each frame while it is in view',
  );
  await act(async () => root.unmount());
  host.remove();
});
