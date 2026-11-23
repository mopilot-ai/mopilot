// What a basic harness offers new chats, kept by electron/harness/admission.cjs: the probe's session/new catalog, a
// check that opens no session keeping the last one, a chat's new session updating it, the permission rows its quirks
// map, and an admission from before catalogs were kept being checked once more.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSpawn } from './support/electron-acp-fake.ts';

const require = createRequire(import.meta.url);
const { Admission, probe, binStamp } = require('../electron/harness/admission.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-catalog-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const BIN = path.join(dir, 'fake-bin');
fs.writeFileSync(BIN, 'x');

const Q = (extra: any = {}) => ({
  label: 'Fake',
  bins: ['fake'],
  args: ['acp'],
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 1000 },
  ...extra,
});
const tools = { prepare: async () => ({ mcpServers: [] }), admission: async () => true, end: () => {} };
const MODEL = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] };
const MODES = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] };

function admission(handlers: any, q: any = Q(), file = path.join(dir, `${Math.random().toString(36).slice(2)}.json`)) {
  const s = fakeSpawn(handlers);
  const a = new Admission({
    ids: ['x'],
    file,
    quirks: () => q,
    resolveBin: () => BIN,
    env: () => ({}),
    tools,
    dataDir: dir,
    spawnFn: s.spawnFn,
  });
  const heard: any[] = [];
  a.onChange((list: any[]) => heard.push(list[0]));
  return { a, s, heard, file };
}

test('probe: an admitted harness carries what its session/new offered; one that declares nothing carries none', async () => {
  const o = (handlers: any) => ({
    quirks: () => Q(),
    resolveBin: () => BIN,
    env: () => ({}),
    tools,
    dataDir: dir,
    spawnFn: fakeSpawn(handlers).spawnFn,
  });
  const r = await probe('x', o({ 'session/new': () => ({ sessionId: 's', configOptions: [MODEL], modes: MODES }) }));
  assert.deepEqual(r.catalog, { modes: MODES, configOptions: [MODEL] });
  assert.equal((await probe('x', o({ 'session/new': () => ({ sessionId: 's' }) }))).catalog, null);
  // a modes object without its list is not a catalog
  assert.equal((await probe('x', o({ 'session/new': () => ({ sessionId: 's', modes: { currentModeId: 'a' } }) }))).catalog, null);
});

test('Admission: the catalog and the quirks permission rows are listed; a check that opens no session keeps the last catalog', async () => {
  let signedOut = false;
  const { a } = admission(
    {
      'session/new': () => {
        if (signedOut) throw Object.assign(new Error('Not logged in'), { code: -32000 });
        return { sessionId: 's', configOptions: [MODEL] };
      },
    },
    Q({ permissionModes: { plan: 'read-only' }, authMethods: [] }),
  );
  await a.check('x');
  assert.deepEqual(a.list()[0].catalog, { modes: null, configOptions: [MODEL], audio: false });
  assert.deepEqual(a.list()[0].permissionModes, { plan: 'read-only' });
  signedOut = true;
  await a.check('x');
  assert.equal(a.list()[0].state, 'signin');
  assert.deepEqual(a.list()[0].catalog, { modes: null, configOptions: [MODEL], audio: false });
});

test('Admission.noteCatalog: a new session updates it once and tells the windows; nothing, the same, or an unknown harness is ignored', async () => {
  const { a, heard, file } = admission({ 'session/new': () => ({ sessionId: 's', configOptions: [MODEL] }) });
  await a.check('x');
  const n = heard.length;
  a.noteCatalog('x', null);
  a.noteCatalog('x', { modes: null, configOptions: [MODEL] });
  a.noteCatalog('y', { modes: MODES, configOptions: null });
  assert.equal(heard.length, n);
  const next = { modes: null, configOptions: [{ ...MODEL, currentValue: 'b' }] };
  a.noteCatalog('x', next);
  assert.equal(heard.length, n + 1);
  assert.deepEqual(heard.at(-1).catalog, { ...next, audio: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).x.catalog, next);
});

test('Admission: an admission cached before catalogs were kept is checked once more; a missing binary lists none', async () => {
  const file = path.join(dir, 'legacy.json');
  fs.writeFileSync(file, JSON.stringify({ x: { state: 'admitted', reason: null, version: '1', stamp: binStamp(BIN) } }));
  const { a, s } = admission({ 'session/new': () => ({ sessionId: 's' }) }, Q(), file);
  assert.equal(a.list()[0].state, 'checking');
  assert.equal(a.list()[0].catalog, null);
  await a.refresh();
  assert.equal(s.calls.length, 1);
  // checked: its catalog (none) is known now, so no further check
  assert.equal(a.list()[0].state, 'admitted');
  await a.refresh();
  assert.equal(s.calls.length, 1);
  const gone = new Admission({ ids: ['x'], file, quirks: () => null, resolveBin: () => null, env: () => ({}), tools, dataDir: dir });
  assert.deepEqual([gone.list()[0].state, gone.list()[0].catalog, gone.list()[0].permissionModes], ['missing', null, {}]);
});

test('Admission.noteCatalog: a cached entry without a catalog takes the first one a session shows', () => {
  const file = path.join(dir, 'legacy-note.json');
  fs.writeFileSync(file, JSON.stringify({ x: { state: 'admitted', reason: null, version: '1', stamp: binStamp(BIN) } }));
  const { a, heard } = admission({}, Q(), file);
  a.noteCatalog('x', { modes: MODES, configOptions: null });
  assert.deepEqual(heard.at(-1).catalog, { modes: MODES, configOptions: null });
  assert.equal(a.list()[0].state, 'admitted');
});

test('audio-capable harnesses offer an audio first message even without a model or mode catalog', async () => {
  const { a } = admission({
    initialize: () => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { audio: true } } }),
    'session/new': () => ({ sessionId: 's' }),
  });
  await a.check('x');
  assert.deepEqual(a.list()[0].catalog, { modes: null, configOptions: null, audio: true });
});
