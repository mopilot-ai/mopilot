// A fake `codex app-server` process for a real AppServer (its spawn): it reads the JSON lines written to its stdin, keeps
// them, and answers each request from its handlers (an empty result by default) on its stdout. For tests that run two
// app-servers (MoMo's beside the main one, #2308).
import { EventEmitter } from 'node:events';

export type ProcHandler = (params: any, msg: any) => any;

export function fakeCodexSpawn(name: string, handlers: Record<string, ProcHandler> = {}) {
  const procs: any[] = [];
  const calls: any[] = [];
  let pid = name === 'main' ? 100 : 200;
  const spawn = (cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    const p: any = new EventEmitter();
    p.pid = ++pid;
    p.kills = 0;
    p.kill = () => p.kills++;
    p.lines = [] as any[];
    p.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    p.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    p.say = (msg: any) => p.stdout.emit('data', `${JSON.stringify(msg)}\n`);
    p.stdin = Object.assign(new EventEmitter(), {
      write: (line: string) => {
        const msg = JSON.parse(line);
        p.lines.push(msg);
        if (msg.id == null || !msg.method) return;
        const h = handlers[msg.method];
        setImmediate(() => {
          try {
            const result = h ? h(msg.params, msg) : {};
            if (result !== undefined) p.say({ id: msg.id, result });
          } catch (e: any) {
            p.say({ id: msg.id, error: { code: -32600, message: e.message } });
          }
        });
      },
    });
    procs.push(p);
    return p;
  };
  /** what the nth process (the last by default) was sent, by method */
  const sent = (method?: string, n = procs.length - 1) => (procs[n]?.lines ?? []).filter((m: any) => !method || m.method === method);
  return { spawn, procs, calls, sent };
}
