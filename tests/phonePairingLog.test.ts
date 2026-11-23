// The pairing log: a pairing that stalls or fails says which step it stopped at, with a timeout sentence and a report that holds no code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText, openCodeEntry } from './support/phone/component-kit';
const g = globalThis as any;
const screenPath = '../mobile/src/screens/Pairing';
const logPath = '../mobile/src/pairingLog';
const { Pairing } = await import(screenPath);
const {
  explained,
  failureOutcome,
  needsUpdate,
  pairFailure,
  plainError,
  pairingReport,
  pairingSteps,
  timeoutSentence,
  pairMark,
  PAIR_TIMEOUT_MS,
} = await import(logPath);

const mounted: any[] = [];
async function mount(runtime: any, props: any = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(Pairing, { start: 'scan', runtime, back: () => {}, ...props })));
  return host;
}
test.afterEach(async () => {
  for (const m of mounted.splice(0)) await act(async () => m.root.unmount()), m.host.remove();
  g.__phoneShared = [];
});
const pause = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const SECRET = 'mopilot-pair:SECRETCODE';
async function begin() {
  await openCodeEntry();
  await inputText('Paste pairing code', SECRET);
  await click('Connect');
}

test('the log is pure: steps by outcome, a closed set of names, a report of steps and time only', () => {
  assert.equal(PAIR_TIMEOUT_MS, 30_000);
  assert.deepEqual(pairingSteps('running'), [
    { name: 'Code read', state: 'ok' },
    { name: 'Waiting for the computer', state: 'wait' },
  ]);
  assert.deepEqual(
    pairingSteps('timeout').map((s: any) => s.state),
    ['ok', 'bad'],
  );
  assert.equal(pairingSteps('noAnswer')[1].hint, 'Is it awake and signed in?');
  assert.deepEqual(pairingSteps('badCode'), [{ name: 'Code read', state: 'bad', hint: 'Show a new code on your computer.' }]);
  assert.deepEqual(pairingSteps('timeout').map(pairMark), ['✓', '✗']);
  assert.equal(pairMark(pairingSteps('running')[1]), '…');
  assert.equal(timeoutSentence(30_000), 'Could not connect within 30 s. The log shows where it stopped.');
  assert.equal(failureOutcome(new Error('invalid QR')), 'badCode');
  assert.equal(failureOutcome(new Error('invalid or expired QR')), 'badCode');
  assert.equal(failureOutcome(new Error('untrusted relay')), 'badCode');
  assert.equal(failureOutcome(new Error('invalid pairing data')), 'noAnswer', 'the computer’s reply was bad, not the code');
  assert.equal(failureOutcome(new Error('invalid relay')), 'badCode');
  assert.equal(failureOutcome(new Error('relay connection closed')), 'noAnswer', 'a relay that dropped the connection is not a bad code');
  assert.equal(failureOutcome(new Error('pairing rejected')), 'declined');
  assert.equal(pairingSteps('declined')[1].hint, 'It was declined on the computer.');
  assert.equal(failureOutcome('boom'), 'noAnswer');
  const report = pairingReport('timeout', 30_400);
  assert.equal(report, 'MoPilot pairing report\n✓ Code read\n✗ Waiting for the computer — Is it awake and signed in?\nTime: 30.4 s');
});

test('a failure says what happened and what to do, never a protocol word', () => {
  const line = (text: string, account?: string) => pairFailure(new Error(text), account);
  assert.equal(
    line('relay: forbidden', 'ann@example.com'),
    "This computer uses a different MoPilot account. You're signed in as ann@example.com.",
  );
  assert.equal(line('relay: forbidden'), 'This computer uses a different MoPilot account.');
  for (const code of ['taken', 'already_joined', 'pair_exists'])
    assert.equal(line(`relay: ${code}`), 'That code was already used. Scan the new one.');
  for (const text of ['relay: expired', 'relay: pair_expired', 'relay: unknown_pair', 'expired QR', 'invalid or expired QR'])
    assert.equal(line(text), 'That code expired. Scan the new one.');
  assert.equal(line('newer QR'), "This phone's MoPilot is too old for this computer. Update it, then scan again.");
  assert.equal(line('older QR'), "This computer's MoPilot is too old. Update MoPilot on it, then scan its new code.");
  assert.equal(line('untrusted relay'), 'That code is for a different MoPilot server.');
  assert.equal(line('invalid relay'), 'That code is for a different MoPilot server.');
  assert.equal(line('invalid QR'), "That isn't a MoPilot pairing code.");
  assert.equal(line('pair cleanup required'), 'Finish or cancel the last pairing first.');
  assert.equal(line('pairing busy'), 'Finish or cancel the last pairing first.');
  assert.equal(line('relay connection closed'), "Can't reach MoPilot. Check your connection and try again.");
  assert.equal(line('relay: mailbox_full'), "Couldn't pair. Try again.");
  assert.equal(pairFailure('boom'), "Couldn't pair. Try again.");
  assert.equal(line('pairing rejected'), "Your computer didn't accept this phone.");
  assert.equal(plainError('relay: forbidden'), 'This computer uses a different MoPilot account.');
  assert.equal(plainError('pairing rejected'), "Your computer didn't accept this phone.");
  assert.equal(plainError('Pairing timed out. Clean up before trying again.'), 'Pairing timed out. Clean up before trying again.');
  assert.equal(plainError(null), null);
  assert.equal(plainError(undefined), null);
  assert.equal(failureOutcome(new Error('relay: forbidden')), 'otherAccount');
  assert.equal(failureOutcome(new Error('relay: taken')), 'badCode');
  assert.equal(failureOutcome(new Error('relay: unknown_pair')), 'badCode');
  assert.equal(failureOutcome(new Error('newer QR')), 'badCode');
  assert.equal(failureOutcome(new Error('older QR')), 'badCode');
  // only a phone that is too old is sent to the App Store: an old computer is updated on the computer
  assert.equal(needsUpdate(new Error('newer QR')), true);
  assert.equal(needsUpdate(new Error('older QR')), false);
  assert.equal(needsUpdate('boom'), false);
  // the log is for a pairing that stalled or got no answer; where the line already says what to do it would only repeat it
  for (const outcome of ['badCode', 'declined', 'otherAccount']) assert.equal(explained(outcome), true, outcome);
  for (const outcome of ['running', 'timeout', 'noAnswer']) assert.equal(explained(outcome), false, outcome);
  assert.equal(pairingSteps('otherAccount')[1].hint, 'Use the same account on both.');
});

test('while the computer has not answered the log waits; after the time limit it names the step and offers to stop and share', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const runtime: any = {
    pair: (qr: string) => (calls.push(`pair:${qr}`), new Promise<void>((resolve) => (release = resolve))),
    cancelPairing: async () => void calls.push('cancel'),
  };
  let t = 1000;
  const host = await mount(runtime, { timeoutMs: 400, now: () => t, defaultName: 'Ann’s iPhone' });
  assert.doesNotMatch(host.textContent!, /Code read/, 'nothing to log before the first attempt');
  await begin();
  assert.match(host.textContent!, /✓ Code read/);
  assert.match(host.textContent!, /… Waiting for the computer/);
  assert.doesNotMatch(host.textContent!, /Share report|Could not connect/);
  t = 1500;
  await pause(600);
  assert.match(host.textContent!, /Could not connect within 0 s\. The log shows where it stopped\./);
  assert.match(host.textContent!, /✗ Waiting for the computer — Is it awake and signed in\?/);
  await click('Share report');
  const shared = g.__phoneShared[0];
  assert.equal(shared, 'MoPilot pairing report\n✓ Code read\n✗ Waiting for the computer — Is it awake and signed in?\nTime: 0.5 s');
  assert.doesNotMatch(shared, /SECRETCODE|Ann’s iPhone/, 'neither the code nor the phone name is in the report');
  await click('Stop and try again');
  assert.ok(calls.includes('cancel'));
  assert.doesNotMatch(host.textContent!, /Code read/, 'the log starts over');
  release();
});

test('a failed attempt is logged at the step it failed: a bad code needs no log (its line says it), anything later is logged at the wait', async () => {
  const errors = [new Error('expired QR'), new Error('no answer')];
  const runtime: any = {
    pair: async () => {
      throw errors.shift();
    },
  };
  let t = 0;
  const host = await mount(runtime, { now: () => (t += 1000) });
  await begin();
  assert.match(host.textContent!, /That code expired\. Scan the new one\./, 'the error line says it in plain words');
  assert.doesNotMatch(
    host.textContent!,
    /Code read|Share report|Waiting for the computer/,
    'a rejected code is explained by its line: no log, no report',
  );
  assert.doesNotMatch(host.textContent!, /Stop and try again/, 'nothing is in flight to stop');
  await click('Connect');
  assert.match(host.textContent!, /✓ Code read/);
  assert.match(host.textContent!, /✗ Waiting for the computer — Is it awake/);
  await click('Share report');
  assert.match(
    g.__phoneShared[0],
    /^MoPilot pairing report\n✓ Code read\n✗ Waiting for the computer — Is it awake and signed in\?\nTime: 1\.0 s$/,
  );
  assert.doesNotMatch(host.textContent!, /Could not connect within/, 'a refusal is not a timeout');
});

test('a pairing that answers in time shows no sentence and no report, and a late failure replaces the timeout', async () => {
  let fail!: (e: Error) => void;
  const runtime: any = { pair: () => new Promise<void>((_, reject) => (fail = reject)) };
  const host = await mount(runtime, { timeoutMs: 20 });
  await begin();
  await pause(40);
  assert.match(host.textContent!, /Could not connect within/);
  await act(async () => fail(new Error('no answer')));
  assert.doesNotMatch(host.textContent!, /Could not connect within/);
  assert.match(host.textContent!, /Couldn't pair\. Try again\./);
  const quick: any = { pair: async () => {} };
  const ok = await mount(quick, { timeoutMs: 20 });
  await openCodeEntry();
  await inputText('Paste pairing code', SECRET);
  await click('Connect');
  await pause(40);
  assert.doesNotMatch(ok.textContent!, /Could not connect within|Share report/, 'the timer is gone once the attempt ended');
});

test('a stop that fails is told; the share sheet closing or failing is quiet; leaving the screen drops the timer', async () => {
  const runtime: any = {
    pair: () => new Promise<void>(() => {}),
    cancelPairing: async () => {
      throw new Error('Pair cleanup is in progress');
    },
  };
  const host = await mount(runtime, { timeoutMs: 20, share: async () => Promise.reject(new Error('dismissed')) });
  await begin();
  await pause(40);
  await click('Stop and try again');
  assert.match(host.textContent!, /Finish or cancel the last pairing first\./);
  assert.match(host.textContent!, /Waiting for the computer/, 'the log stays as it was');
  await click('Share report');
  await flush();
  assert.match(host.textContent!, /Share report/);
  const gone = await mount({ pair: () => new Promise(() => {}) }, { timeoutMs: 20 });
  await begin();
  const entry = mounted.find((m) => m.host === gone);
  await act(async () => entry.root.unmount());
  await pause(40);
});

test('an attempt that fails after Stop, or after a newer attempt began, does not rewrite the log; a non-Error failure still gets a line', async () => {
  const fails: Array<(e: unknown) => void> = [];
  const runtime: any = {
    pair: () => new Promise<void>((_, reject) => fails.push(reject)),
    cancelPairing: async () => {},
  };
  let t = 0;
  const host = await mount(runtime, { timeoutMs: 400, now: () => (t += 1) });
  await begin();
  await pause(600);
  await click('Stop and try again');
  await act(async () => fails[0](new Error('pairing cancelled')));
  assert.doesNotMatch(host.textContent!, /Code read|pairing cancelled/, 'the cancelled attempt leaves no log and no error behind');
  await begin();
  assert.match(host.textContent!, /… Waiting for the computer/);
  await act(async () => fails[0](new Error('late failure of the first attempt')));
  assert.match(host.textContent!, /… Waiting for the computer/, 'the newer attempt keeps its own log');
  assert.doesNotMatch(host.textContent!, /late failure/, 'and its own error line');
  assert.match(host.textContent!, /Connecting…/, 'and stays busy: the earlier attempt ending does not free the form');
  await act(async () => fails[1]('plain string'));
  assert.match(host.textContent!, /Couldn't pair\. Try again\./);
});
