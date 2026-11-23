// Settings › MoMo › Sources (#2139 P2, src/components/momo/SourcesSection.tsx and SourceCard.tsx), the real components over a fake window.native.momoSources (tests/support/momoSourcesPage.ts): one card per source with its status chip, one plain line and one primary action; what it reads and keeps behind Details; Pause / Resume and Disconnect (asks first); Files as folders with Remove; encryption off, load failures with Retry, re-reads on change, and only the newest read shown. The connect flows are tests/momoSourcesConnectUI.test.ts.
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
  factsOf,
  lastCall,
  refresh,
  act,
  SOURCE_COPY,
  PAUSED_LINE,
  NO_FOLDERS_LINE,
  KEEPS,
  KEEPS_ASK,
} from './support/momoSourcesPage.ts';

test('each source is a card: Connect with what it gives while off; Connected, one line and no primary action while on; what it reads, keeps, names and since when behind Details', async () => {
  reset();
  const v = await mount();
  const since = new Date(T).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  assert.equal(stateOf(v, 'Calendar'), 'on');
  assert.equal(statusOf(v, 'Calendar'), SOURCE_COPY.calendar.on);
  assert.deepEqual(chips(v, 'Calendar'), ['Connected']);
  assert.equal(v.button('Connect', v.row('Calendar')), undefined, 'a source that is on has no primary action');
  assert.match(factsOf(v, 'Calendar'), new RegExp(`${SOURCE_COPY.calendar.reads}.*${KEEPS}.*Connected${since}.*CalendarsWork, Home`));
  assert.equal(stateOf(v, 'Reminders'), 'idle');
  assert.equal(statusOf(v, 'Reminders'), SOURCE_COPY.reminders.idle);
  assert.deepEqual(chips(v, 'Reminders'), []);
  assert.ok(v.button('Connect', v.row('Reminders')));
  assert.match(factsOf(v, 'Reminders'), new RegExp(SOURCE_COPY.reminders.reads), 'what it reads is told before connecting');
  assert.doesNotMatch(factsOf(v, 'Reminders'), /Connected/);
  assert.equal(v.button('Disconnect', v.row('Reminders')), undefined);
  // Files: its folders, one status line with the count, and Add folder under the list
  assert.equal(statusOf(v, 'Files'), 'MoMo can read 1 folder.');
  assert.deepEqual(
    v.all('li', v.row('Files')).map((li: any) => li.textContent.replace(/\s+/g, ' ').trim()),
    ['~/Docs Remove'],
  );
  assert.ok(v.button('Add folder…', v.row('Files')));
  assert.doesNotMatch(factsOf(v, 'Files'), /Calendars|Lists/);
  // no "Read & ask to change": the level control is gone
  assert.equal(v.all('[role="group"]').length, 0);
  assert.doesNotMatch(v.host.textContent, /Read only|Read & ask|Blocked/);
  await v.close();
  // several folders read as a count
  f.detailAnswer = async (id: string) => ok({ items: id === 'files' ? ['~/Docs', '~/Work'] : [] });
  const w = await mount();
  assert.equal(statusOf(w, 'Files'), 'MoMo can read 2 folders.');
  await w.close();
});

test('Pause stops MoMo reading (the Blocked level) and Resume brings it back (Read only); a source set to Read & ask is on', async () => {
  reset();
  f.sources[0] = { ...f.sources[0], level: 'ask' };
  const v = await mount();
  assert.equal(stateOf(v, 'Calendar'), 'on');
  assert.equal(statusOf(v, 'Calendar'), SOURCE_COPY.calendar.onAsk);
  await v.click(v.button('Pause', v.row('Calendar')));
  assert.deepEqual(lastCall('setLevel'), ['setLevel', 'calendar', 'blocked']);
  assert.equal(f.calls.filter((c: any) => c[0] === 'list').length, 2, 'read again');
  f.sources[0] = { ...f.sources[0], level: 'blocked' };
  await refresh(v);
  assert.equal(stateOf(v, 'Calendar'), 'paused');
  assert.equal(statusOf(v, 'Calendar'), PAUSED_LINE);
  assert.deepEqual(chips(v, 'Calendar'), ['Paused']);
  assert.equal(v.button('Pause', v.row('Calendar')), undefined);
  await v.click(v.button('Resume', v.row('Calendar')));
  assert.deepEqual(lastCall('setLevel'), ['setLevel', 'calendar', 'read']);
  await v.close();
});

test('a paused Files keeps its folders to remove but offers no Add folder', async () => {
  reset();
  f.sources[2] = { ...f.sources[2], level: 'blocked' };
  const v = await mount();
  assert.equal(stateOf(v, 'Files'), 'paused');
  assert.equal(statusOf(v, 'Files'), PAUSED_LINE);
  assert.ok(v.button('Remove ~/Docs'));
  assert.equal(v.button('Add folder…'), undefined);
  assert.ok(v.button('Resume', v.row('Files')));
  await v.close();
});

test('Pause and Resume take no click while a change is being written', async () => {
  reset();
  const v = await mount();
  let finish!: () => void;
  f.okAnswer = () => new Promise((r) => (finish = () => r(ok())));
  await v.click(v.button('Pause', v.row('Calendar')));
  assert.equal(v.button('Pause', v.row('Calendar')).disabled, true);
  assert.equal(v.button('Disconnect', v.row('Calendar')).disabled, true);
  await act(async () => finish());
  await flush();
  assert.equal(v.button('Pause', v.row('Calendar')).disabled, false);
  await v.close();
});

test('Disconnect asks first, says copies are deleted, and Cancel keeps it', async () => {
  reset();
  const v = await mount();
  await v.click(v.button('Disconnect', v.row('Calendar')));
  assert.match(v.row('Calendar').textContent, /Delete what MoMo copied from Calendar\?/);
  assert.equal(v.button('Pause', v.row('Calendar')), undefined, 'the question replaces the other choices');
  await v.click(v.button('Cancel', v.row('Calendar')));
  assert.equal(
    f.calls.some((c: any) => c[0] === 'disconnect'),
    false,
  );
  await v.click(v.button('Disconnect', v.row('Calendar')));
  await v.click(v.button('Disconnect', v.row('Calendar')));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'disconnect'),
    ['disconnect', 'calendar'],
  );
  await v.close();
});

test('Files: Remove a folder; Add folder asks main, which opens the dialog (the renderer passes no path)', async () => {
  reset();
  const v = await mount();
  await v.click(v.button('Remove ~/Docs'));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'removeFolder'),
    ['removeFolder', '~/Docs'],
  );
  await v.click(v.button('Add folder…'));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'addFolder'),
    ['addFolder'],
  );
  await v.close();
});

test('a connect day in another year shows its year', async () => {
  reset();
  const last = new Date(new Date().getFullYear() - 1, 5, 1).getTime();
  f.sources[0] = { ...f.sources[0], connectedAt: last };
  const v = await mount();
  const want = new Date(last).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  assert.match(factsOf(v, 'Calendar'), new RegExp(`Connected${want}`));
  await v.close();
});

test('names fail or are empty: the details show no calendars, the rest still works', async () => {
  reset();
  f.detailAnswer = async (id: string) => (id === 'calendar' ? Promise.reject(new Error('x')) : { ok: false, error: 'no' });
  const v = await mount();
  assert.doesNotMatch(factsOf(v, 'Calendar'), /Calendars/);
  assert.equal(statusOf(v, 'Calendar'), SOURCE_COPY.calendar.on);
  assert.equal(statusOf(v, 'Files'), NO_FOLDERS_LINE, 'a Files read that fails shows no folders');
  await v.close();
});

test('encryption off, a failed load with Retry, a thrown load, and re-reading on change', async () => {
  reset();
  f.available = false;
  f.listAnswer = async () => ({ ok: false, error: 'MoMo is not available' });
  const v = await mount();
  assert.deepEqual(v.alerts(), ["Couldn't load sources: MoMo is not available Retry"]);
  f.listAnswer = async () => ok({ sources: f.sources, available: false });
  await v.click(v.button('Retry'));
  assert.deepEqual(v.alerts(), []);
  assert.match(v.host.textContent, /need encryption, which isn't available/);
  f.listAnswer = async () => {
    throw new Error('IPC gone');
  };
  await act(async () => {
    for (const cb of f.listeners) cb();
  });
  await flush();
  assert.match(v.alerts()[0], /IPC gone/);
  await v.close();
  assert.equal(f.listeners.size, 0, 'unmounting stops listening');
});

test('only the newest read is shown when reads overlap', async () => {
  reset();
  const v = await mount();
  const pending: ((r: any) => void)[] = [];
  f.listAnswer = () => new Promise((resolve) => pending.push(resolve));
  await act(async () => {
    for (const cb of f.listeners) cb();
    for (const cb of f.listeners) cb();
  });
  // the newer read answers first: Reminders connected
  pending[1](
    ok({
      sources: f.sources.map((s: any) => (s.id === 'reminders' ? { ...s, connected: true, connectedAt: T, level: 'read' } : s)),
      available: true,
    }),
  );
  await flush();
  pending[0](ok({ sources: f.sources, available: true }));
  await flush();
  assert.equal(v.button('Connect', v.row('Reminders')), undefined, 'the older answer did not bring back Connect');
  // an older failure is ignored too
  const slow: any[] = [];
  f.listAnswer = () => new Promise((resolve, reject) => slow.push({ resolve, reject }));
  await act(async () => {
    for (const cb of f.listeners) cb();
    for (const cb of f.listeners) cb();
  });
  slow[1].resolve(ok({ sources: f.sources, available: true }));
  await flush();
  slow[0].reject(new Error('stale'));
  await flush();
  assert.deepEqual(v.alerts(), []);
  await v.close();
});

test('Allow changes sets Read & ask to change on Calendar and Reminders, Stop changes sets Read only; Files is never offered it', async () => {
  reset();
  const v = await mount();
  assert.equal(statusOf(v, 'Calendar'), SOURCE_COPY.calendar.on);
  f.sources[1] = { id: 'reminders', label: 'Reminders', connected: true, connectedAt: T, level: 'read' };
  await refresh(v);
  assert.ok(v.button('Allow changes', v.row('Reminders')));
  assert.equal(v.button('Allow changes', v.row('Files')), undefined);
  assert.equal(v.button('Stop changes', v.row('Calendar')), undefined);
  assert.ok(v.row('Calendar').textContent!.includes(KEEPS));
  await v.click(v.button('Allow changes', v.row('Calendar')));
  assert.deepEqual(lastCall('setLevel'), ['setLevel', 'calendar', 'ask']);
  f.sources[0] = { ...f.sources[0], level: 'ask' };
  await refresh(v);
  assert.equal(statusOf(v, 'Calendar'), SOURCE_COPY.calendar.onAsk);
  assert.ok(v.row('Calendar').textContent!.includes(KEEPS_ASK));
  assert.equal(v.button('Allow changes', v.row('Calendar')), undefined);
  await v.click(v.button('Stop changes', v.row('Calendar')));
  assert.deepEqual(lastCall('setLevel'), ['setLevel', 'calendar', 'read']);
  await v.close();
});
