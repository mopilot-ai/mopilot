// IPC for the request ledger (electron/ledger): the last lines for Settings → About → Diagnostics → Request log, usage and cost
// at list price over a range of days, importing the usage of Claude Code and Codex sessions run outside MoPilot, and revealing the
// folder its files are in.
const { fs } = require('../../platform/ports/fs.cjs');
const { projectsRoot } = require('../../platform/claudeHome.cjs');
const { userCodexHome, rolloutFolders } = require('../../harness/codexRollout.cjs');

/** A window's filter, with only the fields and types the ledger reads. */
function filterOf(f) {
  const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : undefined);
  const o = f && typeof f === 'object' ? f : {};
  return {
    limit: typeof o.limit === 'number' ? o.limit : undefined,
    harness: str(o.harness),
    account: str(o.account),
    outcome: str(o.outcome),
    chat: str(o.chat),
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A window's range of days, with only well-formed day stems kept. */
function rangeOf(r) {
  const o = r && typeof r === 'object' ? r : {};
  const day = (v) => (typeof v === 'string' && DAY_RE.test(v) ? v : undefined);
  return { from: day(o.from), to: day(o.to) };
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ shell: Pick<import('electron').Shell, 'openPath'>, live?: { ledger?: import('../../ledger/index.cjs').AppLedger | null } }} deps
 * @param {() => import('../../ledger/index.cjs').AppLedger | null} [ledger] the ledger main opened (live.ledger, app/sessions.cjs)
 * @param {() => { claude: string, codex: string[] }} [roots] Claude Code's transcripts folder and the folders the user's CODEX_HOME
 *   (the main app-server's, never MoMo's) keeps its rollouts in, which the import reads
 */
function register(
  ipcMain,
  { shell, live },
  ledger = () => live?.ledger ?? null,
  roots = () => ({ claude: projectsRoot(), codex: rolloutFolders(userCodexHome()) }),
) {
  ipcMain.handle('ledger:recent', async (_e, f) => (await ledger()?.store.recent(filterOf(f))) ?? []);
  ipcMain.handle('ledger:summary', async (_e, r) => (await ledger()?.store.summary(rangeOf(r))) ?? { rows: [], rollup: 'ok' });
  ipcMain.handle('ledger:importOutside', async () => {
    const store = ledger()?.store;
    if (!store) return { refused: 'not-started' };
    return store.importOutside(roots());
  });
  ipcMain.handle('ledger:reveal', async () => {
    const dir = ledger()?.store.dir;
    if (!dir) return { ok: false, error: 'The request log has not started' };
    await fs.promises.mkdir(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true };
  });
}

module.exports = { register, filterOf, rangeOf };
