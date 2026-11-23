// The dev host's stand-in for a MoMo question with answer chips (scripts/mobile-dev-host/fakeMomoOptions.mjs, `momo-options [on|off]`): the row it puts in MoMo's chat is the one the Mac sends (the text without the line, the labels in `options`), `off` takes those rows out, and the console, the controls and the fake MoMo carry the shape through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raiseOptions, SHAPES } from '../scripts/mobile-dev-host/fakeMomoOptions.mjs';
import { momoOptionsScenario } from '../scripts/mobile-dev-host/scenariosMomoOptions.mjs';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeMomo } from '../scripts/mobile-dev-host/fakeMomo.mjs';
import { createScenarios } from '../scripts/mobile-dev-host/scenarios.mjs';
import { readOptions } from '../shared/momoOptions.mjs';

const chat = () => ({ id: 'c', rows: [{ role: 'assistant', text: 'Hi' }] as any[] });

test('on is the question row the Mac would send: text without the line, three labels the parser reads', () => {
  const c = chat();
  assert.match(
    raiseOptions('on', c, () => 5),
    /three answers/,
  );
  const row = c.rows.at(-1);
  assert.deepEqual([row.role, row.at, row.id], ['assistant', 5, 'c-r2']);
  assert.deepEqual(row.options, ['Yes', 'No', 'Not now']);
  assert.deepEqual(readOptions(`${row.text}\nOptions: ${row.options.join(' | ')}`), { text: row.text, options: row.options });
  assert.doesNotMatch(row.text, /Options:/);
});

test('off takes those rows out and keeps the rest, saying how many', () => {
  const c = chat();
  assert.equal(
    raiseOptions('off', c, () => 5),
    "0 questions with answers removed from MoMo's chat",
  );
  raiseOptions('on', c, () => 5);
  assert.equal(
    raiseOptions('off', c, () => 5),
    "1 question with answers removed from MoMo's chat",
  );
  assert.deepEqual(c.rows, [{ role: 'assistant', text: 'Hi' }]);
});

test('a shape it does not know is refused, and the scenario defaults to on', async () => {
  assert.throws(() => raiseOptions('many', chat(), () => 5), /on, off/);
  assert.deepEqual([...SHAPES], ['on', 'off']);
  const asked: string[] = [];
  const scenario = momoOptionsScenario(() => ({ momoOptions: async (shape: string) => (asked.push(shape), 'ok') }));
  assert.equal(scenario.usage, 'momo-options [on|off]');
  await scenario.run([]);
  await scenario.run(['off']);
  assert.deepEqual(asked, ['on', 'off']);
});

test('the host console lists momo-options and passes its shape to the host’s controls', async () => {
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
    controls: { momoOptions: async (shape: string) => (asked.push(shape), 'options done') } as any,
  });
  assert.ok(scenarios.list().some((s: any) => s.usage === 'momo-options [on|off]'));
  assert.equal(await scenarios.run('momo-options'), 'options done');
  assert.equal(await scenarios.run('momo-options', ['off']), 'options done');
  assert.deepEqual(asked, ['on', 'off']);
});

test('the fake MoMo puts the question in its main chat and tells the phone the chat changed', async () => {
  const changes: string[] = [];
  const app = createFakeApp({ repo: '/repo', now: () => 9_000_000, sleep: async () => undefined, status: async () => '' });
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const momo = createFakeMomo({
    app,
    brainChangeAllowed: () => true,
    changed: (what: string) => void changes.push(what),
    now: () => 9_000_000,
  });
  assert.match(await momo.options('on'), /three answers/);
  const rows = [...app.chats.values()].flatMap((c: any) => c.rows).filter((r: any) => r.options);
  assert.equal(rows.length, 1);
  assert.deepEqual(changes.slice(-1), ['chat']);
  assert.match(await momo.options('off'), /^1 question/);
});
