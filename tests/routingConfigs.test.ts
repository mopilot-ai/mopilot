// electron/routing/configs.cjs: the named model configs in userData/llm-configs.json, validated on read and write (B1, B3); two windows' edits both survive (W1); a failed write keeps the prior state and announces nothing (W2, W3); a file that can't be read is kept, copied, reported and never read as empty (W3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createConfigs, checkConfig, CONFIGS_FILE, TIERS } = require('../electron/routing/configs.cjs');

const fileIn = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-configs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sub', CONFIGS_FILE);
};
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const BASE = { name: 'Cheap Sonnet', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' };
const ok = (v: unknown) => {
  const r = checkConfig(v);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.config;
};
const refused = (v: unknown) => {
  const r = checkConfig(v);
  assert.equal(r.ok, false, JSON.stringify(v));
  return r.error as string;
};

test('B3: a config is normalised; optional fields absent take their defaults and fields this version does not read are left out', () => {
  assert.deepEqual(ok({ id: 'a', ...BASE, extra: 1 }), { id: 'a', ...BASE, tierModels: {}, fallbacks: [] });
  assert.deepEqual(
    ok({
      id: 'a_B-9',
      name: '  Local  ',
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1/',
      model: ' llama3.1:8b ',
      tierModels: { haiku: 'qwen2.5:3b', opus: '', sonnet: null },
      fallbacks: [
        { provider: 'custom', model: 'qwen2.5:7b', note: 'x' },
        { provider: 'openai', model: 'gpt-5.5' },
      ],
    }),
    {
      id: 'a_B-9',
      name: 'Local',
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1:8b',
      tierModels: { haiku: 'qwen2.5:3b' },
      fallbacks: [
        { provider: 'custom', model: 'qwen2.5:7b' },
        { provider: 'openai', model: 'gpt-5.5' },
      ],
    },
  );
  assert.deepEqual(ok({ id: 'a', ...BASE, baseUrl: null, tierModels: null, fallbacks: null }).fallbacks, []);
  assert.deepEqual(ok({ id: 'a', ...BASE, baseUrl: '' }).baseUrl, undefined);
  assert.deepEqual(TIERS, ['opus', 'sonnet', 'haiku']);
});

test('B1: missing, null and wrong-typed fields, arrays for records and unknown providers are refused with the reason', () => {
  for (const v of [null, [], 'x', 7]) assert.match(refused(v), /must be an object/);
  for (const id of [undefined, '', 'a/b', 'a b', 'a:b', 'x'.repeat(65), 7]) assert.match(refused({ ...BASE, id }), /id is not valid/);
  for (const name of [undefined, '', '   ', 'x'.repeat(81), 'a\nb', 7]) assert.match(refused({ id: 'a', ...BASE, name }), /name/);
  for (const provider of [undefined, 'mistral', 'toString']) assert.match(refused({ id: 'a', ...BASE, provider }), /Choose a provider/);
  for (const model of [undefined, '', 'has space', 'x'.repeat(201), 7]) assert.match(refused({ id: 'a', ...BASE, model }), /model’s id/);
  assert.match(refused({ id: 'a', ...BASE, baseUrl: 'https://proxy.example' }), /only an OpenAI-compatible server takes a URL/);
  assert.match(refused({ id: 'a', ...BASE, provider: 'custom' }), /Enter the server/);
  assert.match(refused({ id: 'a', ...BASE, provider: 'custom', baseUrl: 'http://llm.example.com' }), /https/);
  assert.match(refused({ id: 'a', ...BASE, tierModels: [] }), /Tier models must be an object/);
  assert.match(refused({ id: 'a', ...BASE, tierModels: { mini: 'x' } }), /not a Claude model family/);
  assert.match(refused({ id: 'a', ...BASE, tierModels: { haiku: 'has space' } }), /haiku model’s id/);
  assert.match(refused({ id: 'a', ...BASE, fallbacks: {} }), /Fallbacks must be a list/);
  assert.match(
    refused({ id: 'a', ...BASE, fallbacks: Array.from({ length: 9 }, (_, i) => ({ provider: 'openai', model: `m${i}` })) }),
    /at most 8/,
  );
  for (const f of [null, [], 'openai', { provider: 'openai' }, { model: 'gpt-5.5' }, { provider: 'mistral', model: 'x' }])
    assert.match(refused({ id: 'a', ...BASE, fallbacks: [f] }), /needs a provider and a model/);
  assert.match(refused({ id: 'a', ...BASE, fallbacks: [{ provider: 'custom', model: 'llama' }] }), /only in a config that does/);
  assert.match(
    refused({ id: 'a', ...BASE, fallbacks: [{ provider: 'openrouter', model: BASE.model }] }),
    /listed twice/,
    'the primary again',
  );
  assert.match(
    refused({
      id: 'a',
      ...BASE,
      fallbacks: [
        { provider: 'openai', model: 'gpt-5.5' },
        { provider: 'openai', model: ' gpt-5.5' },
      ],
    }),
    /listed twice/,
  );
});

test('a config is added with a new id, replaced by its id in place, read back, and removed; each change is announced', (t) => {
  const file = fileIn(t);
  const store = createConfigs({ file, newId: ids() });
  let heard = 0;
  const off = store.onChange(() => heard++);
  assert.deepEqual(store.list(), { configs: [], invalid: 0, state: 'ok' }, 'no file yet: none, and readable');
  const a = store.save({ ...BASE });
  assert.equal(a.id, 'id-1');
  const b = store.save({ ...BASE, id: '', name: 'Second' });
  assert.equal(b.id, 'id-2');
  assert.equal(store.save({ ...BASE, id: null, name: 'Third' }).id, 'id-3');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  store.save({ ...a, name: 'Renamed', fallbacks: [{ provider: 'deepseek', model: 'deepseek-chat' }] });
  assert.deepEqual(
    store.list().configs.map((c: any) => [c.id, c.name]),
    [
      ['id-1', 'Renamed'],
      ['id-2', 'Second'],
      ['id-3', 'Third'],
    ],
    'replaced where it was',
  );
  assert.deepEqual(store.get('id-1').fallbacks, [{ provider: 'deepseek', model: 'deepseek-chat' }]);
  assert.equal(store.get('nope'), null);
  // what a caller gets is a copy: changing it changes nothing kept
  store.get('id-1').fallbacks.push({ provider: 'openai', model: 'x' });
  store.list().configs[0].name = 'changed';
  assert.equal(store.get('id-1').fallbacks.length, 1);
  assert.equal(store.get('id-1').name, 'Renamed');
  assert.equal(store.remove('id-2'), true);
  assert.equal(store.remove('id-2'), false);
  assert.equal(store.remove(7), false);
  assert.deepEqual(
    store.list().configs.map((c: any) => c.id),
    ['id-1', 'id-3'],
  );
  assert.equal(heard, 5, 'three adds, a replace and a remove; nothing for a remove that found none');
  assert.throws(
    () => store.save({ ...BASE, model: '' }),
    (e: any) => e.code === 'invalid' && /model’s id/.test(e.message),
  );
  assert.throws(
    () => store.save('x'),
    (e: any) => e.code === 'invalid',
  );
  assert.equal(heard, 5);
  off();
  store.remove('id-1');
  assert.equal(heard, 5);
});

test('W1: two windows’ edits made before either sees the other’s both survive, mixed add, replace and remove', (t) => {
  const file = fileIn(t);
  const first = createConfigs({ file, newId: () => 'w1' });
  const second = createConfigs({ file, newId: () => 'w2' });
  const seed = first.save({ ...BASE, id: 'seed' });
  const gone = first.save({ ...BASE, id: 'gone', name: 'Gone' });
  // each window still shows only these two
  first.save({ ...BASE, name: 'From one' });
  second.save({ ...BASE, name: 'From two' });
  second.save({ ...seed, model: 'openai/gpt-5.5' });
  first.remove(gone.id);
  const both = createConfigs({ file }).list().configs;
  assert.deepEqual(
    both.map((c: any) => [c.id, c.name, c.model]),
    [
      ['seed', BASE.name, 'openai/gpt-5.5'],
      ['w1', 'From one', BASE.model],
      ['w2', 'From two', BASE.model],
    ],
  );
});

test('B3, W3: entries this version does not take and fields a newer one wrote are kept on disk through other writes', (t) => {
  const file = fileIn(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const future = { ...BASE, id: 'f', tierModels: {}, fallbacks: [], budget: { usd: 5 } };
  const odd = { id: 'odd', provider: 'someday', model: 'x' };
  const twin = { ...BASE, id: 'f', name: 'Twin' };
  fs.writeFileSync(file, JSON.stringify({ v: 2, defaultId: 'f', configs: [future, odd, 'junk', twin] }));
  const store = createConfigs({ file, newId: () => 'new' });
  assert.deepEqual(store.list(), { configs: [{ ...BASE, id: 'f', tierModels: {}, fallbacks: [] }], invalid: 3, state: 'ok' });
  store.save({ ...BASE, name: 'New' });
  let raw = JSON.parse(fs.readFileSync(file, 'utf8')).configs;
  assert.deepEqual(raw.slice(0, 4), [future, odd, 'junk', twin], 'untouched entries are written back as they were');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([written.v, written.defaultId], [2, 'f'], 'and so are the file’s own fields');
  // replacing the newer version's config keeps the field it does not read; its second entry under that id goes with the old one
  store.save({ ...BASE, id: 'f', name: 'Edited' });
  raw = JSON.parse(fs.readFileSync(file, 'utf8')).configs;
  assert.deepEqual(raw[0], { budget: { usd: 5 }, ...BASE, id: 'f', name: 'Edited', tierModels: {}, fallbacks: [] });
  assert.equal(raw.filter((r: any) => r?.id === 'f').length, 1);
  // an entry this version can't take is replaced by a save of its id, and removed by a remove of it
  store.save({ ...BASE, id: 'odd' });
  assert.equal(store.get('odd').provider, 'openrouter');
  assert.equal(store.remove('odd'), true);
  assert.deepEqual(
    store.list().configs.map((c: any) => c.id),
    ['f', 'new'],
  );
  assert.equal(store.list().invalid, 1, 'the junk entry is still there');
});

test('W3: a file that can’t be read keeps the configs last read, is copied aside and never written over; reads as unreadable, not empty', (t) => {
  const file = fileIn(t);
  const store = createConfigs({ file, newId: () => 'kept' });
  store.save({ ...BASE });
  let heard = 0;
  store.onChange(() => heard++);
  for (const bad of ['{not json', '[]', JSON.stringify({ configs: {} }), 'null']) {
    fs.writeFileSync(file, bad);
    const now = store.list();
    assert.equal(now.state, 'unreadable', bad);
    assert.deepEqual(
      now.configs.map((c: any) => c.id),
      ['kept'],
      'the configs last read are shown',
    );
    assert.equal(store.get('kept')?.id, 'kept', 'what list shows, get finds');
    assert.throws(
      () => store.save({ ...BASE, name: 'More' }),
      (e: any) => e.code === 'unreadable',
    );
    assert.throws(
      () => store.remove('kept'),
      (e: any) => e.code === 'unreadable',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), bad, 'not written over');
  }
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{not json', 'the first unreadable copy is kept');
  assert.equal(heard, 0);
  // a store that never read the file whole has nothing to show, and says the file is unreadable rather than empty
  assert.deepEqual(createConfigs({ file }).list(), { configs: [], invalid: 0, state: 'unreadable' });
  // the file repaired: read again as it is
  fs.writeFileSync(file, JSON.stringify({ configs: [] }));
  assert.deepEqual(store.list(), { configs: [], invalid: 0, state: 'ok' });
});

test('W2, W3: a write that fails keeps the file and the configs as they were, announces nothing, and a retry succeeds', (t) => {
  const file = fileIn(t);
  let fail = false;
  const store = createConfigs({
    file,
    newId: ids(),
    write: (f: string, d: string) => {
      if (fail) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      fs.writeFileSync(f, d);
    },
  });
  store.save({ ...BASE });
  let heard = 0;
  store.onChange(() => heard++);
  const before = fs.readFileSync(file, 'utf8');
  fail = true;
  assert.throws(
    () => store.save({ ...BASE, name: 'Lost?' }),
    (e: any) => e.code === 'write_failed' && e.message === 'The model configs could not be saved.',
  );
  assert.throws(
    () => store.remove('id-1'),
    (e: any) => e.code === 'write_failed',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(
    store.list().configs.map((c: any) => c.id),
    ['id-1'],
  );
  assert.equal(heard, 0);
  fail = false;
  assert.equal(store.save({ ...BASE, name: 'Retried' }).id, 'id-3', 'the retry saves');
  assert.equal(heard, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 1, 'a file this version started is v1');
});

test('W2: a folder that can’t be made is a failed save, not a fault', (t) => {
  const file = fileIn(t);
  const parent = path.dirname(path.dirname(file));
  // the folder it goes in can't be made (its parent is read-only), while the file reads as not there yet
  fs.chmodSync(parent, 0o500);
  t.after(() => void (fs.existsSync(parent) && fs.chmodSync(parent, 0o700)));
  const store = createConfigs({ file, newId: ids() });
  assert.deepEqual(store.list().state, 'ok');
  assert.throws(
    () => store.save({ ...BASE }),
    (e: any) => e.code === 'write_failed',
  );
});

test('the library is bounded: a new config past 100 is refused, a replace still saves', (t) => {
  const file = fileIn(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ configs: Array.from({ length: 100 }, (_, i) => ({ ...BASE, id: `c${i}` })) }));
  const store = createConfigs({ file, newId: () => 'over' });
  assert.throws(
    () => store.save({ ...BASE }),
    (e: any) => e.code === 'invalid' && /at most 100/.test(e.message),
  );
  assert.equal(store.save({ ...BASE, id: 'c5', name: 'Still' }).name, 'Still');
});
