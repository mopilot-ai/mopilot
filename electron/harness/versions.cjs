// Versions policy (WP5-20, design F07): a first-tier CLI above versions.min and not in knownBad works as
// usual, untested or not. What a newer CLI may have changed is found by runtime probes, each tied to
// the capabilities it backs, so only a capability whose probe failed is greyed out. Below min or known
// bad, the harness is incompatible: its entry says so and offers to choose another CLI.
// Keep VERSIONS in step with src/harness/registry.ts (tests/versions.test.ts checks it).

const { noteIgnored } = require('../ignored.cjs');
const { compareVersions } = require('../../shared/semver.mjs');

const VERSIONS = {
  codex: { min: '0.162.0-alpha.17.2', knownBad: [], tested: ['0.162.0-alpha.17.2'] },
  claude: { min: '2.1.295', knownBad: [], tested: ['2.1.295', '2.1.296'] },
};

/**
 * Installed copies of a CLI in the order a default picks from: the newest release first, then the newest prerelease
 * (picked only when no release is installed: an alpha bundled with an app is not newer than the release it leads to),
 * then copies whose version could not be read. Given the harness kind, a copy this app can't work with (below min or
 * known bad) goes last: a too-old release on PATH must not win over a working copy bundled with an app (#3518).
 * @template {{ version?: string | null }} T
 * @param {T[]} list
 * @param {string} [kind] the harness kind whose versions policy applies
 * @returns {T[]}
 */
function preferredInstalls(list, kind) {
  // a prerelease has a "-" before any "+build" part
  const rank = (v) => (kind && incompatible(versionStatus(kind, v)) ? 3 : !v ? 2 : /^[^+]*-/.test(String(v).trim()) ? 1 : 0);
  return [...list].sort((a, b) => rank(a.version) - rank(b.version) || compareVersions(b.version, a.version));
}

/** Accept the partial numeric versions some CLIs print as well as full SemVer. */
const READABLE_VERSION = /^v?(\d+\.\d+)(\.\d+)?(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * The opt-in order compares releases and prereleases together. Copies with no readable version retain discovery
 * order behind known versions and ahead of copies that MoPilot knows are incompatible.
 * @template {{ version?: string | null }} T
 * @param {T[]} list
 * @param {string} kind
 * @param {readonly string[]} [blockedVersions] versions a native ACP harness's descriptor blocks
 * @returns {T[]}
 */
function highestInstalls(list, kind, blockedVersions = []) {
  const ranked = list.map((copy) => {
    const match = READABLE_VERSION.exec(copy.version?.trim() ?? '');
    if (!match) return { copy, version: null, rank: 1 };
    const version = `${match[1]}${match[2] ?? '.0'}${match[3] ?? ''}`;
    const blocked = incompatible(versionStatus(kind, version)) || blockedVersions.some((v) => compareVersions(v, version) === 0);
    return { copy, version, rank: blocked ? 2 : 0 };
  });
  return ranked.sort((a, b) => a.rank - b.rank || compareVersions(b.version, a.version)).map(({ copy }) => copy);
}

/** 'ok' (tested), 'unverified' (newer, untested: works as usual), 'tooOld' or 'knownBad' (incompatible); null when unknown. */
function versionStatus(kind, version) {
  const v = VERSIONS[kind];
  if (!v || !version) return null;
  if (v.knownBad.some((b) => compareVersions(b, version) === 0)) return 'knownBad';
  if (compareVersions(version, v.min) < 0) return 'tooOld';
  return v.tested.some((t) => compareVersions(t, version) === 0) ? 'ok' : 'unverified';
}
const incompatible = (status) => status === 'knownBad' || status === 'tooOld';

/** Codex has no version field: it is in initialize's userAgent, "<client>/<version> (<os>) …" (X1). */
function codexVersion(userAgent) {
  const m = /^[^/\s]+\/(\d[^\s]*)/.exec(String(userAgent ?? ''));
  return m ? m[1] : null;
}

const ZERO = '00000000-0000-0000-0000-000000000000';
const messageOf = (e) => String(e?.message ?? e);
/**
 * Codex runtime probes: [method, params, check?]. Most ask for a method with a thread that doesn't
 * exist, so nothing runs; an "unknown variant" error means this app-server doesn't have the method.
 * `check` ({ ok(result), err(error) }) judges the probes that need more than "the method is there":
 * - threadProvider (X9): thread/start names a provider that isn't defined. A server that takes
 *   thread-level providers refuses it ("Model provider `x` not found"); one that ignores the field
 *   starts a thread, which is closed again, and counts as failed.
 * - pluginsOff (X12): plugin/installed still has the shape the per-thread plugins switch (which turns
 *   cua_repl off) is written against: marketplaces of plugins, each with an enabled flag.
 * @type {Record<string, [method: string, params: object, check?: { ok: (result: any) => boolean, err: (error: any) => boolean }]>}
 */
const CODEX_PROBES = {
  'codex.goals': ['thread/goal/get', { threadId: ZERO }],
  'codex.collaborationModes': ['collaborationMode/list', {}],
  // a read only: it never turns the link on
  'codex.remoteControl': ['remoteControl/status/read', {}],
  'codex.backgroundTerminals': ['thread/backgroundTerminals/list', { threadId: ZERO }],
  'codex.review': ['review/start', { threadId: ZERO, target: { type: 'uncommittedChanges' }, delivery: 'inline' }],
  'codex.compact': ['thread/compact/start', { threadId: ZERO }],
  'codex.experimentalFeatures': ['experimentalFeature/list', {}],
  'codex.threadProvider': [
    'thread/start',
    { cwd: require('node:os').tmpdir(), ephemeral: true, modelProvider: 'sage_probe_undefined' },
    { ok: () => false, err: (e) => !methodMissing(e) && !/unknown (field|variant)|unrecognized|invalid type/i.test(messageOf(e)) },
  ],
  'codex.pluginsOff': [
    'plugin/installed',
    {},
    {
      ok: (r) =>
        Array.isArray(r?.marketplaces) &&
        r.marketplaces.every((m) => Array.isArray(m?.plugins) && m.plugins.every((p) => typeof p?.enabled === 'boolean')),
      err: (e) => !methodMissing(e),
    },
  ],
};
const methodMissing = (e) => /unknown variant|method not found|-32601/i.test(messageOf(e)) || e?.code === -32601;

/**
 * Run the probes with `request` (method, params) => Promise. Resolves { probes, flags }: whether each
 * method is there, and the harness's own feature flags (features.goals from experimentalFeature/list).
 */
async function probeCodex(request) {
  const probes = {};
  const flags = {};
  await Promise.all(
    Object.entries(CODEX_PROBES).map(async ([id, [method, params, check]]) => {
      try {
        const r = await request(method, params);
        probes[id] = check ? check.ok(r) : true;
        if (id === 'codex.experimentalFeatures') for (const f of r?.data ?? []) if (f?.name) flags[`features.${f.name}`] = !!f.enabled;
        // a thread the probe started by accident isn't left loaded
        if (id === 'codex.threadProvider' && r?.thread?.id)
          // a failure only leaves the probe thread loaded
          request('thread/unsubscribe', { threadId: r.thread.id }).catch((error) => noteIgnored('release the probe thread', error));
      } catch (e) {
        probes[id] = check ? check.err(e) : !methodMissing(e);
        if (/goals feature is disabled/i.test(messageOf(e))) flags['features.goals'] = false;
      }
    }),
  );
  return { probes, flags };
}

/**
 * Claude runtime probes, read from a live session (electron/harness/claude/index.cjs readSettings): `s` is
 * { probe: 'ok'|'missing'|'failed', perTaskStop, origin }. A probe the session couldn't answer is left
 * out, and a probe nobody answered blocks nothing.
 * - getSettings (C6): the query has getSettings and it answers.
 * - perTaskStopAffordance (C8): the query has stopTask, which perTaskStopAffordance:true keeps a
 *   sub-agent alive for after an interrupt.
 * - origin (C5): getSettings reports ultracodeRequested, the CLI side of origin {kind:"human"}.
 */
function claudeProbes(s) {
  if (!s) return {};
  const out = { 'claude.getSettings': s.probe === 'ok' };
  if (typeof s.perTaskStop === 'boolean') out['claude.perTaskStopAffordance'] = s.perTaskStop;
  if (typeof s.origin === 'boolean') out['claude.origin'] = s.origin;
  if (typeof s.pluginDirs === 'boolean') out['claude.pluginDirs'] = s.pluginDirs;
  return out;
}

module.exports = {
  claudeProbes,
  VERSIONS,
  compareVersions,
  preferredInstalls,
  highestInstalls,
  versionStatus,
  incompatible,
  codexVersion,
  CODEX_PROBES,
  probeCodex,
  methodMissing,
};
