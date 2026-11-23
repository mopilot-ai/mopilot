// Text search for the Files pane's `?` filter: the lines under a folder that hold a term, read from the bundled ripgrep's JSON output (honouring .gitignore, as the file listing does). @host-portable
const childProcess = require('node:child_process');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');
const { isDirectory } = require('./directoryReads.cjs');
const shellEnv = require('./env.cjs');

const DEFAULT_LIMIT = 200;
const PER_FILE = 20; // matching lines kept per file, so one huge file can't take every result
const TIMEOUT_MS = 10000;
const MAX_TEXT = 300; // characters of a matching line kept for its row
const MAX_COLUMNS = 1000; // a longer line is sent as its first MAX_COLUMNS bytes

/**
 * @typedef {{ path: string, line: number, column: number, text: string }} TextMatch
 * @typedef {{ matches: TextMatch[], truncated: boolean }} TextSearch
 */

/** One `match` record of `rg --json` as a row, or null for any other record or one that isn't readable. */
function matchOf(record) {
  if (record?.type !== 'match') return null;
  const data = record.data;
  const file = data?.path?.text;
  const line = data?.line_number;
  const text = data?.lines?.text;
  if (typeof file !== 'string' || !Number.isInteger(line) || typeof text !== 'string') return null;
  const start = data.submatches?.[0]?.start;
  // ripgrep's offsets count UTF-8 bytes: the column is the characters before the first match
  const column = Number.isInteger(start) ? Buffer.from(text).subarray(0, start).toString().length : 0;
  return {
    path: file.startsWith('./') ? file.slice(2) : file,
    line,
    column,
    text: text.replace(/\r?\n$/, '').slice(0, MAX_TEXT),
  };
}

/**
 * The lines under `cwd` holding `query` (literal; case-insensitive unless it has a capital, as ripgrep's smart case
 * reads it), at most `limit`, with whether more were left out. A query of whitespace finds nothing. A failure to run
 * ripgrep rejects, so the pane shows it with Retry rather than "No results".
 * `signal` ends it early (a newer search from the same window), rejecting with why.
 * @param {string} cwd
 * @param {string} query
 * @param {{ limit?: number, timeoutMs?: number, bin?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<TextSearch>}
 */
async function searchText(cwd, query, { limit = DEFAULT_LIMIT, timeoutMs = TIMEOUT_MS, bin, signal } = {}) {
  if (!cwd || !path.isAbsolute(cwd) || !query.trim() || !(await isDirectory(cwd))) return { matches: [], truncated: false };
  const rg = bin ?? require('./search.cjs').rgPath();
  return new Promise((resolve, reject) => {
    const winArgs = process.platform === 'win32' ? ['--path-separator', '/'] : [];
    // a minified file's one huge line is sent cut short; node_modules is left out even where no .gitignore names it
    const args = ['--json', '--fixed-strings', '--smart-case', '--hidden', '--glob', '!.git', '--glob', '!node_modules'];
    args.push('--max-count', String(PER_FILE), '--max-columns', String(MAX_COLUMNS), '--max-columns-preview');
    const proc = childProcess.spawn(rg, [...args, '--no-messages', ...winArgs, '--', query, '.'], {
      cwd,
      env: shellEnv.childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    /** @type {TextMatch[]} */
    const matches = [];
    let rest = '';
    let done = false;
    let truncated = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch (error) {
        // the search already exited
        noteIgnored('stop a text search', error, ['ESRCH']);
      }
      err ? reject(err) : resolve({ matches, truncated });
    };
    // a search that ran out of time keeps what it found, marked as cut short
    const timer = setTimeout(() => {
      truncated = true;
      finish(matches.length ? undefined : new Error('Text search timed out'));
    }, timeoutMs);
    /** Keeps one output line's match; false once the limit is passed (the search is then over). */
    const take = (l) => {
      if (!l) return true;
      let record;
      try {
        record = JSON.parse(l);
      } catch (error) {
        noteIgnored('read a ripgrep record', error);
        return true;
      }
      const match = matchOf(record);
      if (!match) return true;
      if (matches.length >= limit) {
        truncated = true;
        finish();
        return false;
      }
      matches.push(match);
      return true;
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      if (done) return;
      const lines = (rest + chunk).split('\n');
      rest = /** @type {string} */ (lines.pop());
      for (const l of lines) if (!take(l)) return;
    });
    proc.on('error', finish);
    const stop = () => finish(new Error('Text search was replaced by a newer one'));
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop, { once: true });
    // exit 1 means nothing matched; exit 2 (an unreadable entry) still yields the matches among readable ones
    proc.on('close', (code, signal) => {
      if (done) return;
      if (!take(rest)) return;
      if (code === 0 || code === 1 || (code === 2 && matches.length)) return finish();
      finish(new Error(signal ? `Text search stopped (${signal})` : `Text search failed (exit ${code})`));
    });
  });
}

module.exports = { searchText, matchOf, DEFAULT_LIMIT };
