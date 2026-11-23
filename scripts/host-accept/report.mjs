// The acceptance run's result: a table of steps with PASS/FAIL and timings, the things the run does not verify, and the exit code.

/** @typedef {{ id: string, title: string, status: 'PASS' | 'FAIL' | 'SKIP', ms: number, detail: string }} Row */

/** What no run of this script can show: stays in every report so nobody reads the table as more than it is. */
export const NOT_VERIFIED = Object.freeze([
  'Real Claude Code and Codex logins and turns (the user’s accounts)',
  'The app’s own SSH tunnel (createTunnel); the run reaches the Host’s socket with `nc -U` over the same channel',
  'The app half of the tool relay and the remote browser pane (needs the app)',
  'Any operating system or CPU other than the one named in the header',
]);

/** @param {number} ms */
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** Table cells carry no pipes or line breaks. @param {string} text */
const cell = (text) =>
  text
    .replace(/\|/g, '/')
    .replace(/\s*\n\s*/g, ' ')
    .slice(0, 300);

/**
 * A report as Markdown.
 * @param {{ target: string, rows: Row[], platform?: string, notVerified?: readonly string[], at?: string }} o platform: what `uname -sm` said on the machine, so a table says which OS it is evidence for
 */
export function formatReport({ target, rows, platform = '', notVerified = NOT_VERIFIED, at = new Date().toISOString() }) {
  const passed = rows.filter((r) => r.status === 'PASS').length;
  return [
    `### Host acceptance run on ${target}${platform ? ` (${cell(platform.trim())})` : ''} (${at})`,
    '',
    '| Step | Result | Time | Detail |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.id} ${cell(r.title)} | ${r.status} | ${seconds(r.ms)} | ${cell(r.detail)} |`),
    '',
    `**${passed}/${rows.length} passed** in ${seconds(rows.reduce((n, r) => n + r.ms, 0))}.`,
    '',
    '**Not verified by this run:**',
    ...notVerified.map((n) => `- ${n}`),
    '',
  ].join('\n');
}

/** The process exit code: 0 only when no step failed. @param {Row[]} rows */
export const exitCode = (rows) => (rows.some((r) => r.status === 'FAIL') ? 1 : 0);
