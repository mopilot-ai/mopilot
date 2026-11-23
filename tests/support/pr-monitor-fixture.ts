// Main-process PR monitor fixture with mocked GitHub boundaries and real chat/controller ownership.
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { register } from '../../electron/app/ipc/prMonitor.cjs';
import { setup } from './controller/fixture.ts';
const url = 'https://github.com/o/r/pull/1';
export function prMonitorFixture(seed?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-pr-'));
  const app = Object.assign(new EventEmitter(), { getPath: () => dir });
  if (seed !== undefined) fs.writeFileSync(path.join(dir, 'pr-monitors.json'), seed);
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const f = setup();
  const controller = f.c;
  controller.beforeDispatch = async () => {};
  const sender = { isDestroyed: () => false };
  const live: any = {
    controller,
    chats: f.chats,
    sessions: f.state,
    capabilities: { register: (tool: any) => tools.set(tool.name, tool) },
    peerRuntime: { paused: new Set(), projectOf: async () => '/work' },
  };
  const deps: any = {
    app,
    live,
    flags: true,
    execWindows: new Set([sender]),
    isFlagEnabled: () => deps.flags,
    broadcastAll: () => {},
    ran: 0,
    run: (...args: any[]) => deps.github(...args),
    github: async (_cmd: string, args: string[] = []) => ({
      ok: true,
      ran: deps.ran++,
      // the repository's default branch, where a PR's stack ends; every other call reads the PR
      stdout: JSON.stringify(
        args[0] === 'repo'
          ? { defaultBranchRef: { name: 'main' } }
          : {
              url,
              title: 'PR',
              state: 'OPEN',
              headRefOid: 'head',
              headRefName: 'child',
              baseRefName: 'main',
              mergeable: 'CONFLICTING',
              statusCheckRollup: [],
            },
      ),
      stderr: '',
    }),
  };
  let timer!: () => Promise<void>;
  const clock = mock.method(globalThis, 'setInterval', ((callback: any) => {
    timer = callback;
    return { unref() {} };
  }) as any);
  const monitor = register({ handle: (name: string, callback: any) => handlers.set(name, callback) }, deps);
  clock.mock.restore();
  const cleanup = () => {
    app.emit('will-quit');
    for (const id of f.state.all()) controller.end(id, { drain: false });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ...f, controller, monitor, deps, live, handlers, tools, sender, app, dir, cleanup, timer: () => timer() };
}
