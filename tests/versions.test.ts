// The versions policy (electron/harness/versions.cjs, src/harness/codexCompat.ts, WP5-20, A24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  VERSIONS,
  compareVersions,
  preferredInstalls,
  highestInstalls,
  versionStatus,
  codexVersion,
  probeCodex,
  CODEX_PROBES,
} = require('../electron/harness/versions.cjs');
const { REGISTRY } = await import('../src/harness/registry.ts');
const { codexBlocked, codexIncompatible, incompatibleText } = await import('../src/harness/codexCompat.ts');

test('versions compare as semver, a prerelease below its release', () => {
  assert.equal(compareVersions('0.162.0-alpha.17.2', '0.162.0'), -1);
  assert.equal(compareVersions('0.162.0-alpha.17.2', '0.162.0-alpha.9'), 1);
  assert.equal(compareVersions('0.163.0', '0.162.9'), 1);
  assert.equal(compareVersions('2.1.295', '2.1.295'), 0);
  assert.equal(compareVersions('v2.2.0', '2.1.300'), 1);
});

test('installed copies in the order a default picks from: releases newest first, then prereleases, then unknown versions', () => {
  const order = preferredInstalls([
    { path: 'unknown', version: null },
    { path: 'alpha', version: '0.163.0-alpha.10.2' },
    { path: 'old', version: '0.150.0' },
    { path: 'alpha9', version: '0.163.0-alpha.9' },
    { path: 'release', version: '0.162.0' },
    { path: 'build', version: '0.161.0+build-7' },
  ]);
  assert.deepEqual(
    order.map((c: any) => c.path),
    ['release', 'build', 'old', 'alpha', 'alpha9', 'unknown'],
  );
});

test('given the kind, a copy below min or known bad goes after every working copy, an app-bundled alpha included (#3518)', () => {
  const list = [
    { path: '/opt/homebrew/bin/codex', version: '0.147.0' },
    { path: '/Applications/ChatGPT.app/codex', version: '0.166.0-alpha.5.1' },
    { path: 'unknown', version: null },
  ];
  assert.deepEqual(
    preferredInstalls(list, 'codex').map((c: any) => c.path),
    ['/Applications/ChatGPT.app/codex', 'unknown', '/opt/homebrew/bin/codex'],
  );
  // without the kind, the order stays release-first
  assert.equal(preferredInstalls(list)[0].path, '/opt/homebrew/bin/codex');
  // only incompatible copies: still the newest of them, so the page can say why
  assert.deepEqual(
    preferredInstalls(
      [
        { path: 'a', version: '0.140.0' },
        { path: 'b', version: '0.147.0' },
      ],
      'claude-x',
    ).map((c: any) => c.path),
    ['b', 'a'],
  );
  assert.deepEqual(
    preferredInstalls(
      [
        { path: 'a', version: '2.1.1' },
        { path: 'b', version: '2.1.2' },
      ],
      'claude',
    ).map((c: any) => c.path),
    ['b', 'a'],
  );
});

test('above min and not known bad works, tested or not; below min or known bad is incompatible', () => {
  assert.equal(versionStatus('codex', '0.162.0-alpha.17.2'), 'ok');
  assert.equal(versionStatus('codex', '0.170.0'), 'unverified');
  assert.equal(versionStatus('codex', '0.150.0'), 'tooOld');
  assert.equal(versionStatus('codex', null), null);
  // main's table and the registry the windows read agree
  for (const kind of ['codex', 'claude']) assert.deepEqual(VERSIONS[kind], REGISTRY[kind].versions);
});

test('opt-in CLI ordering uses numeric SemVer, skips known incompatibility when possible, and keeps stable ties', () => {
  const versions = (list: (string | null)[], kind: string, blocked?: string[]) =>
    highestInstalls(
      list.map((version) => ({ version })),
      kind,
      blocked,
    ).map((c: { version: string | null }) => c.version);
  const versionsFound = ['not-a-version', '0.163.0', '0.165.0-rc.2', null, '0.100.0', '0.165.0-rc.10', '0.165.0-rc.10+ignored'];
  assert.deepEqual(versions(versionsFound, 'codex'), [
    '0.165.0-rc.10',
    '0.165.0-rc.10+ignored',
    '0.165.0-rc.2',
    '0.163.0',
    'not-a-version',
    null,
    '0.100.0',
  ]);
  assert.deepEqual(versions(['2.1.1', '2.1.2'], 'claude'), ['2.1.2', '2.1.1']);
  assert.deepEqual(versions(['v10.4+build', '10.4.0-beta.1', '9.20.2'], 'acp:fake', ['10.4.0']), [
    '10.4.0-beta.1',
    '9.20.2',
    'v10.4+build',
  ]);
  assert.deepEqual(versions(['9007199254740992.2', '9007199254740993.2.0+build'], 'acp:fake'), [
    '9007199254740993.2.0+build',
    '9007199254740992.2',
  ]);
});

test("Codex's version comes from initialize's userAgent", () => {
  assert.equal(codexVersion('sage_codex_desktop/0.162.0-alpha.17.2 (Mac OS 27.0.1; arm64) Apple_Terminal'), '0.162.0-alpha.17.2');
  assert.equal(codexVersion('fake-codex/0.170.0'), '0.170.0');
  assert.equal(codexVersion(undefined), null);
});

test('probes: a method that answers "unknown variant" is missing; other errors mean it is there', async () => {
  const r = await probeCodex(async (method: string) => {
    if (method === 'collaborationMode/list')
      throw Object.assign(new Error('Invalid request: unknown variant `collaborationMode/list`'), { code: -32600 });
    if (method === 'thread/goal/get') throw Object.assign(new Error('goals feature is disabled'), { code: -32600 });
    if (method === 'experimentalFeature/list')
      return {
        data: [
          { name: 'goals', enabled: false },
          { name: 'memories', enabled: true },
        ],
      };
    throw new Error('thread not found');
  });
  assert.equal(Object.keys(r.probes).length, Object.keys(CODEX_PROBES).length);
  assert.equal(r.probes['codex.collaborationModes'], false);
  assert.equal(r.probes['codex.goals'], true);
  assert.equal(r.probes['codex.remoteControl'], true);
  assert.equal(r.probes['codex.review'], true);
  assert.equal(r.flags['features.goals'], false);
  assert.equal(r.flags['features.memories'], true);
});

test('only the capability whose probe failed is greyed out, with why', () => {
  const n = {
    cliVersion: '0.170.0',
    versionStatus: 'unverified' as const,
    probes: { 'codex.collaborationModes': false, 'codex.goals': true },
    flags: {},
  };
  assert.equal(codexBlocked(n, 'plan'), 'Codex 0.170.0 changed how plan mode works · Update MoPilot');
  assert.equal(codexBlocked(n, 'goal'), null);
  assert.equal(codexBlocked(n, 'review'), null);
  // a goals feature turned off says so
  assert.equal(codexBlocked({ ...n, flags: { 'features.goals': false } }, 'goal'), 'Goals are off in Codex · Turn on goals');
  // probes that never ran block nothing
  assert.equal(codexBlocked({ ...n, probes: {} }, 'plan'), null);
  assert.equal(codexIncompatible(n), false);
  const old = { ...n, cliVersion: '0.150.0', versionStatus: 'tooOld' as const };
  assert.equal(codexIncompatible(old), true);
  assert.match(incompatibleText(old), /^Codex 0\.150\.0 doesn't work with this version of MoPilot/);
});

// WP5-20: the probes added from X9, X12 and C5, C8.
const { claudeProbes } = require('../electron/harness/versions.cjs');
const { computeCaps, negotiated } = require('../electron/session/caps.cjs');
const rpcError = (m: string) => Object.assign(new Error(m), { code: -32600 });

test('thread Provider probe: refused for an undefined provider is a pass; a server that ignores the field fails and closes its thread', async () => {
  const sent: string[] = [];
  const run = (start: () => any) =>
    probeCodex(async (method: string, params: any) => {
      sent.push(method);
      if (method === 'thread/start') {
        assert.equal(params.ephemeral, true);
        assert.equal(params.modelProvider, 'sage_probe_undefined');
        return start();
      }
      throw new Error('thread not found');
    });
  assert.equal(
    (
      await run(() => {
        throw rpcError('failed to load configuration: Model provider `sage_probe_undefined` not found');
      })
    ).probes['codex.threadProvider'],
    true,
  );
  assert.equal(
    (
      await run(() => {
        throw rpcError('Invalid request: unknown field `modelProvider`');
      })
    ).probes['codex.threadProvider'],
    false,
  );
  assert.equal(
    (
      await run(() => {
        throw rpcError('Invalid request: unknown variant `thread/start`');
      })
    ).probes['codex.threadProvider'],
    false,
  );
  sent.length = 0;
  assert.equal((await run(() => ({ thread: { id: 'oops' }, modelProvider: 'openai' }))).probes['codex.threadProvider'], false);
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.includes('thread/unsubscribe'));
});

test('plugins probe: the plugin list keeps the shape the per-thread switch is written against', async () => {
  const run = (r: () => any) =>
    probeCodex(async (method: string) => {
      if (method === 'plugin/installed') return r();
      throw new Error('thread not found');
    });
  const ok = {
    marketplaces: [{ name: 'openai-bundled', plugins: [{ id: 'unified-computer-use@openai-bundled', enabled: true }] }],
    marketplaceLoadErrors: [],
  };
  assert.equal((await run(() => ok)).probes['codex.pluginsOff'], true);
  assert.equal((await run(() => ({ marketplaces: [], marketplaceLoadErrors: [] }))).probes['codex.pluginsOff'], true);
  assert.equal((await run(() => ({ plugins: [] }))).probes['codex.pluginsOff'], false);
  assert.equal((await run(() => ({ marketplaces: [{ plugins: [{ id: 'x' }] }] }))).probes['codex.pluginsOff'], false);
  assert.equal(
    (
      await run(() => {
        throw rpcError('Invalid request: unknown variant `plugin/installed`');
      })
    ).probes['codex.pluginsOff'],
    false,
  );
});

test('a failed Codex provider or plugins probe greys only model choice or computer control, with its why', () => {
  const n = {
    cliVersion: '0.170.0',
    versionStatus: 'unverified' as const,
    probes: { 'codex.threadProvider': false, 'codex.pluginsOff': true, 'codex.goals': true },
    flags: {},
  };
  assert.equal(codexBlocked(n, 'model'), 'Codex 0.170.0 changed how model choice works · Update MoPilot');
  assert.equal(codexBlocked(n, 'computerUse'), null);
  assert.equal(codexBlocked(n, 'goal'), null);
  const m = { ...n, probes: { 'codex.threadProvider': true, 'codex.pluginsOff': false } };
  assert.equal(codexBlocked(m, 'computerUse'), 'Codex 0.170.0 changed how computer control works · Update MoPilot');
  assert.equal(codexBlocked(m, 'model'), null);
});

test('Claude probes come from the live session; one the session did not answer is left out', () => {
  assert.deepEqual(claudeProbes(null), {});
  assert.deepEqual(claudeProbes({ probe: 'ok', perTaskStop: true, origin: true }), {
    'claude.getSettings': true,
    'claude.perTaskStopAffordance': true,
    'claude.origin': true,
  });
  // getSettings missing: origin can't be read, but stopTask can
  assert.deepEqual(claudeProbes({ probe: 'missing', perTaskStop: false }), {
    'claude.getSettings': false,
    'claude.perTaskStopAffordance': false,
  });
});

test('a failed Claude probe greys only its own capability, through the session caps', () => {
  const caps = (s: any) =>
    computeCaps({
      kind: 'claude',
      negotiated: negotiated('claude', { version: '2.1.400', probes: claudeProbes(s) }),
      provider: null,
      model: null,
      account: null,
      flags: {},
      session: null,
    });
  const healthy = caps({ probe: 'ok', perTaskStop: true, origin: true });
  assert.equal(healthy.tasks.why?.layer === 'version', false);
  const noStop = caps({ probe: 'ok', perTaskStop: false, origin: true });
  assert.deepEqual(noStop.tasks.why, { layer: 'version', code: 'version.probeFailed', fix: 'upgrade' });
  assert.equal(noStop.deepReasoning.why?.layer === 'version', false);
  assert.equal(noStop.multiAgent.why?.layer === 'version', false);
  const noOrigin = caps({ probe: 'ok', perTaskStop: true, origin: false });
  assert.deepEqual(noOrigin.deepReasoning.why, { layer: 'version', code: 'version.probeFailed', fix: 'upgrade' });
  assert.equal(noOrigin.tasks.why?.layer === 'version', false);
  // a session that hasn't answered yet blocks nothing
  const unknown = caps(null);
  assert.equal(unknown.tasks.why?.layer === 'version', false);
});
