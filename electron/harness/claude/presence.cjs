// Which other apps run a Claude Code session right now (Claude desktop, a terminal, another MoPilot), from one scan of the process table.
const { isWin } = require('./cli.cjs');
const { coreCall } = require('../../platform/core.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/**
 * Claude sessions other apps are running right now: session id → the apps, from one scan of the
 * process table. A `claude` process names its session on the command line (Claude desktop starts
 * them with --resume=<id>); walking up its parents tells which app it belongs to. Sage's own CLIs
 * (children of this process) don't count; another Sage instance's do. A CLI started with
 * --continue names no session and goes unseen.
 */
const SESSION_ARG = /(?:--resume|--session-id|-r)[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
/** One host-wide read for overlapping window polls and sends; completed snapshots are never cached. */
/** @type {Promise<Record<string, string[]>> | null} */
let pending = null;
function presence() {
  // no command lines on Windows: other apps' sessions just go unseen there
  if (isWin()) return Promise.resolve({});
  if (pending !== null) return pending;
  pending = coreCall('proc.commands')
    .then(
      (rows) => sessionsOf(rows),
      (error) => {
        // the table can't be read now: other apps' sessions go unseen until the next scan, and a send waits on nothing
        noteIgnored("read other apps' Claude Code processes", error);
        return {};
      },
    )
    .finally(() => {
      pending = null;
    });
  return pending;
}

/**
 * The Claude sessions other apps run, from `[pid, ppid, command]` rows: session id → the apps.
 * @param {[number, number, string][]} rows
 */
function sessionsOf(rows) {
  /** @type {Record<string, string[]>} */
  const map = {};
  const procs = new Map(rows.map(([pid, ppid, cmd]) => [pid, { ppid, cmd }]));
  for (const [pid, p] of procs) {
    // the claude binary itself, not a wrapper whose arguments mention it (Claude desktop's helper)
    if (!/(^|\/)claude$/.test(p.cmd.split(' -')[0].trim())) continue;
    const sid = SESSION_ARG.exec(p.cmd)?.[1];
    if (!sid || p.ppid === process.pid || pid === process.pid) continue;
    (map[sid] ??= []).push(appOf(procs, p.ppid));
  }
  return map;
}
/** Which app a process belongs to, from its ancestors' command lines. */
function appOf(procs, pid) {
  for (let i = 0; i < 12 && pid > 1; i++) {
    const p = procs.get(pid);
    if (!p) break;
    if (/\/Claude\.app\//.test(p.cmd)) return 'claude-desktop';
    if (/sagecode|\/Sage\.app\//i.test(p.cmd) && /Electron|Sage/.test(p.cmd)) return 'sage';
    if (
      /\/(Terminal|iTerm2?|Ghostty|WezTerm|Warp|kitty|Alacritty|Hyper|Visual Studio Code|Cursor|Windsurf|Zed)\.app\/|\btmux\b|\bscreen\b/.test(
        p.cmd,
      )
    )
      return 'claude-cli';
    pid = p.ppid;
  }
  return 'other';
}

module.exports = { presence, appOf, sessionsOf };
