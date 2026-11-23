// Claude Design's sign-in (/design-login) for Claude Code chats: drives the CLI's own host protocol, opens its sign-in page and forwards a pasted code.
//
// Claude Code's /design-login is an interactive panel, so a session run through the Agent SDK answers
// "isn't available in this environment". The CLI also ships the same sign-in for hosts as
// `claude design-login --json` (the VS Code extension runs it): JSON lines on stdout
// ({event: 'pages', url, manual_url, manual_first}, then {event: 'done', ok, message?}) and a pasted
// code as {code} lines on stdin, with stdin kept open until it is done (closing it cancels the sign-in).
// The credential it saves is the CLI's, kept where the account's login is; MoPilot never sees it.
const { clock } = require('../../platform/ports/clock.cjs');
const { proc } = require('../../platform/ports/proc.cjs');
const { spawnArgs: realSpawnArgs, spawnGroup, killTree: realKillTree, endGroup } = require('../../platform/winbin.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { JsonReader } = require('../../transport/jsonReader.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');

/** The CLI gives up after five minutes; a run that hasn't said "done" a minute later is stopped. */
const DEADLINE_MS = 6 * 60_000;
/** The last stderr kept, to say why a run ended without a "done" line. */
const STDERR_TAIL = 2000;

/** Only web pages are opened: the URLs come from the CLI, but they go to the system's opener. */
const webUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

/**
 * @param {{
 *   findBinary: (bin?: string | null) => Promise<string | null> | string | null,
 *   cleanEnv: (account?: string) => Record<string, string>,
 *   openExternal: (url: string) => unknown,
 *   broadcast: (evt: object) => void,
 *   spawn?: typeof proc.spawn,
 *   spawnArgs?: typeof realSpawnArgs,
 *   killTree?: typeof realKillTree,
 *   deadlineMs?: number,
 * }} o
 */
function createDesignLogin({
  findBinary,
  cleanEnv,
  openExternal,
  broadcast,
  spawn = proc.spawn,
  spawnArgs = realSpawnArgs,
  killTree = realKillTree,
  deadlineMs = DEADLINE_MS,
}) {
  /** The sign-in still running: one at a time, since each listens for the browser on its own. */
  /** @type {{ id: string, proc: any, finished: boolean, stopped: boolean, reader: InstanceType<typeof JsonReader> | null } | null} */
  let current = null;
  /** The start still finding its binary; a newer start or a cancel meanwhile takes its place. */
  /** @type {{ id: string } | null} */
  let starting = null;

  /** Stop a run; its process ending says "done" (cancelled), and the deadline covers one that doesn't end. */
  function stop(run) {
    run.stopped = true;
    run.reader?.close();
    killTree(run.proc);
  }

  /**
   * Start a sign-in for the account. `id` is the window's, so every event it gets is for the run it started,
   * even one sent before this call returns. A sign-in still running is stopped: the new one replaces it.
   */
  async function start(id, bin, account) {
    if (typeof id !== 'string' || !id) throw new Error('A sign-in needs an id');
    const ticket = { id };
    // another window's start still finding its binary is replaced, and that window hears it ended
    if (starting && starting.id !== id) broadcast({ id: starting.id, kind: 'done', ok: false, message: 'The sign-in was cancelled.' });
    starting = ticket;
    /** @type {string | null} */
    let file = null;
    /** @type {{ error: unknown } | null} */
    let failure = null;
    try {
      file = await findBinary(bin);
    } catch (error) {
      failure = { error };
    }
    // replaced or cancelled while the binary was looked up: it never starts, and its window already heard it ended
    if (starting !== ticket) return;
    starting = null;
    if (failure) throw failure.error;
    if (!file) throw new Error('Claude Code is not installed');
    if (current) stop(current);
    const run = {
      id,
      proc: /** @type {any} */ (null),
      finished: false,
      stopped: false,
      reader: /** @type {InstanceType<typeof JsonReader> | null} */ (null),
    };
    current = run;
    let stderr = '';
    const finish = (ok, message) => {
      if (run.finished) return;
      run.finished = true;
      run.reader?.close();
      clock.clearTimeout(timer);
      if (current === run) current = null;
      broadcast({ id, kind: 'done', ok, ...(message ? { message } : {}) });
    };
    const timer = clock.setTimeout(() => {
      stop(run);
      finish(false, 'The sign-in timed out. Try again.');
    }, deadlineMs);
    timer.unref?.();
    try {
      // in a process group of its own: a cancel or a timeout also ends anything the CLI started
      run.proc = spawnGroup(
        spawn,
        file,
        ['design-login', '--json'],
        { env: cleanEnv(account ?? undefined), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        spawnArgs,
      );
    } catch (e) {
      finish(false, `Couldn't start Claude Code: ${e?.message ?? e}`);
      return;
    }
    const proc = run.proc;
    // writing a code after the CLI exited fails with EPIPE: the exit already said how it ended
    proc.stdin.on('error', (e) => noteIgnored('send a code to the Claude Design sign-in', e, ['EPIPE', 'EOF']));
    // The core frames stdout's bytes into lines, a character split across reads whole in its line (electron/transport/jsonReader.cjs).
    proc.stderr.setEncoding('utf8');
    const reader = new JsonReader({
      stream: proc.stdout,
      onValue: (msg) => {
        if (current === run && !run.stopped && !run.finished && isJsonRecord(msg)) onMessage(msg);
      },
      onError: (error) => {
        stop(run);
        finish(false, `Claude Code sign-in connection failed: ${error.message}`);
      },
    });
    run.reader = reader;
    proc.stdout.on('data', (d) => reader.push(d));
    proc.stderr.on('data', (d) => {
      stderr = (stderr + String(d)).slice(-STDERR_TAIL);
    });
    proc.on('error', (e) => finish(false, `Couldn't start Claude Code: ${e?.message ?? e}`));
    // on exit, not close: close waits for every holder of its pipes, and a command it left running may hold one
    proc.on('exit', () => endGroup(proc));
    proc.on('close', (code) => {
      reader.finishInput(() => {
        if (run.stopped) return finish(false, 'The sign-in was cancelled.');
        finish(false, stderr.trim() || `Claude Code exited (code ${code}) before the sign-in finished.`);
      });
    });

    function onMessage(msg) {
      if (msg.event === 'done') {
        // it is over: closing stdin lets the CLI exit
        proc.stdin.end();
        return finish(msg.ok === true, typeof msg.message === 'string' ? msg.message : undefined);
      }
      if (msg.event !== 'pages' || run.finished) return;
      const url = webUrl(msg.url);
      const manualUrl = webUrl(msg.manual_url);
      const manualFirst = msg.manual_first === true;
      // a remote session's browser can't reach the CLI's listener: the page that shows a code to paste goes first
      const open = manualFirst ? manualUrl : url;
      if (open)
        Promise.resolve()
          .then(() => openExternal(open))
          // the window offers both pages, so a failed open is only noted
          .catch((e) => noteIgnored('open the Claude Design sign-in page', e));
      broadcast({ id, kind: 'pages', url, manualUrl, manualFirst });
    }
  }

  /** A code pasted from the sign-in page; false when the run it was for has ended (or there is no code). */
  function code(id, text) {
    const run = current;
    const c = typeof text === 'string' ? text.trim() : '';
    if (!run || run.id !== id || !c) return false;
    run.proc.stdin.write(`${JSON.stringify({ code: c })}\n`);
    return true;
  }

  /** The window closed its sign-in; a run that already ended is left alone. */
  function cancel(id) {
    if (starting?.id === id) {
      starting = null;
      broadcast({ id, kind: 'done', ok: false, message: 'The sign-in was cancelled.' });
    }
    if (current?.id === id) stop(current);
  }

  /** Quitting: the sign-in still running stops. */
  function cancelAll() {
    starting = null;
    if (current) stop(current);
  }

  return { start, code, cancel, cancelAll };
}

module.exports = { createDesignLogin, DEADLINE_MS };
