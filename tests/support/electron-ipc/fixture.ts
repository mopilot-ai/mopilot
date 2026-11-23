// electron/main.cjs: the IPC handlers windows call (registerIpc, browser tools, Quick Chat, git, fs,
// cloud, recordings), over a fake Electron and fake child processes (tests/support/electron-main-harness.ts).
import { mock, after } from 'node:test';
import { loadMain, unloadMain, flush, withPlatform } from '../electron-main-harness.ts';
export { tornWrites } from '../torn-write.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
export const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);
export const ready = async (cfg: any = {}) => {
  const h = await loadMain(cfg);
  await h.ready();
  return h;
};

/**
 * Whether `ipc` is main's ipcMain: Electron's, behind the stream batcher's ordered replies (electron/harness/coreBatcher.cjs),
 * so a handler registered on it lands in Electron's handlers.
 */
export function isMainIpc(h: any, ipc: any) {
  const probe = () => 'probe';
  ipc.handle('probe:ipc', probe);
  // through the performance probe's timer, which wraps every handler (electron/perf/probe.cjs timedIpc)
  const registered = h.handlers.get('probe:ipc');
  const same = (registered?.handles ?? registered) === probe;
  h.handlers.delete('probe:ipc');
  return same;
}

export { loadMain, flush, withPlatform };
