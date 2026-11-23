// IPC for MoMo's trust records in Settings › MoMo (#2290, #2292): the audit log's state (it checks out, or it can't go on and why), exporting it as JSONL to a file the user picks, starting a new log when the old one can't go on, when the remembered approvals can't be read, setting them aside to start empty, and the sites MoMo may open after reading private data, each removable (#3655). Each call is refused unless MoMo is allowed for the account, and reads main's MoMo services (live.momo, electron/app/momo.cjs) when it runs, so it works however late they start.
const { fs: fsPort } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { momoAllowed } = require('../../momo/access.cjs');
const { userError } = require('../../../shared/userError.mjs');

/**
 * What Settings shows of the audit log: `ok` (it checks out, with how many entries), `stuck` (it can't go on or doesn't
 * check out: Start a new log is offered; `exportable` when it can still be read), or `unavailable` (it can't be used now:
 * no encryption, another MoPilot holds it, or it couldn't be read just now), with why. Only `stuck` is ever set aside.
 * @typedef {{ state: 'ok', entries: number } | { state: 'stuck', reason: string, exportable: boolean }
 *   | { state: 'unavailable', reason: string }} AuditState
 * What Settings shows of the remembered approvals: `ok`, `unreadable` (Set aside is offered), or `unavailable` with why.
 * @typedef {{ state: 'ok' } | { state: 'unreadable' } | { state: 'unavailable', reason: string }} ApprovalsState
 */

const refusal = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
/** Why the audit log can't go on, by its error's code (electron/momo/auditKey.cjs AuditError). */
const AUDIT_REASON = {
  key: "Its key is missing or can't be read, so it can't go on.",
  corrupt: "Its end is damaged, so it can't go on.",
};
/** Why the audit log can't be used now, though it may be fine: never offered to be set aside. */
const AUDIT_PASSING = {
  unavailable: "Needs encryption, which this Mac can't offer now.",
  locked: 'Another MoPilot is using it.',
};
/** What a check that didn't pass found (electron/momo/auditRead.cjs Verdict reason). */
const VERDICT = {
  cut: 'Entries were cut from its end.',
  checkpoint: 'Entries were cut from its end.',
};
/** Why the remembered approvals can't be used now, though what is stored may be fine: never offered to be set aside. */
const PASSING = {
  unavailable: "This Mac can't encrypt them now.",
  locked: 'Another MoPilot is using them.',
};
/** @param {Record<string, string>} table @param {unknown} error */
const reasonOf = (table, error) => {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === 'string' && Object.hasOwn(table, code) ? table[code] : null;
};

/**
 * The audit log's state, from a full check of the chain.
 * @param {any} audit electron/momo/audit.cjs AuditLog
 * @returns {Promise<AuditState>}
 */
async function auditState(audit) {
  if (!audit.available()) return { state: 'unavailable', reason: AUDIT_PASSING.unavailable };
  try {
    const v = await audit.verify();
    if (v.ok) return { state: 'ok', entries: v.entries };
    return { state: 'stuck', reason: VERDICT[/** @type {keyof typeof VERDICT} */ (v.reason)] ?? "It doesn't check out.", exportable: true };
  } catch (error) {
    // the key is lost (nothing can be read without it), or the log's end can't be continued
    const stuck = reasonOf(AUDIT_REASON, error);
    if (stuck) return { state: 'stuck', reason: stuck, exportable: /** @type {any} */ (error).code !== 'key' };
    // anything else (no encryption now, another MoPilot, a read that failed): said, and the log is left alone
    return { state: 'unavailable', reason: reasonOf(AUDIT_PASSING, error) ?? userError(error) };
  }
}

/**
 * The remembered approvals' state, once the sentinel has tried to read them.
 * @param {any} sentinel electron/momo/sentinel.cjs Sentinel
 * @returns {Promise<ApprovalsState>}
 */
async function approvalsState(sentinel) {
  await sentinel.load();
  const e = sentinel.loadError;
  if (!e) return { state: 'ok' };
  const passing = reasonOf(PASSING, e);
  if (passing) return { state: 'unavailable', reason: passing };
  return { state: 'unreadable' };
}

/** A file name for an export made at `at`: MoMo audit log 2026-10-24.jsonl. */
const exportName = (/** @type {number} */ at) => `MoMo audit log ${new Date(at).toISOString().slice(0, 10)}.jsonl`;

/**
 * @param {{ handle: (channel: string, fn: (event: any, ...args: any[]) => unknown) => void }} ipcMain
 * @param {{ live: { momo?: { audit: any, sentinel: any } }, dialog: any, BrowserWindow: any }} deps
 * @param {{ allowed?: () => boolean, now?: () => number, fs?: Pick<typeof fsPort.promises, 'writeFile' | 'chmod'> }} [o] for tests
 */
function register(ipcMain, { live, dialog, BrowserWindow }, { allowed = momoAllowed, now = Date.now, fs = fsPort.promises } = {}) {
  /** MoMo's services, once MoMo is allowed and they are made. */
  const momo = () => {
    if (allowed() !== true) throw refusal('not_allowed', 'MoMo is not available.');
    if (!live.momo) throw refusal('not_started', "MoMo hasn't started yet.");
    return live.momo;
  };
  // errors come back as values, so the window sees the message and its code (the bridge's call() rethrows them)
  const handle = (/** @type {string} */ channel, /** @type {(event: any, arg?: unknown) => Promise<unknown>} */ fn) =>
    ipcMain.handle(channel, async (/** @type {any} */ event, /** @type {unknown} */ arg) => {
      try {
        return { value: await fn(event, arg) };
      } catch (err) {
        return { error: { message: String(/** @type {any} */ (err)?.message ?? err), code: /** @type {any} */ (err)?.code ?? null } };
      }
    });

  handle('momoTrust:status', async () => {
    const { audit, sentinel } = momo();
    const approvals = await approvalsState(sentinel);
    // the always-allowed sites, once what is stored could be read
    return { audit: await auditState(audit), approvals, sites: approvals.state === 'ok' ? sentinel.listSites() : [] };
  });

  // forgets one always-allowed site: opening it after a private read asks again
  handle('momoTrust:removeSite', async (_event, host) => {
    const { sentinel } = momo();
    if (typeof host !== 'string' || !host) throw refusal('invalid', 'Not a site.');
    return { removed: sentinel.removeSite(host) };
  });

  // the whole log as written (each line with its HMAC), to a file the user picks over the window that asked
  handle('momoTrust:exportAudit', async (event) => {
    const { audit } = momo();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw refusal('not_window', 'Not an app window');
    const r = await dialog.showSaveDialog(win, {
      defaultPath: exportName(now()),
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }],
    });
    if (r.canceled || !r.filePath) return { saved: null };
    // read once a file is picked, so it holds every entry up to now
    await fs.writeFile(r.filePath, await audit.exportJsonl(), { mode: 0o600 });
    // a file picked over an older one keeps that one's mode otherwise
    await fs.chmod(r.filePath, 0o600);
    return { saved: path.basename(r.filePath) };
  });

  // only when the log can't go on: a log that checks out is never set aside
  handle('momoTrust:startOverAudit', async () => {
    const { audit } = momo();
    if ((await auditState(audit)).state !== 'stuck') throw refusal('not_needed', "MoMo's audit log can go on.");
    return { aside: await audit.startOver() };
  });

  // only when the approvals can't be read: readable ones are never set aside
  handle('momoTrust:setAsideApprovals', async () => {
    const { sentinel } = momo();
    if ((await approvalsState(sentinel)).state !== 'unreadable') throw refusal('not_needed', "MoMo's remembered approvals can be read.");
    const keptAs = await sentinel.setAsideStored();
    // a read begun before the file moved may have failed again: the approvals are read once more now
    await sentinel.load();
    return { keptAs: keptAs ? path.basename(keptAs) : null };
  });
}

module.exports = { register, auditState, approvalsState, exportName };
