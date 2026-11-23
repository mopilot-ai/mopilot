// The dev host's stand-in for a routine's report in MoMo's chat (scripts/mobile-dev-host/fakeMomoReport.mjs, #4822): the rows `momo-report` puts in the fake chat carry the framing the Mac sends, which the phone must draw as a one-line card; off takes them out; a shape it does not know is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raiseReport, SHAPES } from '../scripts/mobile-dev-host/fakeMomoReport.mjs';
import { momoReportScenario } from '../scripts/mobile-dev-host/scenariosMomoReport.mjs';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createScenarios } from '../scripts/mobile-dev-host/scenarios.mjs';
import { authoredCard } from '../shared/authoredEnvelope.mjs';

const chat = () => ({ id: 'c', rows: [{ role: 'assistant', text: 'Hi' }] as any[] });

test('each shape is a user-role row the phone reads as a card, and the row text is the real wrapper', () => {
  const kinds: Record<string, string> = { done: 'routine', failed: 'routine', setup: 'marked' };
  for (const shape of ['done', 'failed', 'setup']) {
    const c = chat();
    assert.match(
      raiseReport(shape, c, () => 5),
      /one-line/,
    );
    const row = c.rows.at(-1);
    assert.equal(row.role, 'user');
    assert.equal(row.at, 5);
    assert.equal(row.id, 'c-r2');
    assert.match(row.text, /not from the user/);
    assert.equal(authoredCard(row.text)?.kind, kinds[shape]);
  }
});

test('off takes the reports out and keeps the rest, saying how many', () => {
  const c = chat();
  assert.equal(
    raiseReport('off', c, () => 5),
    "0 reports removed from MoMo's chat",
  );
  raiseReport('done', c, () => 5);
  assert.equal(
    raiseReport('off', c, () => 5),
    "1 report removed from MoMo's chat",
  );
  raiseReport('done', c, () => 5);
  raiseReport('failed', c, () => 5);
  assert.equal(
    raiseReport('off', c, () => 5),
    "2 reports removed from MoMo's chat",
  );
  assert.deepEqual(c.rows, [{ role: 'assistant', text: 'Hi' }]);
});

test('a shape it does not know is refused, and the scenario defaults to done', async () => {
  assert.throws(() => raiseReport('many', chat(), () => 5), /done, failed, setup, off/);
  assert.deepEqual([...SHAPES], ['done', 'failed', 'setup', 'off']);
  const asked: string[] = [];
  const scenario = momoReportScenario(() => ({ momoReport: async (shape: string) => (asked.push(shape), 'ok') }));
  assert.equal(scenario.usage, 'momo-report [done|failed|setup|off]');
  await scenario.run([]);
  await scenario.run(['off']);
  assert.deepEqual(asked, ['done', 'off']);
});

test('the host console lists momo-report and passes its shape to the host’s controls', async () => {
  const asked: string[] = [];
  const app = createFakeApp({
    repo: '/repo',
    log: () => undefined,
    now: () => 9_000_000,
    sleep: async () => undefined,
    status: async () => '',
  });
  const scenarios = createScenarios({
    app,
    now: () => 9_000_000,
    controls: { momoReport: async (shape: string) => (asked.push(shape), 'report done') } as any,
  });
  assert.ok(scenarios.list().some((s: any) => s.usage === 'momo-report [done|failed|setup|off]'));
  assert.equal(await scenarios.run('momo-report'), 'report done');
  assert.equal(await scenarios.run('momo-report', ['failed']), 'report done');
  assert.deepEqual(asked, ['done', 'failed']);
});
