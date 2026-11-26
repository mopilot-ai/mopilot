// MoMo's phone Tasks, Notes, Rules and settings pages: every state the design shows, and each button sends its intent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mount, find, placeholder, tap, typeInto, flip, homeIs, kinds, ref, type Any } from './support/phone/momo-screens';

test('Tasks: sections, a working task with the Stop confirmation, a result, a watched task and the empty state', async () => {
  const m = await mount();
  await tap('Tasks');
  assert.match(m.text(), /Working/);
  assert.match(m.text(), /Watching/);
  await tap('Build the Acme quote sheet');
  assert.match(m.text(), /Done means/);
  assert.match(m.text(), /Codex · Mac mini/);
  assert.match(m.text(), /6 min ago/);
  assert.match(m.text(), /Filling the pricing table/);
  await tap('Stop');
  assert.match(m.text(), /Stop this task\?/);
  await tap('Keep working');
  await tap('Stop');
  await tap('Stop task');
  assert.deepEqual(m.sent, [{ kind: 'task-stop', taskId: 't1' }]);
  await tap('Back');
  assert.match(m.text(), /Done today/);
  await tap('Back');
  assert.deepEqual(m.backs, ['back']);
  const w = await mount();
  await tap('Tasks');
  await tap('AWS invoice');
  assert.match(w.text(), /Next check/);
  assert.match(w.text(), /4:00 PM/);
  assert.match(w.text(), /Told you\s*Not yet/);
  assert.match(w.text(), /I will tell you at 4:00 PM if it is still open, or sooner if a reply arrives\./);
  await tap('Check now');
  await tap('Snooze');
  // the row says when it comes back, an hour from the phone's clock
  assert.match(w.text(), /Snoozed until \d{1,2}:\d{2} [AP]M/);
  // Stop watching runs at once, as on the Mac (no session stops, so nothing is asked), under its own intent; only Stop of a running session asks first
  await tap('Stop watching');
  assert.deepEqual(kinds(w), ['task-check', 'task-snooze', 'task-stop-watching']);
  assert.doesNotMatch(w.text(), /Stop this task\?/);
  const e = await mount((v) => (v.tasks = []));
  await tap('Tasks');
  assert.match(e.text(), /Nothing running\./);
  await tap('Ask MoMo');
  assert.equal(placeholder(), 'Message MoMo');
});

test('a finished task shows its result; a failed one names the cause and its fix; a task on another machine says the home sleeps', async () => {
  const done = await mount((v) =>
    Object.assign(v.tasks[0], {
      state: 'done',
      step: null,
      result: { summary: '200 seats, $48k, valid to Nov 30.', files: ['Acme-quote.xlsx'], evidence: 'opens, totals match.' },
    }),
  );
  await tap('Tasks');
  await tap('Build the Acme quote sheet');
  assert.match(done.text(), /Ready: Acme-quote\.xlsx/);
  assert.match(done.text(), /Checked: opens, totals match\./);
  await tap('Open the session');
  await tap('Attach to');
  assert.deepEqual(kinds(done), ['task-check', 'task-attach']);
  const failure =
    (code: string, extra: object = {}) =>
    (v: Any) =>
      Object.assign(v.tasks[0], {
        state: 'failed',
        failure: { code, message: 'Mac mini is out of disk space', machine: ref('mini', 'Mac mini'), agent: 'Codex', fix: null, ...extra },
      });
  const missing = await mount(failure('agent-missing'));
  await tap('Tasks');
  await tap('Build the Acme quote sheet');
  assert.match(missing.text(), /Codex isn't installed on Mac mini/);
  await tap('Install Codex on Mac mini');
  assert.deepEqual(missing.sent, [{ kind: 'install-agent', agent: 'codex', machineId: 'mini' }]);
  const out = await mount(failure('restarted'));
  await tap('Tasks');
  await tap('Build the Acme quote sheet');
  assert.match(out.text(), /restarted while this ran/);
  await tap('Start again');
  const other = await mount(failure('session-error'));
  await tap('Tasks');
  await tap('Build the Acme quote sheet');
  assert.match(other.text(), /Couldn't finish: Mac mini is out of disk space/);
  assert.match(other.text(), /Attempt 1 of 3/);
  await tap('Retry');
  const away = await mount(homeIs('asleep'));
  await tap('Tasks');
  await tap('Build the Acme quote sheet');
  assert.match(away.text(), /Studio is asleep\. This keeps running on Mac mini\./);
});

test('Notes: the list, a note with the why behind a line, Edit and Save, History with Undo and Restore, Forget', async () => {
  const m = await mount();
  await tap('Notes');
  assert.match(m.text(), /Nov 24 · Gmail · Re: Acme renewal/);
  await tap('Acme');
  assert.match(m.text(), /Renewal in progress/);
  assert.match(m.text(), /Learned/);
  await tap('Why MoMo thinks this');
  assert.match(m.text(), /“the \$48k price holds if we start Dec 1”/);
  assert.match(m.text(), /Open message/);
  assert.match(m.text(), /1 more source: Calendar · Acme sync/);
  await tap('Why MoMo thinks this');
  assert.doesNotMatch(m.text(), /Open message/);
  await tap('Edit');
  assert.match(m.text(), /Your edit becomes Confirmed\. The old text stays in History\./);
  await typeInto('Edit line', '  ');
  assert.equal((find('Save') as HTMLButtonElement).disabled, true);
  await typeInto('Edit line', 'Renewal done.');
  await tap('Save');
  assert.deepEqual(m.sent, [{ kind: 'note-edit', noteId: 'n1', lineId: 'l1', text: 'Renewal done.' }]);
  assert.match(m.text(), /Confirmed/);
  await tap('Edit');
  await tap('Cancel');
  await tap('History');
  assert.match(m.text(), /Summary rewritten after the price was confirmed/);
  await tap('Summary rewritten');
  await tap('Restore last night');
  assert.deepEqual(kinds(m).slice(1), ['note-undo', 'note-restore']);
  await tap('Back to note');
  await tap('Forget');
  assert.match(m.text(), /Forget this line\?/);
  await tap('Keep');
  assert.doesNotMatch(m.text(), /Forget this line\?/);
  await tap('Forget');
  await tap('Forget');
  assert.deepEqual(m.sent.at(-1), { kind: 'note-forget', noteId: 'n1', lineId: 'l1' });
  assert.match(m.text(), /Nothing here yet\./);
});

test('a note line without a source has no why; the list needs no source line', async () => {
  await mount((v) => {
    v.notes[0].lines[0].sources = [];
    v.notes[0].lines[0].quote = null;
  });
  await tap('Notes');
  await tap('Acme');
  assert.equal(find('Why MoMo thinks this'), undefined);
  const n = await mount((v) => {
    v.notes[0].lines[0].sources = [{ id: 's', kind: 'event', label: 'Calendar · Sync', at: 1, gone: false }];
    v.notes[0].lines[0].quote = null;
  });
  await tap('Notes');
  await tap('Acme');
  await tap('Why MoMo thinks this');
  assert.doesNotMatch(n.text(), /Open message/);
  assert.doesNotMatch(n.text(), /“/);
});

test('while the home sleeps notes are a read-only copy; with none, Connect and Write your own note work', async () => {
  const m = await mount(homeIs('asleep'));
  await tap('Notes');
  await tap('Acme');
  assert.match(m.text(), /Renewal in progress/);
  assert.equal(find('Edit'), undefined);
  await tap('History');
  assert.equal(find('Restore last night'), undefined);
  const e = await mount((v) => (v.notes = []));
  await tap('Notes');
  assert.match(e.text(), /After you connect Gmail and Calendar, MoMo writes down what it learns\./);
  await tap('Connect Gmail and Calendar');
  assert.deepEqual(e.sent, [{ kind: 'google', intent: 'connect' }]);
  await tap('Write your own note');
  assert.equal((find('Save') as HTMLButtonElement).disabled, true);
  await typeInto('Note title', 'Lunch');
  await typeInto('Note text', 'Dana likes noodles.');
  await tap('Save');
  assert.deepEqual(e.sent.at(-1), { kind: 'note-create', title: 'Lunch', text: 'Dana likes noodles.' });
  assert.match(e.text(), /Lunch/);
  await tap('Write your own note').catch(() => undefined);
  await tap('Notes');
});

test('Where MoMo runs reaches Rules, the brief, notification permission and previews', async () => {
  const m = await mount();
  await tap('MoMo · Studio');
  await tap('Rules');
  assert.match(m.text(), /Delivery notices → stay quiet/);
  assert.match(m.text(), /Learned · Used 7 times/);
  await flip('Delivery notices → stay quiet');
  assert.deepEqual(m.sent, [{ kind: 'rule-set', ruleId: 'r1', on: false }]);
  await tap('Back');
  await tap('Morning brief');
  assert.match(m.text(), /8:00 AM/);
  assert.match(m.text(), /10:00 PM to 8:00 AM/);
  assert.match(m.text(), /6 a day/);
  assert.match(m.text(), /A quiet day means no brief and no push\./);
  await flip('Send a brief');
  await tap('Fewer');
  await tap('More');
  assert.deepEqual(
    m.sent.slice(1).map((i: Any) => i.patch),
    [{ brief: false }, { dailyCap: 5 }, { dailyCap: 6 }],
  );
  await tap('Back');
  await tap('Show text on the lock screen');
  assert.match(m.text(), /MoMo needs you/);
  await flip('Show text on the lock screen');
  assert.match(m.text(), /MoMo · now.*The quote sheet is ready/);
  await tap('Back');
  await tap('Notifications');
  assert.match(m.text(), /Let MoMo reach you/);
  await tap('Allow notifications');
  await tap('Back');
  await tap('Notifications');
  await tap('Not now');
  assert.doesNotMatch(m.text(), /Let MoMo reach you/);
});

test('the empty Rules page and a denied notification permission say what the design says; Open Settings opens the phone’s Settings', async () => {
  const m = await mount((v) => {
    v.rules = [];
    v.setup.notifications = 'denied';
  });
  await tap('MoMo · Studio');
  await tap('Rules');
  assert.match(m.text(), /No rules yet\./);
  await tap('Back');
  await tap('Notifications');
  assert.match(m.text(), /Notifications are off\./);
  assert.match(m.text(), /MoMo keeps things in Chat\./);
  (globalThis as Any).__phoneOpenedSettings = false;
  await tap('Open Settings');
  assert.equal((globalThis as Any).__phoneOpenedSettings, true);
  assert.deepEqual(m.sent, []);
});

test('a watched item says when you were told: a time, or yes when the home gives none; the note about 4:00 PM goes once you were told', async () => {
  const told = await mount((v) => Object.assign(v.tasks[1].watch, { told: true, toldAt: new Date(2026, 10, 24, 14, 14).getTime() }));
  await tap('Tasks');
  await tap('AWS invoice');
  assert.match(told.text(), /Told you\s*2:14 PM/);
  assert.doesNotMatch(told.text(), /I will tell you at/);
  const yes = await mount((v) => Object.assign(v.tasks[1].watch, { told: true, toldAt: null }));
  await tap('Tasks');
  await tap('AWS invoice');
  assert.match(yes.text(), /Told you\s*Yes/);
  const old = await mount((v) => delete v.tasks[1].watch);
  await tap('Tasks');
  await tap('AWS invoice');
  assert.doesNotMatch(old.text(), /Told you/, 'an older home gives no word on it');
  const noCheck = await mount((v) => Object.assign(v.tasks[1], { nextCheck: null }));
  await tap('Tasks');
  await tap('AWS invoice');
  assert.doesNotMatch(noCheck.text(), /I will tell you at/);
});
