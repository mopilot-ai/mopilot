// Bug reports (/bug, /feedback, Help → Report a Bug…, Settings → About): Copy diagnostics' text, the chat's transcript and
// the user's words, scrubbed and bounded to what MoPilot's bug intake takes. The window saves one to a file; a build with
// the MoPilot service sends it there too (electron/private/service/bugIntake.cjs).
'use strict';
const os = require('node:os');
const { installId } = require('../platform/install.cjs');
const { scrub } = require('../../shared/scrub.cjs');
const { prefixUnits, suffixUnits } = require('../../shared/textPrefix.mjs');
const { noteIgnored, recentIgnored, messageOf } = require('../ignored.cjs');
const { recentWindowProblems } = require('../platform/windowRecovery.cjs');
const { fingerprint, osName } = require('./telemetry.cjs');

const KINDS = new Set(['bug', 'bad_result', 'other']);
/** the server's limit on the body, compressed and once unpacked (web/app/api/bug) */
const MAX_BODY = 4 * 1024 * 1024;
/** longest transcript and diagnostics kept, in UTF-16 units: the middle is cut first */
const MAX_TRANSCRIPT = 1_500_000;
const MAX_DIAGNOSTICS = 1_000_000;
const MAX_DESCRIPTION = 20_000;
/** harness, model and the like */
const MAX_FIELD = 200;
const MAX_FINGERPRINTS = 50;
/** a text this short is never cut further to fit the body */
const MIN_CUT = 1000;

/** The text cut to about `max` units, keeping its start and most of its end, with a line saying how much was cut. */
function capMiddle(text, max) {
  if (text.length <= max) return text;
  const head = prefixUnits(text, Math.floor(max / 4));
  const tail = suffixUnits(text, max - head.length);
  return `${head}\n\n[… ${text.length - head.length - tail.length} characters cut …]\n\n${tail}`;
}

/**
 * What main hands the report (its IPC deps, electron/main.cjs IpcDeps): only the pieces read here.
 * @typedef {{ app: { getVersion: () => string, getPath: (name: 'userData') => string },
 *   claude: { turnApi: { detect: (bin?: string) => Promise<{ bin?: string | null } | null> } },
 *   readState: () => { prefs?: { claudeBin?: string | null } }, findCodexBinary: () => Promise<string | null>,
 *   shellEnv: { status: () => { captured: boolean, error: string | null }, childEnv: () => Record<string, string | undefined> },
 *   live: { capabilityHealth?: { snapshot: () => object } | null, nativeAvailability?: { snapshot: () => object } | null,
 *     ledger?: { store: { lastDay: () => Promise<string[]> } } | null,
 *     telemetry: { reportContext: () => Promise<{ channel: string, versions: unknown, fingerprints: string[] }>, consent: unknown },
 *     mopilot: { status: () => { signedIn?: boolean } } } }} ReportDeps
 */

/**
 * What Copy diagnostics copies (Settings → About) and a bug report carries: one collector for both.
 * @param {Pick<ReportDeps, 'app' | 'claude' | 'readState' | 'findCodexBinary' | 'shellEnv' | 'live'>} deps
 */
async function collectDiagnostics({ app, claude, readState, findCodexBinary, shellEnv, live }) {
  const { buildDiagnostics } = require('./diagnostics.cjs');
  // a failed lookup reads as "not found" here and its error is listed with the ignored ones below
  const d = await claude.turnApi.detect(readState().prefs?.claudeBin ?? undefined).catch((error) => {
    noteIgnored('find Claude Code for the diagnostics', error);
    return null;
  });
  return buildDiagnostics({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    harnesses: { Codex: await findCodexBinary(), 'Claude Code': d?.bin ?? null },
    envStatus: shellEnv.status(),
    env: shellEnv.childEnv(),
    home: os.homedir(),
    ignored: recentIgnored(),
    capabilityHealth: live.capabilityHealth?.snapshot(),
    nativeAvailability: live.nativeAvailability?.snapshot(),
    // a window that went blank or hung, whatever the usage-data choice (platform/windowRecovery.cjs)
    windowProblems: recentWindowProblems(),
    // the last day's request log, none before main opened the ledger (app/sessions.cjs)
    ledger: live?.ledger ? await live.ledger.store.lastDay() : [],
  });
}

/**
 * Main's part of a report, read when it is previewed and again when it is sent: nothing of it comes from the window.
 * @param {ReportDeps} deps
 */
async function reportContext(deps) {
  const { app, shellEnv, live } = deps;
  const [diagnostics, t] = await Promise.all([
    collectDiagnostics(deps).catch((error) => {
      // the report still goes, saying what is missing
      noteIgnored('collect the diagnostics for a bug report', error);
      return `Couldn't collect the diagnostics: ${messageOf(error)}`;
    }),
    live.telemetry.reportContext(),
  ]);
  return {
    installId: installId(app.getPath('userData')),
    appVersion: app.getVersion(),
    os: `${osName()} ${os.release()}`,
    arch: process.arch,
    channel: t.channel,
    versions: t.versions,
    // errors ignored on purpose, then the errors telemetry saw (kept last, so the cap never drops them: they are the
    // ones the admin portal links to its error groups)
    fingerprints: [...recentIgnored().map((e) => fingerprint(e.message)), ...t.fingerprints],
    env: {
      // undefined outside Electron (left out of the JSON)
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      shellEnvCaptured: shellEnv.status().captured === true,
      signedIn: !!live.mopilot.status().signedIn,
      shareUsageData: live.telemetry.consent,
    },
    diagnostics,
    home: os.homedir(),
  };
}

/** A string value an object holds itself (not one it inherits, like `constructor`). */
const ownString = (o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) && typeof o[k] === 'string' ? o[k] : null);

/** The version of the chat's harness ('codex', 'claude' or 'acp:<id>') from telemetry's harnessVersions(). */
const versionOf = (versions, harness) => (harness ? (ownString(versions, harness) ?? ownString(versions?.basic, harness)) : null);

/** The transcript and diagnostics halved (each one longer than MIN_CUT) until the report's JSON fits the server's limit. */
function fit(report) {
  let r = report;
  const half = (t) => (t.length > MIN_CUT ? capMiddle(t, Math.floor(t.length / 2)) : t);
  while (Buffer.byteLength(JSON.stringify(r)) > MAX_BODY && (r.transcript.length > MIN_CUT || r.diagnostics.length > MIN_CUT))
    r = { ...r, transcript: half(r.transcript), diagnostics: half(r.diagnostics) };
  return r;
}

/**
 * The report as it is previewed and sent: the window's fields (kind, description, harness, model, transcript)
 * validated, scrubbed and cut to size, with main's own context.
 * @param {unknown} input what the dialog sends
 * @param {Awaited<ReturnType<typeof reportContext>>} ctx
 */
function buildReport(input, ctx) {
  const i = /** @type {Record<string, unknown>} */ (input && typeof input === 'object' ? input : {});
  const opts = { home: ctx.home };
  // scrubbed before it is cut, so a cut never splits a secret the scrubber would have found
  const text = (v, max) => (typeof v === 'string' ? capMiddle(scrub(v, opts), max) : '');
  const field = (v) => (typeof v === 'string' && v ? prefixUnits(scrub(v, opts), MAX_FIELD) : null);
  const harness = field(i.harness);
  return fit({
    installId: ctx.installId,
    kind: typeof i.kind === 'string' && KINDS.has(i.kind) ? i.kind : 'bug',
    description: text(i.description, MAX_DESCRIPTION).trim(),
    appVersion: ctx.appVersion,
    os: ctx.os,
    arch: ctx.arch,
    channel: ctx.channel,
    harness,
    harnessVersion: versionOf(ctx.versions, harness),
    model: field(i.model),
    env: ctx.env,
    diagnostics: text(ctx.diagnostics, MAX_DIAGNOSTICS),
    transcript: text(i.transcript, MAX_TRANSCRIPT),
    errorFingerprints: [...new Set(ctx.fingerprints)].filter((f) => /^[0-9a-f]{32}$/.test(f)).slice(-MAX_FINGERPRINTS),
  });
}

module.exports = {
  collectDiagnostics,
  reportContext,
  buildReport,
  capMiddle,
  MAX_BODY,
  MAX_TRANSCRIPT,
  MAX_DIAGNOSTICS,
};
