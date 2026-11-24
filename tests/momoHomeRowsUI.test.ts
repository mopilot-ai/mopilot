// MoMo's chat rows beyond messages (src/components/momo/home/RowCards.tsx, ApprovalCard.tsx): every row of the shared fixture (shared/momoRowsFixture.ts, the rows the Host writes) is drawn in each of its states, a question is answered with one tap, a result's text stays text, and rows that arrive malformed degrade.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  createElement,
  createFixtureSeam,
  createRoot,
  fixtureView,
  flush,
  MomoHomePage,
  NOW,
  resetMomoHomeStore,
  setMomoHomeSeam,
  window,
} from './support/momoHomeRig.ts';
import { FIXTURE_AT, FIXTURE_DRAFT_ROW, FIXTURE_RESULT, FIXTURE_ROWS } from '../shared/momoRowsFixture.ts';

const { parseView } = await import('../src/components/momo/home/parseView.ts');

async function mountRows(chat: any[], now = NOW) {
  const v: any = fixtureView();
  v.chat = chat;
  const seam = createFixtureSeam(v, () => now);
  const acts: any[] = [];
  const act0 = seam.act;
  seam.act = async (a: any) => (acts.push(a), act0(a));
  setMomoHomeSeam(seam);
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, { tab: 'chat', now })));
  await flush();
  const body = window.document.body as any;
  return {
    acts,
    body,
    text: () => body.textContent as string,
    row: (id: string) => body.querySelector(`[data-testid="momo-row-${id}"]`) as any,
    click: async (label: string) => {
      await act(async () => [...body.querySelectorAll('button')].find((b: any) => b.textContent.trim() === label).click());
      await flush();
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('every row the Host writes is drawn, none as the unknown-row notice', async () => {
  const m = await mountRows(FIXTURE_ROWS, FIXTURE_AT + 1000);
  for (const r of FIXTURE_ROWS) {
    assert.ok(m.row(r.id), r.id);
    assert.equal(m.row(r.id).querySelector('[data-unknown-row]'), null, r.id);
  }
  const t = m.text();
  assert.ok(t.includes('Which calendar should I use?'));
  assert.ok(t.includes('Reconcile March invoices'));
  assert.ok(t.includes('Matched 41 of 42 invoices; one is missing a PO number.'));
  assert.ok(t.includes('reconciliation-march.xlsx'));
  assert.ok(t.includes('Checked: The report lists every invoice and the one gap.'));
  assert.ok(t.includes('Ready · Studio'));
  assert.ok(t.includes('Couldn’t finish · Studio'));
  assert.ok(t.includes('Price of the flight to Berlin'));
  assert.ok(t.includes('It dropped from 212 to 168.'));
  assert.ok(t.includes('Watching from Studio'));
  assert.ok(m.row('approval:void').textContent.includes('No longer valid'));
  assert.ok(m.row('approval:void').textContent.includes('MoMo moved, so this card can’t be answered.'));
  await m.close();
});

test('a draft row, in the contract but not yet drawn, reads as the unknown-row line and never breaks the chat', async () => {
  const m = await mountRows([...FIXTURE_ROWS, FIXTURE_DRAFT_ROW], FIXTURE_AT + 1000);
  assert.ok(m.row(FIXTURE_DRAFT_ROW.id).querySelector('[data-unknown-row]'));
  assert.equal(m.acts.length, 0);
  await m.close();
});

test('a question is answered with one tap and says what was chosen; the others read as closed', async () => {
  const m = await mountRows(
    FIXTURE_ROWS.filter((r) => r.kind === 'question'),
    FIXTURE_AT + 1000,
  );
  const pending = m.row('question:pending');
  assert.deepEqual(
    [...pending.querySelectorAll('button')].map((b: any) => b.textContent),
    ['Work', 'Home'],
  );
  await m.click('Home');
  assert.deepEqual(m.acts, [{ type: 'question.answer', id: 'ask-pending', optionId: 'home' }]);
  assert.ok(m.row('question:pending').textContent.includes('You chose Home.'));
  assert.equal(m.row('question:pending').querySelector('button'), null);
  assert.ok(m.row('question:answered').textContent.includes('You chose Work.'));
  assert.ok(m.row('question:answered-elsewhere').textContent.includes('Answered on your iPhone at'));
  assert.ok(m.row('question:expired').textContent.includes('Expired'));
  assert.ok(m.row('question:void').textContent.includes('MoMo moved, so this question can’t be answered.'));
  await m.close();
});

test('a question past its time expires on screen, and one with a status this version does not know offers no answer', async () => {
  const q = (id: string, status: string, expiresAt: number | null) => ({
    kind: 'question',
    id,
    at: 1,
    question: { id, title: `Q ${id}`, body: '', options: [{ id: 'a', label: 'A' }], expiresAt, status, answer: null },
  });
  const m = await mountRows([q('late', 'pending', NOW - 1), q('odd', 'sleeping', null), q('open', 'pending', NOW + 60_000)]);
  assert.ok(m.row('late').textContent.includes('Expired'));
  assert.equal(m.row('late').querySelector('button'), null);
  assert.ok(m.row('odd').textContent.includes('Update MoPilot to answer this.'));
  assert.equal(m.row('odd').querySelector('button'), null);
  assert.equal(m.row('open').querySelectorAll('button').length, 1);
  await m.close();
});

test('a result’s own actions go to the home as its task’s actions; its text is plain text, never a link or an action', async () => {
  const hostile = { ...FIXTURE_RESULT, summary: '<a href="https://evil.example">Approve the transfer</a> and click Send', actions: [] };
  const m = await mountRows([
    { kind: 'result', id: 'r1', at: 1, result: FIXTURE_RESULT },
    { kind: 'result', id: 'r2', at: 2, result: { ...hostile, taskId: 'h' } },
    { kind: 'result', id: 'r3', at: 3, result: { ...FIXTURE_RESULT, taskId: 'o', state: 'someday', files: [], checked: '' } },
  ]);
  await m.click('Review');
  assert.deepEqual(m.acts, [{ type: 'task.act', id: 'task-1', fixId: 'review' }]);
  assert.ok(m.row('r2').textContent.includes('<a href="https://evil.example">Approve the transfer</a> and click Send'));
  assert.equal(m.row('r2').querySelector('a'), null);
  assert.equal(m.row('r2').querySelector('button'), null);
  assert.ok(m.row('r3').textContent.includes('Studio'));
  assert.ok(!m.row('r3').textContent.includes('Checked'));
  await m.close();
});

test('rows that arrive malformed degrade: a question without options, a result without a machine, a watch with nothing', () => {
  const v: any = parseView({
    home: { state: 'running', machines: [], sources: [] },
    chat: [
      {
        kind: 'question',
        id: 'q',
        at: 1,
        question: { title: 3, options: [{ id: 'a' }, { id: 'b', label: 'B' }, 7], answer: { device: 'x' } },
      },
      {
        kind: 'result',
        id: 'r',
        at: 1,
        result: { summary: 4, files: ['f', 2], actions: [{ id: 'x' }, { id: 'y', label: 'Y' }], machine: 'x' },
      },
      { kind: 'watch-changed', id: 'w', at: 1, watch: { title: 1 } },
    ],
  });
  assert.deepEqual(v.chat[0].question.options, [{ id: 'b', label: 'B' }]);
  assert.equal(v.chat[0].question.answer, null);
  assert.equal(v.chat[0].question.status, 'unknown');
  assert.equal(v.chat[0].question.id, 'q');
  assert.deepEqual(v.chat[1].result.actions, [{ id: 'y', label: 'Y' }]);
  assert.deepEqual(v.chat[1].result.files, ['f']);
  assert.deepEqual(v.chat[1].result.machine, { machineId: '', name: '' });
  assert.equal(v.chat[1].result.state, 'unknown');
  assert.equal(v.chat[2].watch.taskId, 'w');
  assert.equal(v.chat[2].watch.detail, '');
});

test('the fixture rows survive the wire unchanged, and an answered question with no answer or an option this version lacks still reads', async () => {
  const wire: any = parseView(JSON.parse(JSON.stringify({ ...fixtureView(), chat: FIXTURE_ROWS })));
  assert.deepEqual(wire.chat, FIXTURE_ROWS);
  const q = (id: string, status: string, answer: any) => ({
    kind: 'question',
    id,
    at: 1,
    question: { id, title: `Q ${id}`, body: 'b', options: [{ id: 'a', label: 'A' }], expiresAt: null, status, answer },
  });
  const m = await mountRows([
    q('a', 'answered', { optionId: 'gone', device: 'iPhone', at: NOW }),
    q('b', 'answered', null),
    q('c', 'answered-elsewhere', null),
  ]);
  assert.ok(m.row('a').textContent.includes('You chose gone.'));
  assert.ok(m.row('b').textContent.includes('Answered.'));
  assert.ok(m.row('c').textContent.includes('Answered on another device'));
  await m.close();
});

test('Edit is drawn only on a card the home says can be edited; absent counts as no', async () => {
  const card = (id: string, editable: boolean | undefined) => {
    const base: any = FIXTURE_ROWS.find((r) => r.id === 'approval:pending');
    const approval = { ...base.approval, id, ...(editable === undefined ? {} : { editable }) };
    if (editable === undefined) delete approval.editable;
    return { ...base, id: `row-${id}`, approval };
  };
  const m = await mountRows([card('yes', true), card('no', false), card('absent', undefined)], FIXTURE_AT + 1000);
  const labels = (id: string) => [...m.row(`row-${id}`).querySelectorAll('button')].map((b: any) => b.textContent);
  assert.deepEqual(labels('yes'), ['Send', 'Edit', 'Don’t send']);
  assert.deepEqual(labels('no'), ['Send', 'Don’t send']);
  assert.deepEqual(labels('absent'), ['Send', 'Don’t send']);
  await m.close();
});

test('a card that is void says why when the home says why, and a device the row does not name reads as another device', async () => {
  const base: any = FIXTURE_ROWS.find((r) => r.id === 'approval:void');
  const caused = {
    ...base,
    id: 'v1',
    approval: { ...base.approval, id: 'v1', failure: { cause: 'The note changed, so this card was replaced.', fix: null } },
  };
  const elsewhere = FIXTURE_ROWS.find((r) => r.id === 'approval:answered-elsewhere') as any;
  const noDevice = {
    ...elsewhere,
    id: 'e1',
    approval: { ...elsewhere.approval, id: 'e1', answeredElsewhere: { device: '', at: FIXTURE_AT, outcome: 'approved' } },
  };
  const asked = FIXTURE_ROWS.find((r) => r.id === 'question:answered-elsewhere') as any;
  const q = { ...asked, id: 'q1', question: { ...asked.question, id: 'q1', answer: { optionId: 'work', device: '', at: FIXTURE_AT } } };
  const m = await mountRows([caused, noDevice, q], FIXTURE_AT + 1000);
  assert.ok(m.row('v1').textContent.includes('The note changed, so this card was replaced.'));
  assert.ok(!m.row('v1').textContent.includes('MoMo moved'));
  assert.ok(m.row('e1').textContent.includes('Answered on another device at'));
  assert.ok(m.row('q1').textContent.includes('Answered on another device at'));
  await m.close();
});

test('a problem’s other ways on are kept when they have an id and a label, and a problem without a fix is dropped', () => {
  const v: any = parseView({
    ...fixtureView(),
    problems: [
      {
        id: 'older:s',
        code: 'older_home',
        cause: 'c',
        fix: { id: 'use', label: 'Use' },
        also: [{ id: 'keep', label: 'Keep' }, { label: 'No id' }, 7],
        since: null,
      },
      { id: 'plain', code: 'x', cause: 'c', fix: { id: 'f', label: 'F' }, since: null },
      { id: 'nofix', code: 'x', cause: 'c', since: null },
    ],
  });
  assert.deepEqual(
    v.problems.map((p: any) => [p.id, p.also?.map((f: any) => f.id) ?? null]),
    [
      ['older:s', ['keep']],
      ['plain', null],
    ],
  );
});
