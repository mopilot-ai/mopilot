// A newer, older or damaged home never blanks the screen: known rows missing a part are left out, parts are filled, settings merge part by part, and one bad row or page is replaced by a line instead of taking the screen with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { find, fixtureView, flush, mount, tap, type Any } from './support/phone/momo-screens';

const transportPath = '../mobile/src/momoPhone/transport';
const { parseHomeView } = await import(transportPath);

const parse = (patch: (v: Any) => void) => {
  const view = fixtureView().view as Any;
  patch(view);
  return parseHomeView({ view }, 1).view as Any;
};

test('a known row missing a part is left out; an unknown kind is kept; the rest is read', () => {
  const v = parse((x) =>
    x.chat.push(
      { kind: 'approval', id: 'a' },
      { kind: 'approval', id: 'b', approval: { id: 'c', recipients: 'x' } },
      { kind: 'brief', id: 'c' },
      { kind: 'brief', id: 'd', brief: {} },
      { kind: 'waiting', id: 'e' },
      { kind: 'waiting', id: 'f', machine: {} },
      { kind: 'catch-up', id: 'g' },
      { kind: 'catch-up', id: 'h', catchUp: {} },
      { kind: 'draft', id: 'dr', draft: 'x' },
      { kind: 'watch-changed', id: 'wc1' },
      { kind: 'watch-changed', id: 'wc2', watch: { taskId: 't', machine: 1 } },
      { kind: 'result', id: 'rs1' },
      { kind: 'result', id: 'rs2', result: { taskId: 't', machine: 1 } },
      { kind: 'question', id: 'qs1' },
      { kind: 'question', id: 'qs2', question: { id: 'q', options: 'x' } },
      { kind: 'user', id: 'i' },
      { kind: 'assistant', id: 'j', text: 3 },
      { kind: 'hologram', id: 'k' },
      { kind: 'user' },
      null,
      'x',
    ),
  );
  assert.deepEqual(
    v.chat.map((r: Any) => r.id),
    ['a1', 'u1', 'k1', 'k'],
  );
  const ok = parse((x) =>
    x.chat.push(
      { kind: 'waiting', id: 'w', at: 1, machine: { machineId: 's', name: 'Studio' } },
      { kind: 'brief', id: 'b', at: 1, brief: { overnight: {} } },
      { kind: 'catch-up', id: 'c', at: 1, catchUp: { machine: { machineId: 's', name: 'S' } } },
    ),
  );
  assert.deepEqual(
    ok.chat.slice(-3).map((r: Any) => r.kind),
    ['waiting', 'brief', 'catch-up'],
  );
});

test('a note without lines or history, a line without sources, and a task without a place to run are filled', () => {
  const v = parse((x) => {
    x.notes.push({ id: 'n9', title: 'Bare' }, { title: 'No id' }, null);
    x.notes[0].lines.push({ id: 'l9', text: 'no sources' }, { text: 'no id' }, null);
    x.tasks.push(
      { id: 't9', title: 'Bare task', state: 'working', startedAt: 1 },
      { id: 't8', title: 'T', where: { agent: 'Codex' } },
      { title: 'no id' },
    );
  });
  assert.deepEqual([v.notes[1].lines, v.notes[1].history], [[], []]);
  assert.equal(v.notes.length, 2);
  const line = v.notes[0].lines.find((l: Any) => l.id === 'l9');
  assert.deepEqual([line.sources, line.quote], [[], null]);
  assert.equal(v.notes[0].lines.length, 2);
  const task = v.tasks.find((t: Any) => t.id === 't9');
  assert.deepEqual(
    [task.where, task.failure, task.result, task.attempts, task.attemptCap],
    [{ agent: '', machine: { machineId: '', name: '' } }, null, null, 1, 3],
  );
  assert.deepEqual(v.tasks.find((t: Any) => t.id === 't8').where, { agent: 'Codex', machine: { machineId: '', name: '' } });
  assert.equal(v.tasks.length, 4);
});

test('settings merge part by part over the design’s defaults', () => {
  const v = parse((x) => (x.settings = { brief: { on: false }, quietHours: { from: '23:00' }, dailyCap: 3 }));
  assert.deepEqual(v.settings, {
    brief: { on: false, time: '08:00' },
    quietHours: { from: '23:00', to: '08:00' },
    dailyCap: 3,
    previews: false,
  });
  const none = parse((x) => (x.settings = { brief: 'x', quietHours: null }));
  assert.deepEqual(
    [none.settings.brief, none.settings.quietHours],
    [
      { on: true, time: '08:00' },
      { from: '22:00', to: '08:00' },
    ],
  );
});

test('one row that cannot be drawn is left out and the rest of the chat is still there, and it is drawn again when the home sends it whole', async () => {
  const m = await mount((v) => {
    const card = v.chat.find((r: Any) => r.kind === 'approval');
    card.approval.recipients = [null];
  });
  assert.match(m.text(), /The quote sheet is ready/);
  assert.match(m.text(), /MoMo · Studio/);
  assert.doesNotMatch(m.text(), /Send this email\?/);
  // it never just disappears: a short line stands in its place
  assert.match(m.text(), /Couldn't show this\./);
  const fixed = fixtureView();
  m.transport.emit({ view: fixed.view });
  await flush();
  assert.match(m.text(), /Send this email\?/);
});

test('a page that cannot be drawn says so with Try again; another page is drawn normally', async () => {
  const m = await mount((v) => (v.notes[0].title = { not: 'text' }));
  await tap('Notes');
  assert.match(m.text(), /Couldn't show this\./);
  assert.match(m.text(), /MoMo · Studio/, 'the header and the tabs are still there');
  await tap('Try again');
  assert.match(m.text(), /Couldn't show this\./, 'the same home says the same: it is still shown plainly');
  await tap('Tasks');
  assert.match(m.text(), /Build the Acme quote sheet/);
  await tap('Notes');
  assert.match(m.text(), /Couldn't show this\./);
  const fixed = fixtureView();
  m.transport.emit({ view: fixed.view });
  await flush();
  await tap('Chat');
  await tap('Notes');
  assert.match(m.text(), /Acme/);
  assert.equal(find('Try again'), undefined);
});

test('an older Host’s shapes are read with defaults: a brief, a result and a question keep their cards, and only the unreadable parts go', () => {
  const v = parse((x) =>
    x.chat.push(
      // keptQuiet that is not a list, and one with entries missing their words or carrying a rule that is not text
      { kind: 'brief', id: 'b1', at: 1, brief: { overnight: {}, keptQuiet: 'none' } },
      {
        kind: 'brief',
        id: 'b2',
        at: 1,
        brief: {
          overnight: {},
          keptQuiet: [
            { id: 'k1', title: 'Newsletter', label: 'Kept quiet', ruleId: 7 },
            { id: 'k3', title: 'Sale', label: 'Kept quiet', ruleId: 'rule-1' },
            { id: 'k2' },
            null,
          ],
        },
      },
      // a result without actions, files or summary
      { kind: 'result', id: 'r1', at: 1, result: { taskId: 't', machine: { machineId: 'm', name: 'Studio' } } },
      {
        kind: 'result',
        id: 'r2',
        at: 1,
        result: {
          taskId: 't',
          machine: { machineId: 'm', name: 'Studio' },
          files: [1, 'a.txt'],
          actions: [{ id: 'x' }, { id: 'y', label: 'Open' }],
        },
      },
      // a question option without a label
      { kind: 'question', id: 'q1', at: 1, question: { id: 'q', status: 'pending', options: [{ id: 'a' }, { id: 'b', label: 'Yes' }, 3] } },
    ),
  );
  const row = (id: string) => v.chat.find((r: Any) => r.id === id);
  assert.deepEqual(row('b1').brief.keptQuiet, []);
  assert.deepEqual(row('b2').brief.keptQuiet, [
    { id: 'k1', title: 'Newsletter', label: 'Kept quiet', ruleId: null },
    { id: 'k3', title: 'Sale', label: 'Kept quiet', ruleId: 'rule-1' },
  ]);
  assert.deepEqual([row('r1').result.files, row('r1').result.actions, row('r1').result.summary, row('r1').result.title], [[], [], '', '']);
  assert.deepEqual([row('r2').result.files, row('r2').result.actions.map((a: Any) => a.label)], [['a.txt'], ['Open']]);
  assert.deepEqual(row('q1').question.options, [{ id: 'b', label: 'Yes' }]);
});
