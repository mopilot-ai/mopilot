// "Copy diagnostics" (Settings → About): what support needs to see, as plain text. Every environment
// variable passes through redactEnv (shared/scrub.cjs), so a key, a token or a gateway URL never leaves
// the machine in a bug report, and the whole text is scrubbed of user paths once more.
const { scrub, redactEnv } = require('../../shared/scrub.cjs');

/**
 * @param {object} i
 * @param {string} i.version app version
 * @param {string} i.platform process.platform
 * @param {string} [i.arch]
 * @param {Record<string, string | undefined>} [i.versions] process.versions (electron, chrome, node)
 * @param {Record<string, string | null>} [i.harnesses] label -> CLI path or null
 * @param {{captured: boolean, error: string | null}} [i.envStatus] the login-shell capture (electron/platform/env.cjs)
 * @param {Record<string, string | undefined>} [i.env] the environment child processes get
 * @param {string} [i.home]
 * @param {{context: string, message: string, at: string, count?: number}[]} [i.ignored] errors deliberately ignored (electron/ignored.cjs)
 * @param {object} [i.capabilityHealth] diagnostic capability health snapshot
 * @param {object} [i.nativeAvailability] diagnostic native-control status
 * @param {string[]} [i.ledger] the request ledger's lines of the last day (electron/ledger/store.cjs lastDay)
 * @param {{at: number, window: string, problem: string, exitCode?: number, memoryMB?: number}[]} [i.windowProblems] app
 *   windows that stopped working (electron/platform/windowRecovery.cjs)
 */
function buildDiagnostics(i) {
  const opts = { home: i.home };
  const lines = [`MoPilot ${i.version}`, `${i.platform}${i.arch ? ` ${i.arch}` : ''}`];
  const v = i.versions || {};
  const runtime = ['electron', 'chrome', 'node'].filter((k) => v[k]).map((k) => `${k} ${v[k]}`);
  if (runtime.length) lines.push(runtime.join(' · '));
  lines.push('', 'Harnesses');
  for (const [name, bin] of Object.entries(i.harnesses || {})) lines.push(`  ${name}: ${bin ?? 'not found'}`);
  if (i.envStatus)
    lines.push(
      '',
      `Login shell environment: ${i.envStatus.captured ? 'captured' : `not captured${i.envStatus.error ? ` (${i.envStatus.error})` : ''}`}`,
    );
  const env = redactEnv(i.env || {}, opts);
  lines.push('', 'Environment');
  for (const k of Object.keys(env).sort()) lines.push(`  ${k}=${env[k] ?? ''}`);
  if (i.ignored?.length) {
    lines.push('', `Recently ignored errors (last ${i.ignored.length})`);
    for (const e of i.ignored) lines.push(`  ${e.at} ${e.context}: ${e.message}${(e.count ?? 1) > 1 ? ` (${e.count} times)` : ''}`);
  }
  if (i.windowProblems?.length) {
    lines.push('', `App window problems (last ${i.windowProblems.length})`);
    for (const p of i.windowProblems) {
      const code = p.exitCode !== undefined ? ` (${p.exitCode})` : '';
      lines.push(`  ${new Date(p.at).toISOString()} ${p.window}: ${p.problem}${code}${p.memoryMB ? `, ${p.memoryMB} MB` : ''}`);
    }
  }
  /** @type {[string, object | undefined][]} */
  const evidence = [
    ['Capability health', i.capabilityHealth],
    ['Native control', i.nativeAvailability],
  ];
  for (const [label, value] of evidence) {
    if (value) lines.push('', label, JSON.stringify(value, null, 2));
  }
  if (i.ledger?.length) {
    lines.push('', `Request log, last day (${i.ledger.length} lines)`);
    for (const l of i.ledger) lines.push(`  ${l}`);
  }
  return scrub(lines.join('\n'), opts);
}

module.exports = { buildDiagnostics };
