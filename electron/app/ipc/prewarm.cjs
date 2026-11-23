// IPC for prewarming a new chat's harness (#1664). A window's new-chat composer says what its first send would start
// (session:prewarm), and that send takes it (session:prewarmTake). There is one entry per window, released when the
// window goes away.
const { createPrewarm } = require('../../session/contract/prewarm.cjs');
const { claudePrewarm } = require('../../harness/claude/prewarm.cjs');
const { codexPrewarm } = require('../../harness/codexPrewarm.cjs');
const { acpPrewarm } = require('../../harness/acpPrewarm.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps
 */
function register(ipcMain, deps) {
  const { live, claude, isFlagEnabled, app } = deps;
  /** @type {Record<string, import('../../session/contract/prewarm.cjs').PrewarmHook>} */
  const made = {};
  // the adapters are main's late-bound state: each family's hook is made the first time a composer asks for it
  const hooks = {
    get claude() {
      // the gateway's deny entries go in its key: a warm CLI started before a server was managed isn't taken (#2999 C4)
      const gatewayDenials = () => require('../gatewayManaged.cjs').gatewayDenials(live);
      return (made.claude ??= claudePrewarm({
        adapter: live.claudeTurns,
        api: { ...claude, isLive: claude.turnApi.isLive, gatewayDenials },
      }));
    },
    get codex() {
      return (made.codex ??= codexPrewarm({ adapter: live.codex }));
    },
    get acp() {
      return (made.acp ??= acpPrewarm({ host: live.acpHost }));
    },
  };
  const prewarm = createPrewarm({ hooks, enabled: () => isFlagEnabled('shared.prewarm') });
  /** windows whose entry goes with them */
  const watched = new Set();
  ipcMain.on('session:prewarm', (e, spec) => {
    const id = e.sender.id;
    if (!watched.has(id)) {
      watched.add(id);
      e.sender.once('destroyed', () => {
        watched.delete(id);
        prewarm.release(id);
      });
    }
    prewarm.hint(id, spec ?? null);
  });
  // a take that fails leaves the send to start cold, as it would without a prewarm
  ipcMain.handle('session:prewarmTake', (e, spec) =>
    prewarm.take(e.sender.id, spec ?? null).catch((error) => (noteIgnored("take a new chat's prewarm", error), null)),
  );
  app.on('will-quit', () => prewarm.releaseAll());
  return prewarm;
}

module.exports = { register };
