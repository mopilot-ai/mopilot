// IPC for the Codex app-server (start, connect, requests, leases, rollout watching and reading), basic-harness admission and
// sign-ins, and the settings a basic chat's transcript recorded.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const os = require('node:os');
const { noteIgnored } = require('../../ignored.cjs');
const { recordedSettings } = require('../../harness/acp/settings.cjs');
const { SignIns } = require('../../harness/acp/signin.cjs');
const { codexRollouts } = require('../../harness/codexRollout.cjs');
const { windowMethod, windowRequest } = require('../../harness/codexApi.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps what main.cjs passes every IPC module; `live` reads (and sets) main's late-bound state
 */
function register(ipcMain, deps) {
  const { server, findCodexBinary, shellEnv, handle, watchRollout, unwatchRollout, codexBinaries, live, broadcastAll } = deps;
  ipcMain.handle('codex:start', async () => {
    server.start();
    // where the start got to once the binary is known (one that had to look it up has usually spawned by then)
    const bin = (server.status === 'running' ? server.bin : null) ?? (await findCodexBinary());
    return { bin, status: server.status };
  });
  // Codex has been used on this machine: its home folder holds something
  ipcMain.handle('codex:used', () => {
    try {
      return fs.readdirSync(shellEnv.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex')).length > 0;
    } catch {
      return false;
    }
  });
  ipcMain.handle('codex:restart', () => {
    server.stop();
    server.start();
    return true;
  });
  // threads and writes that need the writer lease (design §07); everything resolves nativeOf in main.
  const obj = (p) => (p && typeof p === 'object' ? p : {});
  // the app-server accepts `initialize` once per process: every window gets the adapter's answer
  handle('codex:connect', () => live.codex.connect());
  // a window's request goes out under the adapter's own id, and only that window gets the result
  handle('codex:request', async (method, params) => {
    return live.codex.request(windowRequest(method, params), params ?? {});
  });
  // the named calls windows make (accounts, models, threads, projects, ...): codex.api
  handle('codex:api', (name, args) => live.codex.api(String(name), args));
  // only an answer to a card main still holds for this app-server goes out (two windows answering one approval, a
  // card from before a restart): false tells the window it was retired, as the other harnesses' answers do
  handle('codex:respond', (id, result) => {
    if (!live.controller.onCodexOutgoing({ id, result })) return false;
    live.codex.respond(id, result);
    // the Browser plugin's site consent: MoPilot's site card for the same site doesn't ask again
    live.siteConsent?.answered(id, result);
    return true;
  });
  handle('codex:leases', () => live.codex.leaseList());
  handle('codex:negotiated', () => live.codex.negotiation());
  handle('codex:resume', (threadId) =>
    live.codex.ensureResumed(String(threadId)).then(
      () => ({ ok: true }),
      (err) => (err?.code === 'locked' ? { locked: true } : Promise.reject(err)),
    ),
  );
  handle('codex:pinLease', (threadId, on) => live.codex.pin(String(threadId), !!on));
  handle('codex:leased', (chatId, method, params) => live.codex.leased(String(chatId), windowMethod(method), obj(params)));
  handle('codex:startThread', (params) => live.codex.startThread(obj(params)));
  handle('codex:fork', (params, hold) => live.codex.fork(obj(params), !!hold));
  // a harness whose binary changed since its check (it updated itself) is checked now; windows hear the result
  ipcMain.handle('acp:harnesses', () => {
    live.acpAdmission.refresh().catch((error) => noteIgnored('check the harnesses whose binary changed', error));
    return live.acpAdmission.list();
  });
  ipcMain.handle('acp:recheck', (_e, id) => live.acpAdmission.refresh({ force: true, only: typeof id === 'string' ? id : null }));
  // the ACP sign-ins under way, one per harness: every window shows them pending, and Cancel stops waiting for one
  const signIns = new SignIns();
  signIns.onChange((list) => broadcastAll('acp:signIns', list));
  ipcMain.handle('acp:signIns', () => signIns.list());
  ipcMain.handle('acp:cancelSignIn', (_e, id) => signIns.cancel(String(id)));
  // checked again once signed in; a sign-in cancelled (Cancel, in any window) changed nothing, so it is not. A click
  // while one waits joins it rather than opening a second login
  ipcMain.handle('acp:authenticate', async (_e, id, methodId) => {
    try {
      await signIns.run(String(id), String(methodId), (signal) => live.acpHost.authenticate(String(id), String(methodId), signal));
    } catch (e) {
      if (e?.cancelled) return { harnesses: live.acpAdmission.list(), cancelled: true };
      throw e;
    }
    return { harnesses: await live.acpAdmission.refresh({ force: true, only: String(id) }), cancelled: false };
  });
  // what a basic chat that isn't open would reopen on: its picker shows it
  // the user's own MCP servers for a basic harness: listed from its settings, and whether MoPilot turns them off
  ipcMain.handle('acp:ownMcp', (_e, id, readOnly) => live.acpOwnMcp.status(String(id), readOnly === true));
  ipcMain.handle('acp:recordedSettings', async (_e, key) => recordedSettings(await live.acpHost.items.readAsync(String(key))));
  ipcMain.handle('codex:watchRollout', (_e, threadId, file) => watchRollout(threadId, file));
  ipcMain.handle('codex:unwatchRollout', (_e, threadId) => unwatchRollout(threadId));
  // a thread's history from its rollout file, for while the app-server that reads it is down
  ipcMain.handle('codex:rolloutHistory', (_e, threadId, o) => codexRollouts().history(threadId, obj(o)));
  ipcMain.handle('codex:binaries', () => codexBinaries());
}

module.exports = { register };
