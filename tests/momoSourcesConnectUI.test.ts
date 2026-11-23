// Connecting a source in Settings › MoMo › Sources (#2139 P2, #2999, src/components/momo/SourceCard.tsx over useSourceConnect), the real components over a fake window.native.momoSources (tests/support/momoSourcesPage.ts): Connect and macOS's answers, a refusal that sends to System Settings and the wait for the switch, the recheck when the window comes back, lost access, the Needs your OK chip, failures under the card, and Files connecting through Add folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  f,
  ok,
  T,
  flush,
  mount,
  reset,
  statusOf,
  stateOf,
  chips,
  lastCall,
  focus,
  refresh,
  act,
  ASK_LINE_DELAY_MS,
  WAITING_LINE,
  ALLOW_LINE,
  NEEDS_BADGE,
  needsLine,
  stalledLine,
  lostLine,
  SOURCE_COPY,
  NO_FOLDERS_LINE,
} from './support/momoSourcesPage.ts';

test('connect: granted reads again with no notice', async () => {
  reset();
  const v = await mount();
  await v.click(v.button('Connect', v.row('Reminders')));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'connect'),
    ['connect', 'reminders'],
  );
  assert.deepEqual(v.alerts(), []);
  assert.equal(f.calls.filter((c: any) => c[0] === 'list').length, 2);
  await v.close();
});

test('connect: a refusal macOS gave says where to turn it on, with Open System Settings; a source it never decided, and the rest, say it in one line and keep Connect', async () => {
  // a refusal (also the one the user just gave) and write-only become the card's next step, the pane: they have an entry to switch; a restriction, a source macOS never decided (the pane has no entry for it) and the rest are one line
  const steps: [any][] = [[{ grant: 'denied' }], [{ grant: 'denied', asked: true }], [{ grant: 'writeOnly' }]];
  for (const [answer] of steps) {
    reset();
    f.connectAnswer = async () => ok({ connected: false, ...answer });
    const v = await mount();
    await v.click(v.button('Connect', v.row('Reminders')));
    assert.deepEqual(v.alerts(), [], JSON.stringify(answer));
    assert.equal(statusOf(v, 'Reminders'), needsLine('reminders'));
    assert.equal(v.button('Connect', v.row('Reminders')), undefined);
    await v.click(v.button('Open System Settings', v.row('Reminders')));
    assert.deepEqual(lastCall('openPrivacy'), ['openPrivacy', 'reminders']);
    await v.close();
  }
  const lines: [any, RegExp][] = [
    [{ grant: 'restricted' }, /^A setting on this Mac blocks Reminders\./],
    [{ grant: 'granted' }, /^Connecting was cancelled\./],
    [{ grant: 'unavailable' }, /can't be read on this computer/],
    [{ grant: 'notDetermined' }, /^macOS didn't ask\. Connect to try again\./],
    [{ grant: 'notDetermined', noPrompt: true }, /^macOS didn't show its Reminders prompt\. Restart MoPilot and Connect again/],
  ];
  for (const [answer, text] of lines) {
    reset();
    f.connectAnswer = async () => ok({ connected: false, ...answer });
    const v = await mount();
    await v.click(v.button('Connect', v.row('Reminders')));
    assert.equal(v.alerts().length, 1);
    assert.match(v.alerts()[0], text);
    assert.ok(v.button('Connect', v.row('Reminders')), JSON.stringify(answer));
    await v.close();
  }
});

test('Open System Settings that macOS will not open says why on the card', async () => {
  reset();
  f.connectAnswer = async () => ok({ connected: false, grant: 'denied' });
  const v = await mount();
  await v.click(v.button('Connect', v.row('Reminders')));
  // the pane would not open: main's { ok: false, error } is shown, not dropped
  f.okAnswer = async () => ({ ok: false, error: 'Failed to open URL' });
  await v.click(v.button('Open System Settings', v.row('Reminders')));
  assert.match(v.alerts()[0], /Failed to open URL/);
  await v.close();
});

test('Files is off: Add folder connects it first (no macOS prompt, so its card never says where to allow), then asks main for the folder', async () => {
  reset();
  f.sources[2] = { id: 'files', label: 'Files', connected: false };
  assert.equal(SOURCE_COPY.files.on, undefined);
  let answer!: (r: any) => void;
  f.connectAnswer = () => new Promise((r) => (answer = r));
  const v = await mount();
  assert.equal(stateOf(v, 'Files'), 'idle');
  assert.equal(statusOf(v, 'Files'), SOURCE_COPY.files.idle);
  assert.equal(v.button('Connect', v.row('Files')), undefined, 'Files has no Connect, only Add folder');
  await act(async () => v.button('Add folder…', v.row('Files')).click());
  await act(async () => new Promise((r) => setTimeout(r, ASK_LINE_DELAY_MS + 100)));
  assert.equal(statusOf(v, 'Files'), SOURCE_COPY.files.idle);
  assert.deepEqual(lastCall('connect'), ['connect', 'files']);
  assert.equal(lastCall('addFolder'), undefined, 'the dialog waits for the connect');
  f.sources[2] = { id: 'files', label: 'Files', connected: true, connectedAt: T, level: 'read', folders: [] };
  await act(async () => answer(ok({ connected: true, grant: 'granted' })));
  await flush();
  assert.deepEqual(lastCall('addFolder'), ['addFolder'], 'the renderer passes no path');
  await v.close();
});

test('Files with no folder says so, and a connect that fails shows its error without opening the dialog', async () => {
  reset();
  f.sources[2] = { id: 'files', label: 'Files', connected: true, connectedAt: T, level: 'read', folders: [] };
  f.detailAnswer = async () => ok({ items: [] });
  const v = await mount();
  assert.equal(statusOf(v, 'Files'), NO_FOLDERS_LINE);
  assert.equal(v.all('li', v.row('Files')).length, 0);
  assert.deepEqual(chips(v, 'Files'), [], 'Files that has no folder reads nothing, so it is not called Connected');
  await v.click(v.button('Add folder…', v.row('Files')));
  assert.deepEqual(lastCall('addFolder'), ['addFolder'], 'already on: no connect first');
  assert.equal(lastCall('connect'), undefined);
  await v.close();
  reset();
  f.sources[2] = { id: 'files', label: 'Files', connected: false };
  f.connectAnswer = async () => ({ ok: false, error: 'MoMo is not available' });
  const w = await mount();
  await w.click(w.button('Add folder…', w.row('Files')));
  assert.deepEqual(w.alerts(), ['MoMo is not available']);
  assert.equal(lastCall('addFolder'), undefined);
  await w.close();
});

test('while macOS asks the card says where to allow; while the pane is open it waits, with Open again and Cancel; when the wait ends it says it is still off', async () => {
  reset();
  let answer!: (r: any) => void;
  f.connectAnswer = () => new Promise((r) => (answer = r));
  const v = await mount();
  await act(async () => v.button('Connect', v.row('Reminders')).click());
  // macOS answers a repeated refusal at once, so the line waits for a call that is still running (a prompt)
  assert.equal(statusOf(v, 'Reminders'), SOURCE_COPY.reminders.idle);
  await act(async () => new Promise((r) => setTimeout(r, ASK_LINE_DELAY_MS + 100)));
  assert.equal(statusOf(v, 'Reminders'), ALLOW_LINE);
  assert.equal(stateOf(v, 'Reminders'), 'asking');
  await act(async () => answer(ok({ connected: false, grant: 'denied', waiting: true })));
  await flush();
  assert.deepEqual(v.alerts(), [], 'the pane is open: no notice');
  f.listAnswer = async () => ok({ sources: f.sources, available: true, waiting: ['reminders'] });
  await refresh(v);
  assert.equal(statusOf(v, 'Reminders'), WAITING_LINE);
  assert.equal(v.button('Connect', v.row('Reminders')), undefined);
  await v.click(v.button('Open again', v.row('Reminders')));
  assert.deepEqual(f.calls.filter((c: any) => c[0] === 'openPrivacy').at(-1), ['openPrivacy', 'reminders']);
  await v.click(v.button('Cancel', v.row('Reminders')));
  assert.ok(f.calls.some((c: any) => c[0] === 'cancelConnect' && c[1] === 'reminders'));
  // the wait is over and the switch is still off
  f.listAnswer = async () => ok({ sources: f.sources, available: true, waiting: [] });
  await refresh(v);
  assert.equal(statusOf(v, 'Reminders'), stalledLine('reminders'));
  assert.ok(v.button('Open System Settings', v.row('Reminders')));
  assert.equal(v.button('Cancel', v.row('Reminders')), undefined);
  await v.close();
});

test('back from System Settings the card reads the grant and connects by itself', async () => {
  reset();
  f.connectAnswer = async () => ok({ connected: false, grant: 'denied' });
  const v = await mount();
  await v.click(v.button('Connect', v.row('Reminders')));
  await focus();
  assert.ok(f.calls.some((c: any) => c[0] === 'recheck' && c[1] === 'reminders'));
  const lists = f.calls.filter((c: any) => c[0] === 'list').length;
  f.recheckAnswer = async () => ok({ connected: true });
  await focus();
  assert.ok(f.calls.filter((c: any) => c[0] === 'list').length > lists, 'a connected grant is read again');
  await v.close();
});

test('a connect failure does not outlive the connect: once the card is on the alert is gone', async () => {
  reset();
  f.connectAnswer = async () => ({ ok: false, error: 'Reminders access isn’t granted' });
  const v = await mount();
  await v.click(v.button('Connect', v.row('Reminders')));
  assert.deepEqual(v.alerts(), ['Reminders access isn’t granted']);
  f.sources[1] = { id: 'reminders', label: 'Reminders', connected: true, connectedAt: T, level: 'read' };
  await refresh(v);
  assert.deepEqual(v.alerts(), []);
  await v.close();
});

test('a source connected in MoMo that macOS refuses reads as lost access with Connect, not as connected; Connect asks again, a refusal sends to System Settings, and granting brings the card back', async () => {
  reset();
  const refused = { id: 'reminders', label: 'Reminders', connected: true, connectedAt: T, level: 'read', needsGrant: true };
  f.sources[1] = refused;
  const v = await mount();
  assert.equal(stateOf(v, 'Reminders'), 'lost');
  assert.equal(statusOf(v, 'Reminders'), lostLine('reminders'));
  assert.deepEqual(chips(v, 'Reminders'), [NEEDS_BADGE]);
  assert.ok(v.button('Connect', v.row('Reminders')));
  // the details still let the user disconnect, but not pause what cannot be read
  assert.equal(v.button('Pause', v.row('Reminders')), undefined);
  assert.ok(v.button('Disconnect', v.row('Reminders')));
  f.connectAnswer = async () => ok({ connected: false, grant: 'denied' });
  await v.click(v.button('Connect', v.row('Reminders')));
  assert.equal(statusOf(v, 'Reminders'), needsLine('reminders'));
  assert.ok(v.button('Open System Settings', v.row('Reminders')));
  // the switch went on: the source is no longer marked, and the card is the connected one again
  f.sources[1] = { ...refused, needsGrant: undefined };
  await refresh(v);
  assert.equal(stateOf(v, 'Reminders'), 'on');
  assert.deepEqual(chips(v, 'Reminders'), ['Connected']);
  await v.close();
});

test('a failed connect shows its error under the card; a failed change shows its reason (no pane link: Connect is the way); a thrown one shows too', async () => {
  reset();
  const v = await mount();
  f.connectAnswer = async () => ({ ok: false, error: 'Reminders access isn’t granted', reason: 'not_granted' });
  await v.click(v.button('Connect', v.row('Reminders')));
  assert.deepEqual(v.alerts(), ['Reminders access isn’t granted']);
  f.connectAnswer = async () => {
    throw new Error('IPC gone');
  };
  await v.click(v.button('Connect', v.row('Reminders')));
  assert.deepEqual(v.alerts(), ['IPC gone']);
  // a pause macOS took back says why, with no pane link: the source is drawn as one to allow again
  f.okAnswer = async () => ({ ok: false, error: 'Calendar access isn’t granted', reason: 'not_granted' });
  await v.click(v.button('Pause', v.row('Calendar')));
  assert.deepEqual(v.alerts(), ['Calendar access isn’t granted', 'IPC gone']);
  assert.equal(v.button('Open Privacy settings'), undefined);
  await v.close();
});

test('a call that throws shows its error under the card', async () => {
  reset();
  f.okAnswer = async () => {
    throw new Error('IPC gone');
  };
  const v = await mount();
  await v.click(v.button('Pause', v.row('Calendar')));
  assert.deepEqual(v.alerts(), ['IPC gone']);
  await v.close();
});

test('the needs-OK phases carry the “Needs your OK” chip: lost access, the pane and a wait that ended; a plain Connect and a wait do not', async () => {
  reset();
  f.sources[1] = { id: 'reminders', label: 'Reminders', connected: true, connectedAt: T, level: 'read', needsGrant: true };
  const v = await mount();
  assert.deepEqual(chips(v, 'Calendar'), ['Connected'], 'a source that is on says so, not that it needs anything');
  assert.deepEqual(chips(v, 'Reminders'), [NEEDS_BADGE], 'lost access, with Connect');
  // refused: the pane is the next step, still chipped
  f.connectAnswer = async () => ok({ connected: false, grant: 'denied' });
  await v.click(v.button('Connect', v.row('Reminders')));
  assert.deepEqual(chips(v, 'Reminders'), [NEEDS_BADGE]);
  // the wait is running: no chip, it says it waits
  f.listAnswer = async () => ok({ sources: f.sources, available: true, waiting: ['reminders'] });
  await refresh(v);
  assert.deepEqual(chips(v, 'Reminders'), []);
  // the wait ended with the switch still off: chipped again
  f.listAnswer = async () => ok({ sources: f.sources, available: true, waiting: [] });
  await refresh(v);
  assert.equal(statusOf(v, 'Reminders'), stalledLine('reminders'));
  assert.deepEqual(chips(v, 'Reminders'), [NEEDS_BADGE]);
  await v.close();
  // never connected and nothing tried: a plain Connect with no chip
  reset();
  const w = await mount();
  assert.deepEqual(chips(w, 'Reminders'), []);
  await w.close();
});
