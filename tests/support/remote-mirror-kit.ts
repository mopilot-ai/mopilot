// Fakes for the remote mirror tests: the mirror seams (pty, folder, approval card, tool, capture, timers) and a service with a paired phone.
import assert from 'node:assert/strict';
import { rig } from './remote-kit.ts';

export const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
export const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, 'expected a failure');
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};
export const text = (events: any[]) => Buffer.concat(events.map((e) => Buffer.from(e.data, 'base64'))).toString();

/** The mirror seams as fakes: a pty that records, a chat folder, an approval card, a tool that runs on demand, a capture and manual timers. */
export function mirrorOps(o: { folder?: string | null; allow?: boolean } = {}) {
  const log: any[][] = [];
  const ptys = new Map<string, any>();
  const timers: { fn: () => void; cleared: boolean }[] = [];
  const tool = { surface: null as string | null, listeners: [] as ((id: string) => void)[] };
  const shots: { resolve: (v: any) => void; surface: string }[] = [];
  const mirror = {
    folderOf: async (id: string) => (log.push(['folder', id]), o.folder === undefined ? '/work/one' : o.folder),
    approveTerminal: async (id: string, p: any) => (log.push(['approve', id, p.cwd]), o.allow !== false),
    pty: {
      spawn: (key: string, opts: any, handlers: any) => (log.push(['spawn', key, opts]), ptys.set(key, handlers)),
      write: (key: string, d: string) => log.push(['write', key, d]),
      resize: (key: string, c: number, r: number) => log.push(['resize', key, c, r]),
      kill: (key: string) => (log.push(['kill', key]), ptys.delete(key)),
      pause: (key: string) => log.push(['pause', key]),
      resume: (key: string) => log.push(['resume', key]),
    },
    tool: {
      running: () => tool.surface,
      onChange: (fn: (id: string) => void) => (tool.listeners.push(fn), () => tool.listeners.splice(tool.listeners.indexOf(fn), 1)),
    },
    frame: (id: string, surface: string) => new Promise((resolve) => shots.push({ resolve, surface })),
    timers: {
      setTimeout: (fn: () => void) => (timers.push({ fn, cleared: false }), timers.at(-1)),
      clearTimeout: (t: any) => t && (t.cleared = true),
    },
  };
  const toolChanged = (surface: string | null, id = 'c1') => {
    tool.surface = surface;
    tool.listeners.forEach((fn) => fn(id));
  };
  return { mirror, log, ptys, timers, tool, shots, toolChanged };
}

export function mirrored(o: { folder?: string | null; allow?: boolean; on?: string[] } = {}) {
  const m = mirrorOps(o);
  const on = new Set(o.on ?? ['p1']);
  const r = rig({ ops: { mirror: m.mirror }, policy: { mirrors: (pair: string) => on.has(pair) } });
  const p1 = r.phone('p1');
  return { ...r, ...m, on, p1 };
}
export const follow = async (p: any, chatId = 'c1') => ok(await p.ask('chat.follow', { chatId }));
