// The rig for computer use wired up in main (setupComputerUse) over fakes, shared by its setup tests.
import { after } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { setupComputerUse } = require('../../electron/capabilities/computerUse.cjs');
const { Registry } = require('../../electron/capabilities/contract/registry.cjs');

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** setupComputerUse over fakes; `o` overrides the harness kind, flags, hooks and options each test needs. */
export function rig(o: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cu-setup-'));
  dirs.push(dir);
  const handlers = new Map<string, Function>();
  const flags: Record<string, boolean> = { 'shared.computerUse.enabled': true, 'shared.computerUse.unattended': true, ...o.flags };
  const meta = new Map<string, any>();
  const chats = {
    records: new Map<string, any>(o.records ?? []),
    get: (id: string) => (meta.has(id) ? { meta: meta.get(id) } : null),
    record: (id: string) => ({ id, meta: meta.get(id) ?? { notes: [] } }),
    patchMeta: (id: string, p: any) => (meta.set(id, { ...(meta.get(id) ?? {}), ...p }), true),
  };
  const approvals: any[] = [];
  const controller = {
    chatOf: (id: string) => `chat-of-${id}`,
    ref: () => ({ kind: o.kind ?? 'claude' }),
    isSubagentCall: (_c: string, callId: string) => callId === 'sub',
    viewing: () => o.viewing ?? true,
    addApproval: (_c: string, a: any) => approvals.push(a),
    resolveApproval: () => true,
  };
  const states = new Map<string, any>();
  const patches: any[] = [];
  const sessions = { get: (id: string) => states.get(id) ?? {}, patch: (id: string, p: any) => patches.push([id, p]) };
  const log: any[] = [];
  const registry = new Registry();
  const runtime = setupComputerUse({
    ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    registry,
    flags: { isEnabled: (k: string) => flags[k] },
    chats,
    controller,
    sessions,
    userData: dir,
    packaged: false,
    // no permission wait outlives a test that opened a pane; the one that tests the wait passes its own timing
    permissionWatch: { timeoutMs: 0 },
    broadcast: (...a: any[]) => log.push(['broadcast', ...a]),
    stop: async (id: string) => {
      log.push(['stop', id]);
      if (o.stopFails) throw new Error('no turn');
    },
    ...(o.withNotify === false ? {} : { notify: (id: string, app: string) => log.push(['notify', id, app]) }),
    ...(o.withControlling === false ? {} : { onControlling: (id: string | null) => log.push(['controlling', id]) }),
    ...(o.vision ? { vision: o.vision } : {}),
    ...(o.notifyKind ? { notifyKind: o.notifyKind } : {}),
    ...(o.shown ? { shown: o.shown } : {}),
    ...(o.openExternal ? { openExternal: o.openExternal } : {}),
    ...(o.onHealth ? { onHealth: o.onHealth } : {}),
    ...(o.benchAttended ? { benchAttended: o.benchAttended } : {}),
    // main's Codex hooks for Codex Computer Use (electron/app/agentTools.cjs)
    ...(o.codex ?? {}),
    // any other setupComputerUse option a test needs (remote owners, agent names)
    ...(o.options ?? {}),
  });
  const ipc = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
  /** The same, from a window: the event names its sender. */
  const ipcFrom = (sender: unknown, name: string, ...args: any[]) => handlers.get(name)!({ sender }, ...args);
  return { runtime, ipc, ipcFrom, flags, states, patches, log, approvals, registry, meta, dir };
}
