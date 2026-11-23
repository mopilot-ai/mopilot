// An in-process ACP agent behind a fake child process, for electron/harness/acp.cjs and admission.cjs:
// the client writes JSON-RPC lines to its stdin, it answers on stdout from `handlers`, and a test can
// send requests and notifications of its own, write stderr, or make it exit.
import { EventEmitter } from 'node:events';
import { errorReply } from '../fixtures/acpError.mjs';

export const NO_REPLY = Symbol('no reply');
type Handler = (params: any, proc: FakeProc) => any;
export type FakeProc = EventEmitter & {
  pid: number | undefined;
  stdin: any;
  stdout: any;
  stderr: any;
  received: any[];
  notes: any[];
  kills: string[];
  request(method: string, params?: any): Promise<any>;
  notify(method: string, params?: any): void;
  line(text: string): void;
  exit(code: number | null, signal?: string | null): void;
  kill(signal?: string): void;
};

export const INIT = (caps: any = {}, extra: any = {}) => ({
  protocolVersion: 1,
  agentCapabilities: caps,
  agentInfo: { name: 'fake', version: '1.0' },
  ...extra,
});

export function fakeProc(handlers: Record<string, Handler> = {}, o: { pid?: number; noStderr?: boolean } = {}): FakeProc {
  const p = new EventEmitter() as FakeProc;
  p.pid = 'pid' in o ? o.pid : 4242;
  p.received = [];
  p.notes = [];
  p.kills = [];
  const pending = new Map<number, (m: any) => void>();
  let seq = 1000;
  p.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  if (!o.noStderr) p.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  const out = (m: any) => p.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  p.line = (text) => p.stdout.emit('data', text);
  p.stdin = Object.assign(new EventEmitter(), {
    ended: false,
    end() {
      p.stdin.ended = true;
    },
    write(s: string) {
      for (const line of s.split('\n').filter(Boolean)) {
        const m = JSON.parse(line);
        p.received.push(m);
        if (m.method && m.id != null) {
          const h = handlers[m.method];
          setImmediate(async () => {
            try {
              const result = h ? await h(m.params, p) : {};
              if (result === NO_REPLY) return;
              out({ id: m.id, result });
            } catch (e: any) {
              out(errorReply(m.id, e, -32000));
            }
          });
        } else if (m.method) p.notes.push(m);
        else pending.get(m.id)?.(m), pending.delete(m.id);
      }
    },
  });
  p.request = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      out({ id, method, params });
    });
  p.notify = (method, params = {}) => out({ method, params });
  p.exit = (code, signal = null) => p.emit('exit', code, signal);
  p.kill = (signal = 'SIGTERM') => void p.kills.push(signal);
  return p;
}

/** A spawnFn handing out fake agents; `procs` lists them, `calls` what was spawned. */
export function fakeSpawn(handlers: Record<string, Handler> = {}, o: { pid?: number; noStderr?: boolean } = {}) {
  const procs: FakeProc[] = [];
  const calls: any[] = [];
  const spawnFn = (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    const p = fakeProc({ initialize: () => INIT(), 'session/new': () => ({ sessionId: `s${procs.length}` }), ...handlers }, o);
    procs.push(p);
    return p;
  };
  return { spawnFn, procs, calls };
}
