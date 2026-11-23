// The models Claude Code offers on a Host (host/src/claudeModels.mjs): asked once and kept, never waited for by a status, retried after a pause when the ask fails or finds none, and the last good list kept (A: overlap and time; B: shapes of the CLI's answer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelCache, pickModels } from '../host/src/claudeModels.mjs';

const model = (id: string) => ({ id, name: id.toUpperCase(), default: false, efforts: [] as string[] });

function cache(asks: (() => Promise<any>)[]) {
  let at = 0;
  const reported: unknown[] = [];
  let n = 0;
  const c = createModelCache({ ask: () => asks[Math.min(n++, asks.length - 1)](), now: () => at, report: (e) => reported.push(e) });
  return { c, reported, asked: () => n, tick: (ms: number) => (at += ms) };
}

test('A: the first read starts one ask and returns nothing yet; the list is there once the ask answers, and kept for ten minutes', async () => {
  const t = cache([async () => [model('a')]]);
  await t.c.settled();
  assert.deepEqual(t.c.get(), []);
  assert.deepEqual(t.c.get(), [], 'a second read joins the ask under way');
  assert.equal(t.asked(), 1);
  await t.c.settled();
  assert.deepEqual(t.c.get(), [model('a')]);
  t.tick(9 * 60_000);
  t.c.get();
  assert.equal(t.asked(), 1, 'kept');
  t.tick(2 * 60_000);
  assert.deepEqual(t.c.get(), [model('a')], 'the old list is still shown while the new ask runs');
  assert.equal(t.asked(), 2);
  await t.c.settled();
});

test('A: a failed ask keeps the last good list and waits a minute before the next; an empty answer waits too', async () => {
  const t = cache([
    async () => [model('a')],
    async () => {
      throw new Error('the CLI is gone');
    },
    async () => [],
    async () => [model('b')],
  ]);
  t.c.get();
  await t.c.settled();
  t.tick(11 * 60_000);
  t.c.get();
  await t.c.settled();
  assert.equal(t.reported.length, 1);
  assert.deepEqual(t.c.get(), [model('a')]);
  assert.equal(t.asked(), 2, 'not asked again inside the pause');
  t.tick(30_000);
  t.c.get();
  assert.equal(t.asked(), 2);
  t.tick(31_000);
  t.c.get();
  await t.c.settled();
  assert.equal(t.asked(), 3);
  assert.deepEqual(t.c.get(), [model('a')], 'an empty answer is not a list');
  t.tick(61_000);
  t.c.get();
  await t.c.settled();
  assert.deepEqual(t.c.get(), [model('b')]);
});

test('B: a model is the shape Codex’s entry has, with its extras, and one with no id is none', () => {
  assert.deepEqual(
    pickModels([
      {
        value: 'opus',
        displayName: 'Opus',
        description: 'Big',
        supportsEffort: true,
        supportedEffortLevels: ['low', '', 'high', 7],
        supportsAutoMode: true,
        secret: 'x',
      },
      { value: 'default', displayName: 'Default (recommended)' },
      { value: 'plain' },
      { value: '' },
      { displayName: 'nameless' },
      null,
      'junk',
    ]),
    [
      {
        id: 'opus',
        name: 'Opus',
        default: false,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        description: 'Big',
        supportsAutoMode: true,
      },
      { id: 'default', name: 'Default (recommended)', default: true, efforts: [], defaultEffort: null },
      { id: 'plain', name: 'plain', default: false, efforts: [], defaultEffort: null },
    ],
  );
  assert.deepEqual(pickModels(undefined), []);
  assert.deepEqual(pickModels({ value: 'x' }), []);
});

test('A/B (#4935): every alias and the default entry carry the resolved name, the pinned id, the default effort and the fast flag the CLI reports', () => {
  const levels = ['low', 'medium', 'xhigh'];
  const [dflt, opus, pinned, million, bare, own] = pickModels([
    {
      value: 'default',
      displayName: 'Default (recommended)',
      description: 'Use the default model (currently Sonnet 4.5) · Everyday',
      supportedEffortLevels: levels,
    },
    {
      value: 'opus',
      displayName: 'Opus',
      description: 'Opus 5.5 · Best for complex work',
      resolvedModel: 'claude-opus-5-5',
      supportedEffortLevels: ['low', 'high'],
      supportsFastMode: true,
    },
    // a pinned id without an alias, and no version in its description: the name is read from the id
    { value: 'claude-opus-4-1', displayName: 'Opus 4.1', description: 'Older', resolvedModel: 'claude-opus-4-1' },
    {
      value: 'sonnet[1m]',
      displayName: 'Sonnet',
      description: 'Sonnet 5.5 · Long',
      supportedEffortLevels: ['high'],
      supportsFastMode: false,
    },
    // nothing says a version: no resolved name (never the alias), and no fast flag unless the CLI sent a boolean
    { value: 'haiku', displayName: 'Haiku', description: 'Fastest', supportsFastMode: 'yes' },
    { value: 'x', displayName: 'X', supportedEffortLevels: ['low', 'max'], defaultEffort: 'max' },
  ]);
  assert.equal(dflt.resolvedModel, 'Sonnet 4.5');
  assert.equal(dflt.defaultEffort, 'low', 'no high: the first level');
  assert.deepEqual(
    [opus.resolvedModel, opus.resolvedId, opus.defaultEffort, opus.supportsFastMode],
    ['Opus 5.5', 'claude-opus-5-5', 'high', true],
  );
  assert.deepEqual(
    [pinned.resolvedModel, pinned.resolvedId, pinned.defaultEffort, 'supportsFastMode' in pinned],
    ['Opus 4.1', 'claude-opus-4-1', null, false],
  );
  assert.deepEqual([million.resolvedModel, million.supportsFastMode], ['Sonnet 5.5 1M', false]);
  assert.deepEqual([bare.resolvedModel, bare.resolvedId, 'supportsFastMode' in bare], [undefined, undefined, false]);
  assert.equal(own.defaultEffort, 'max', "the CLI's own default wins when it is one of the levels");
});
