// Runtime admission for basic-tier harnesses (electron/harness/admission.cjs) and the quirks framework
// (electron/harness/quirks/index.cjs), against the fake ACP agent with the real sage-mcp channel.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSageMcp } from '../scripts/build-sage-mcp.mjs';

const require = createRequire(import.meta.url);
const { Admission, probe, isAuthError } = require('../electron/harness/admission.cjs');
const quirks = require('../electron/harness/quirks/index.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ToolSocket, sageMcpPath } = require('../electron/capabilities/mcp/socket.cjs');
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
// built once per run, under a lock shared with the other test files (a failed build fails here, loudly)
const builtBin = ensureSageMcp({ log: console.error });
const skip = builtBin ? false : 'needs macOS with a swift toolchain to build sage-mcp';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-admission-')));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let channel: any = null;
let socket: any = null;
after(() => socket?.close());
function tools() {
  if (channel) return channel;
  const sessions = new ToolSessions();
  socket = new ToolSocket({ sessions, registry: new Registry() });
  channel = new SessionMcp({ sessions, socket, command: sageMcpPath(), admissionMs: 10_000 });
  return channel;
}

/** A fake harness behind a launcher script, as an installed binary would be. */
function fake(id: string, profile: object, extra: object = {}) {
  const bin = path.join(dir, `${id}-bin`);
  const state = path.join(dir, `${id}-state`);
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nexport FAKE_ACP_STATE='${state}'\nexport FAKE_ACP_PROFILE='${JSON.stringify(profile)}'\nexec "${process.execPath}" "${AGENT}" "$@"\n`,
    { mode: 0o755 },
  );
  const q = { label: `Fake ${id}`, bins: [id], args: [], privacyDefaults: [], admission: { handshakeTimeoutMs: 10_000 }, ...extra };
  return { bin, state, q };
}
const opts = (f: ReturnType<typeof fake>) => ({
  quirks: () => f.q,
  resolveBin: () => f.bin,
  env: () => process.env,
  tools: tools(),
  dataDir: dir,
});

test('quirks: privacyDefaults and admission are required; the optional parts are type-checked', () => {
  const ok = { label: 'X', bins: ['x'], args: ['acp'], privacyDefaults: [], admission: { handshakeTimeoutMs: 10_000 } };
  assert.deepEqual(quirks.validate(ok), []);
  assert.deepEqual(quirks.validate({ ...ok, privacyDefaults: undefined }), ['privacyDefaults']);
  assert.deepEqual(quirks.validate({ ...ok, admission: undefined }), ['admission']);
  assert.deepEqual(quirks.validate({ ...ok, args: undefined }), ['args or launch']);
  assert.deepEqual(quirks.validate({ ...ok, args: undefined, launch: () => ({ args: [] }) }), []);
  assert.deepEqual(quirks.validate({ ...ok, anchors: { plan: 'readOnly', yolo: 'everything' } }), ['anchors']);
  assert.deepEqual(quirks.validate({ ...ok, plan: {} }), ['plan']);
  assert.deepEqual(quirks.validate({ ...ok, titleSessions: 'no' }), ['titleSessions']);
  assert.deepEqual(quirks.validate({ ...ok, titleSessions: false }), []);
  assert.deepEqual(
    quirks.validate({
      ...ok,
      plan: { mode: 'plan' },
      anchors: { plan: 'readOnly' },
      modalities: { m: ['text', 'image'] },
      resumeCommand: (id: string) => id,
      versions: { min: '1' },
    }),
    [],
  );
  assert.equal(quirks.anchorOf({ anchors: { plan: 'readOnly' } }, 'plan'), 'readOnly');
  assert.equal(quirks.anchorOf({ anchors: {} }, 'code'), 'ask');
  // every harness in the list either has a valid quirks file or none yet
  for (const id of quirks.ids()) {
    const q = quirks.quirks(id);
    if (q) assert.deepEqual(quirks.validate(q), [], id);
  }
});

test("a quirks login runs the harness's own binary; Goose's is goose configure, since its authenticate configures nothing", () => {
  for (const id of quirks.ids()) {
    const q = quirks.quirks(id);
    if (q?.loginCommand == null) continue;
    assert.ok(Array.isArray(q.loginCommand) && q.loginCommand.every((a: unknown) => typeof a === 'string'), id);
    assert.ok(q.bins.includes(q.loginCommand[0]), `${id}: its login starts with one of its binaries`);
  }
  assert.deepEqual(quirks.quirks('goose').loginCommand, ['goose', 'configure']);
});

test('findBin: SAGE_ACP_BINS replaces the PATH search', () => {
  assert.equal(
    quirks.findBin('kimi', () => '/usr/local/bin/kimi', { SAGE_ACP_BINS: '{"kimi":"/fake/kimi"}' }),
    '/fake/kimi',
  );
  assert.equal(
    quirks.findBin('goose', () => '/usr/local/bin/goose', { SAGE_ACP_BINS: '{"kimi":"/fake/kimi"}' }),
    null,
  );
  assert.equal(
    quirks.findBin('goose', (b: string) => (b === 'goose' ? '/bin/goose' : null), {}),
    '/bin/goose',
  );
});

test('admitted: initialize, then session/new with sage-mcp, and its hello arrives', { skip, timeout: 60_000 }, async () => {
  const f = fake('ok', {});
  const r = await probe('ok', opts(f));
  assert.equal(r.state, 'admitted', r.reason);
  assert.equal(r.version, '0.0.0-fake');
});

test('not admitted: no handshake from sage-mcp', { skip, timeout: 60_000 }, async () => {
  const f = fake('nomcp', { noMcp: true });
  const r = await probe('nomcp', opts(f));
  assert.equal(r.state, 'unsupported');
  assert.equal(r.reason, "MoPilot can't give Fake nomcp computer and browser control");
});

test('not admitted: another ACP version', { skip, timeout: 60_000 }, async () => {
  const r = await probe('v2', opts(fake('v2', { protocolVersion: 2 })));
  assert.equal(r.state, 'unsupported');
  assert.match(r.reason, /speaks ACP v2; MoPilot needs v1/);
});

test('not admitted: missing quirks fields, or a privacy check that fails (before anything starts)', { skip, timeout: 60_000 }, async () => {
  const bad = fake('bad', {}, { privacyDefaults: undefined });
  assert.match((await probe('bad', opts(bad))).reason, /no settings for it yet \(privacyDefaults\)/);
  let started = false;
  const gated = fake(
    'gated',
    {},
    {
      admission: {
        handshakeTimeoutMs: 10_000,
        privacyGate: async () => ({ ok: false, reason: "This version can't turn off session log upload" }),
      },
    },
  );
  const r = await probe('gated', { ...opts(gated), spawnFn: () => ((started = true), null) });
  assert.equal(r.state, 'unsupported');
  assert.equal(r.reason, "This version can't turn off session log upload");
  assert.equal(started, false);
});

test('signed out: session/new wants a login; authMethods come along', { skip, timeout: 60_000 }, async () => {
  const methods = [{ id: 'login', name: 'Log in with the browser' }];
  const f = fake('auth', { needsAuth: true, authMethods: methods });
  const r = await probe('auth', opts(f));
  assert.equal(r.state, 'signin');
  assert.deepEqual(r.authMethods, methods);
  // once signed in it is admitted
  fs.mkdirSync(f.state, { recursive: true });
  fs.writeFileSync(path.join(f.state, 'authed'), '');
  assert.equal((await probe('auth', opts(f))).state, 'admitted');
  assert.ok(isAuthError({ code: -32000, message: 'x' }));
});

test('Admission: missing, cached per binary, probed again when the binary changes', { skip, timeout: 60_000 }, async () => {
  const f = fake('cached', {});
  let probes = 0;
  const a = new Admission({
    ...opts(f),
    ids: ['cached', 'gone'],
    resolveBin: (id: string) => (id === 'cached' ? f.bin : null),
    quirks: (id: string) => (id === 'cached' ? f.q : null),
    file: path.join(dir, 'admission.json'),
    spawnFn: (...args: any[]) => (probes++, require('node:child_process').spawn(...args)),
  });
  assert.deepEqual(
    a.list().map((h: any) => [h.id, h.state]),
    [
      ['cached', 'checking'],
      ['gone', 'missing'],
    ],
  );
  await a.refresh();
  assert.equal(a.admitted('cached'), true);
  assert.equal(probes, 1);
  await a.refresh();
  assert.equal(probes, 1);
  // a new process reads the cache
  const b = new Admission({ ...opts(f), ids: ['cached'], file: path.join(dir, 'admission.json') });
  assert.equal(b.list()[0].state, 'admitted');
  // an update to the binary makes it stale
  fs.utimesSync(f.bin, new Date(), new Date(Date.now() + 5000));
  assert.equal(b.list()[0].state, 'checking');
});
