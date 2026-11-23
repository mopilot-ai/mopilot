// The small harness helpers in main, on their less travelled paths: binary detection
// (electron/harness/detect.cjs), the versions policy and Codex probes (versions.cjs), the ACP turn
// start (acpTurns.cjs) and the semantic bindings (bindings.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { detectBin, resolveBasic } = require('../electron/harness/detect.cjs');
const versions = require('../electron/harness/versions.cjs');
const { AcpTurns, acpBlocks } = require('../electron/harness/acpTurns.cjs');
const { codexBindings, acpBindings } = require('../electron/harness/bindings.cjs');

/* -- detect --------------------------------------------------------- */
test('detectBin with no names, no PATH lookup or nothing found in the known folders finds nothing', () => {
  assert.equal(detectBin({}), null);
  assert.equal(detectBin({ names: ['x'] }), null);
  assert.equal(detectBin({ known: ['/k'], exists: () => true }), null);
  assert.equal(detectBin({ names: ['x', 'y'], known: ['/a', '/b'], exists: () => false }), null);
  // the real file system is the default check
  const here = path.basename(process.execPath);
  assert.deepEqual(detectBin({ names: [here], known: [path.dirname(process.execPath)] }), { path: process.execPath, source: 'known' });
});

test('resolveBasic: the real file system and process env by default; unknown harnesses and empty searches give null', () => {
  const saved = process.env.SAGE_ACP_BINS;
  delete process.env.SAGE_ACP_BINS;
  try {
    assert.equal(resolveBasic('kimi', { manual: process.execPath }), process.execPath);
    assert.equal(resolveBasic('no-such-harness', { which: () => '/x' }), null);
    assert.equal(resolveBasic('kimi', { which: () => null, known: [] }), null);
    assert.equal(resolveBasic('kimi', { which: (n: string) => `/bin/${n}` }), '/bin/kimi');
    assert.equal(resolveBasic('no-such-harness'), null);
  } finally {
    if (saved !== undefined) process.env.SAGE_ACP_BINS = saved;
  }
  assert.equal(resolveBasic('kimi', { manual: '/gone', exists: () => false, env: { SAGE_ACP_BINS: '{"kimi":"/fake"}' } }), '/fake');
});

/* -- versions ------------------------------------------------------- */
test('compareVersions: missing parts count as zero; prereleases compare part by part', () => {
  const { compareVersions: c } = versions;
  assert.equal(c('1.2', '1.2.0'), 0);
  assert.equal(c('1.2', '1.2.1'), -1);
  assert.equal(c('1.3.0', '1.2'), 1);
  assert.equal(c('1.2.1', '1.2'), 1);
  assert.equal(c('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(c('1.0.0-alpha.1', '1.0.0-alpha'), 1);
  assert.equal(c('1.0.0-1', '1.0.0-beta'), -1);
  assert.equal(c('1.0.0-beta', '1.0.0-1'), 1);
  assert.equal(c('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(c('1.0.0-beta', '1.0.0-alpha'), 1);
  assert.equal(c('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(c('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(c('v1.0.0-rc.1', '1.0.0-rc.1'), 0);
  assert.equal(c('1.0.0', '1.0.0-rc'), 1);
});

test('versionStatus: unknown kinds and versions, known-bad builds; incompatible covers both refusals', () => {
  assert.equal(versions.versionStatus('nope', '1.0.0'), null);
  assert.equal(versions.versionStatus('codex', null), null);
  const bad = versions.VERSIONS.claude.knownBad;
  bad.push('9.9.9');
  try {
    assert.equal(versions.versionStatus('claude', '9.9.9'), 'knownBad');
    assert.equal(versions.versionStatus('claude', '9.9.10'), 'unverified');
  } finally {
    bad.pop();
  }
  assert.equal(versions.versionStatus('claude', '1.0.0'), 'tooOld');
  assert.equal(versions.incompatible('knownBad'), true);
  assert.equal(versions.incompatible('tooOld'), true);
  assert.equal(versions.incompatible('ok'), false);
  assert.equal(versions.codexVersion(undefined), null);
});

test('probeCodex: features without names are skipped, a list with no data is fine, non-Error failures are read as text', async () => {
  const r1 = await versions.probeCodex(async (method: string) => {
    if (method === 'experimentalFeature/list') return {};
    if (method === 'thread/goal/get') throw null;
    if (method === 'plugin/installed') return { marketplaces: [{ plugins: [{ enabled: true }] }] };
    return {};
  });
  assert.equal(r1.probes['codex.experimentalFeatures'], true);
  assert.deepEqual(r1.flags, {});
  assert.equal(r1.probes['codex.goals'], true);
  assert.equal(r1.probes['codex.pluginsOff'], true);
  const r2 = await versions.probeCodex(async (method: string) => {
    if (method === 'experimentalFeature/list') return { data: [null, { enabled: true }, { name: 'goals', enabled: 0 }] };
    return null;
  });
  assert.deepEqual(r2.flags, { 'features.goals': false });
  assert.equal(r2.probes['codex.pluginsOff'], false);
  assert.equal(versions.methodMissing({ code: -32601, message: 'x' }), true);
  assert.equal(versions.methodMissing(undefined), false);
});

/* -- acpTurns ------------------------------------------------------- */
test('acpBlocks: a selection without text, an image read that fails, no attachments to speak of', async () => {
  const blocks = await acpBlocks(
    'hi',
    [{ kind: 'selection' }, { kind: 'image', path: '/p' }, { kind: 'image', path: '/q' }],
    async (p: string) => (p === '/p' ? 'not a data url' : null),
  );
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /<selected-text>\n\[""\]\n<\/selected-text>/);
  assert.deepEqual(await acpBlocks('  ', [], async () => null), []);
});

test('AcpTurns: defaults, a session folder that is not absolute, an item with nothing in it, a non-Error failure', async () => {
  const sent: any[] = [];
  const t = new AcpTurns({
    send: async (...a: any[]) => sent.push(a),
    rename: () => assert.fail('no title for an empty prompt'),
    readImage: async () => null,
  });
  assert.equal(t.emit({}), false);
  assert.equal(t.named('k'), false);
  assert.ok(path.isAbsolute(t.home));
  assert.equal(t.registerSession(''), false);
  assert.equal(t.registerSession(42 as any), false);
  assert.equal(t.registerSession('acp:kimi:1'), true);
  assert.deepEqual(t.sessions.get('acp:kimi:1'), { cwd: null });
  t.registerSession('acp:kimi:2', { cwd: 'relative/dir' });
  assert.deepEqual(t.sessions.get('acp:kimi:2'), { cwd: null });
  const r = await t.startTurn('acp:kimi:1', { key: 'acp:kimi:1' }, { attachments: 'nope' });
  // a started turn names its turn and the prompt's item
  assert.deepEqual([r.started, /^at-/.test(r.turnId), /^u-/.test(r.itemId)], [true, true, true]);
  assert.equal(sent[0][2].cwd, t.home);
  assert.deepEqual(sent[0][2].blocks, []);
  assert.equal(sent[0][3].human, false);

  const events: any[] = [];
  const failing = new AcpTurns({
    send: async () => {
      throw 'refused';
    },
    rename() {},
    readImage: async () => null,
    emit: (e: any, to: any) => events.push([e, to]),
  });
  assert.deepEqual(await failing.startTurn('c', { key: 'c' }, { text: 'x' }, 'win'), { started: false, error: 'refused' });
  assert.deepEqual(events.at(-1), [
    { kind: 'turnFailed', key: 'c', chatId: 'c', clientId: events[0][0].clientId, error: 'refused' },
    'win',
  ]);
  const nullish = new AcpTurns({
    send: async () => {
      throw undefined;
    },
    rename() {},
    readImage: async () => null,
    emit: (e: any) => events.push([e]),
  });
  await nullish.startTurn('c', { key: 'c' }, { text: 'x' });
  assert.equal(events.at(-1)[0].error, 'undefined');
});

/* -- bindings ------------------------------------------------------- */
test('codexBindings: voice chat is off when the harness says realtime voice is', () => {
  assert.equal(codexBindings({ ext: { realtimeVoice: false } }).voiceChat.via, 'none');
  assert.equal(codexBindings({ ext: {} }).voiceChat.via, 'rpc');
  assert.equal(codexBindings(undefined).voiceChat.via, 'rpc');
});

test('acpBindings: command names or objects, compact or compress, plan by mode or option, permission modes, model and thought level', () => {
  const b = acpBindings({
    commands: ['goal', { name: '/review' }, 'compress', 'init'],
    configOptions: [{ category: 'model' }, { category: 'thought_level' }],
    modes: { availableModes: [{ id: 'a' }, { id: 'b' }] },
    plan: { configOption: 'mode', value: 'plan' },
    agentModes: ['a'],
  });
  assert.deepEqual(b.goal, { via: 'passthrough', template: '/goal {args}' });
  assert.deepEqual(b.review, { via: 'passthrough', template: '/review {args}' });
  assert.deepEqual(b.compact, { via: 'passthrough', template: '/compress {args}' });
  assert.deepEqual(b.init, { via: 'passthrough', template: '/init' });
  assert.deepEqual(b.plan, { via: 'config', option: 'mode', value: 'plan' });
  assert.deepEqual(b.permissions, { via: 'config', option: 'mode', value: true });
  assert.deepEqual(b.model, { via: 'config', option: 'model', value: true });
  assert.deepEqual(b.effort, { via: 'config', option: 'thought_level', value: true });
  const c = acpBindings({ commands: ['compact', 'compress'], plan: { mode: 'plan' }, modes: {} });
  assert.deepEqual(c.compact, { via: 'passthrough', template: '/compact {args}' });
  assert.deepEqual(c.plan, { via: 'config', option: 'mode', value: 'plan' });
  assert.equal(c.permissions.via, 'none');
  // only the agent's own modes: no permission modes (#1875)
  const own = { modes: { availableModes: [{ id: 'build' }, { id: 'plan' }] } };
  assert.equal(acpBindings({ ...own, agentModes: ['build', 'plan'] }).permissions.via, 'none');
  assert.equal(acpBindings({ ...own, agentModes: ['build'] }).permissions.via, 'config');
  assert.equal(acpBindings({ ...own, agentModes: 'build' }).permissions.via, 'config');
  const d = acpBindings(null);
  for (const s of ['goal', 'review', 'compact', 'init', 'plan', 'permissions', 'model', 'effort']) assert.equal(d[s].via, 'none', s);
});
