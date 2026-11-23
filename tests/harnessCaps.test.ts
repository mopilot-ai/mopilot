// What a new chat on one harness gets once its session opens (electron/session/harnessCaps.cjs, #1385): the caps chats
// resolve with a basic harness's admission catalog standing in for its session, whether it can chat, takes images and
// gets MoPilot's tools; the admission entry's images; and a basic harness's permissions from a mode config option.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSpawn, INIT } from './support/electron-acp-fake.ts';

const require = createRequire(import.meta.url);
const { CapsService } = require('../electron/session/caps.cjs');
const { harnessCaps } = require('../electron/session/harnessCaps.cjs');
const { acpBindings } = require('../electron/harness/bindings.cjs');
const { Admission } = require('../electron/harness/admission.cjs');

/** The admission list with one entry for `id` (or none). */
const admitted = (id: string, entry: any) => ({
  list: () =>
    entry
      ? [
          { id: 'other', state: 'signin' },
          { id, ...entry },
        ]
      : [],
});
const MODES = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] };
const MODE_OPTION = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'build',
  options: [
    { value: 'build', name: 'Build' },
    { value: 'plan', name: 'Plan' },
  ],
};

function service(o: any = {}) {
  return new CapsService({
    ref: () => null,
    record: () => ({ meta: {}, segments: [] }),
    session: () => null,
    isEnabled: o.isEnabled ?? (() => true),
    codex: async () => ({ version: '0.163.0', models: [], negotiated: { probes: {}, flags: {} } }),
    claude: { version: () => '2.1.302', probeInfo: () => ({ models: [], fastBlocked: null }), appliedOf: () => null },
    instances: () => [],
    prefs: () => ({}),
    // goose's build and plan are its own modes (#1875)
    acpQuirks: (kind: string) => (kind === 'acp:goose' ? { agentModes: ['build', 'plan'] } : null),
  });
}

test('the first tier: chats, images from its declared prompt, tools through its channel, all four permission rows', async () => {
  for (const kind of ['codex', 'claude']) {
    const r = await harnessCaps(service(), kind);
    assert.equal(r.kind, kind);
    assert.equal(r.tier, 'first');
    assert.equal(r.family, kind);
    assert.deepEqual(r.works, { chat: true, images: true, tools: true, toolsOff: null, toolsOffCode: null }, kind);
    assert.equal(r.caps.permissions.state, 'native', kind);
    assert.equal(r.caps.browser.state, 'sage', kind);
    assert.equal(r.caps.computerUse.state, 'sage', kind);
  }
});

test('switches: a harness switched off neither chats nor gets tools; its channel off takes only the tools', async () => {
  const off = await harnessCaps(service({ isEnabled: (k: string) => k !== 'harness.codex.enabled' }), 'codex');
  assert.deepEqual(off.works, {
    chat: false,
    images: true,
    tools: false,
    toolsOff: 'Turned off by MoPilot for now.',
    toolsOffCode: 'tools.off',
  });
  const channel = await harnessCaps(service({ isEnabled: (k: string) => k !== 'channel.claude.sdkMcp' }), 'claude');
  assert.deepEqual(channel.works, {
    chat: true,
    images: true,
    tools: false,
    toolsOff: 'Turned off by MoPilot for now.',
    toolsOffCode: 'tools.off',
  });
  assert.equal(channel.caps.browser.state, 'disabled');
  assert.equal(channel.caps.browser.why.code, 'flag.killed.channel');
});

test('a basic harness: its admission catalog stands in for the session, its images and tools come from admission', async () => {
  const entry = { state: 'admitted', catalog: { modes: null, configOptions: [MODE_OPTION] }, images: true };
  const r = await harnessCaps(service(), 'acp:opencode', admitted('opencode', entry));
  assert.equal(r.tier, 'basic');
  assert.equal(r.family, 'acp');
  assert.deepEqual(r.works, { chat: true, images: true, tools: true, toolsOff: null, toolsOffCode: null });
  // a mode config option counts, as the composer's permission menu reads it
  assert.equal(r.caps.permissions.state, 'native');
  // a harness whose modes are all the agent's own has no permission modes (#1875)
  const own = await harnessCaps(service(), 'acp:goose', admitted('goose', entry));
  assert.equal(own.caps.permissions.state, 'absent');
  assert.equal(r.caps.computerUse.state, 'sage');
  // the entry is found by the whole id, never a prefix
  const prefix = await harnessCaps(service(), 'acp:open', admitted('opencode', entry));
  assert.deepEqual(prefix.works, { chat: false, images: null, tools: false, toolsOff: null, toolsOffCode: null });
  // the catalog does not leak into a new chat's caps (no `opened`), nor into a started chat's
  const plain = await service().get(null, { kind: 'acp:opencode' });
  assert.equal(plain.caps.permissions.state, 'absent');
  const started = await service().get('c1', { kind: 'acp:opencode' }, { acp: entry.catalog });
  assert.equal(started.caps.permissions.state, 'absent');
});

test('a basic harness not admitted, not checked, without images, or with its channel off', async () => {
  const signin = await harnessCaps(service(), 'acp:kimi', admitted('kimi', { state: 'signin', catalog: null, images: false }));
  assert.deepEqual(signin.works, { chat: false, images: false, tools: false, toolsOff: null, toolsOffCode: null });
  assert.equal(signin.caps.permissions.state, 'absent');
  const none = await harnessCaps(service(), 'acp:kimi', admitted('kimi', null));
  assert.deepEqual(none.works, { chat: false, images: null, tools: false, toolsOff: null, toolsOffCode: null });
  const noAdmission = await harnessCaps(service(), 'acp:kimi', undefined);
  assert.deepEqual(noAdmission.works, { chat: false, images: null, tools: false, toolsOff: null, toolsOffCode: null });
  const entry = { state: 'admitted', catalog: { modes: MODES, configOptions: null }, images: undefined };
  const channel = await harnessCaps(
    service({ isEnabled: (k: string) => k !== 'channel.acp.sessionMcp' }),
    'acp:kimi',
    admitted('kimi', entry),
  );
  assert.deepEqual(channel.works, {
    chat: true,
    images: null,
    tools: false,
    toolsOff: 'Turned off by MoPilot for now.',
    toolsOffCode: 'tools.off',
  });
  assert.equal(channel.caps.permissions.state, 'native');
});

test('the capability-health record: a tool bridge that is not running keeps the tools from the families it serves', async () => {
  const noBridge = { channels: () => ({ claude: true, codex: false, acp: false }) };
  const codex = await harnessCaps(service(), 'codex', null, noBridge);
  assert.equal(codex.works.tools, false);
  assert.match(codex.works.toolsOff, /tool bridge isn't running/);
  assert.equal(codex.works.toolsOffCode, 'tools.bridge');
  // the family's own channel decides: Claude Code's is up
  assert.equal((await harnessCaps(service(), 'claude', null, noBridge)).works.tools, true);
  const entry = { state: 'admitted', catalog: null, images: true };
  const acp = await harnessCaps(service(), 'acp:opencode', admitted('opencode', entry), noBridge);
  assert.deepEqual([acp.works.chat, acp.works.tools], [true, false]);
  // a switch that is off says so before the bridge does
  const both = await harnessCaps(service({ isEnabled: (k: string) => k !== 'channel.codex.threadConfigMcp' }), 'codex', null, noBridge);
  assert.equal(both.works.toolsOff, 'Turned off by MoPilot for now.');
});

test('a service with no switches reader treats every switch as on', async () => {
  const s = service();
  s.o.isEnabled = undefined;
  assert.deepEqual((await harnessCaps(s, 'codex')).works, { chat: true, images: true, tools: true, toolsOff: null, toolsOffCode: null });
});

test('a harness this build does not know has nothing to say', async () => {
  assert.equal(await harnessCaps(service(), 'gemini', admitted('gemini', { state: 'admitted' })), null);
});

test("acpBindings: permissions from session modes or a mode config option other than the agent's own, none otherwise", () => {
  assert.equal(acpBindings({ modes: MODES }).permissions.via, 'config');
  assert.equal(acpBindings({ configOptions: [MODE_OPTION], agentModes: ['build'] }).permissions.via, 'config');
  // only the agent's own modes (#1875)
  assert.equal(acpBindings({ configOptions: [MODE_OPTION], agentModes: ['build', 'plan'] }).permissions.via, 'none');
  assert.equal(acpBindings({ configOptions: [{ ...MODE_OPTION, category: 'model' }] }).permissions.via, 'none');
  assert.equal(acpBindings({ modes: { currentModeId: 'a', availableModes: [] } }).permissions.via, 'none');
  assert.equal(acpBindings(null).permissions.via, 'none');
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-caps-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const BIN = path.join(dir, 'fake-bin');
fs.writeFileSync(BIN, 'x');

function admission(init: any, resolveBin: () => string | null = () => BIN) {
  const s = fakeSpawn({ initialize: () => init });
  return new Admission({
    ids: ['x'],
    file: path.join(dir, `${Math.random().toString(36).slice(2)}.json`),
    quirks: () => ({ label: 'Fake', bins: ['fake'], args: ['acp'], privacyDefaults: [], admission: { handshakeTimeoutMs: 1000 } }),
    resolveBin,
    env: () => ({}),
    tools: { prepare: async () => ({ mcpServers: [] }), admission: async () => true, end: () => {} },
    dataDir: dir,
    spawnFn: s.spawnFn,
  });
}

test('Admission: the entry says whether its prompts take images, as its last handshake declared; unknown before', async () => {
  const yes = admission(INIT({ promptCapabilities: { image: true } }));
  assert.equal(yes.list()[0].images, null);
  await yes.check('x');
  assert.equal(yes.list()[0].state, 'admitted');
  assert.equal(yes.list()[0].images, true);
  // the binary changed (an update): what the old one declared isn't said of the new one while it is checked again
  const bin = path.join(dir, 'updated-bin');
  fs.writeFileSync(bin, 'x');
  const updated = admission(INIT({ promptCapabilities: { image: true } }), () => bin);
  await updated.check('x');
  assert.equal(updated.list()[0].images, true);
  fs.writeFileSync(bin, 'a newer, larger binary');
  assert.deepEqual([updated.list()[0].state, updated.list()[0].images], ['checking', null]);
  const no = admission(INIT({}));
  await no.check('x');
  assert.equal(no.list()[0].images, false);
  assert.equal(admission(INIT({}), () => null).list()[0].images, null);
});
