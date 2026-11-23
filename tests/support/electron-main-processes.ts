// The child processes loadMain() (electron-main-harness.ts) gives main: `cp`, which a test reads and replaces
// (exec's answers, execCalls, execFileSync, spawn), and the node:child_process stand-in over it, mocked by specifier
// and installed in the proc port (electron/platform/ports/proc.cjs) for the modules that reach it there.
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { procPortMock } from './ports/proc.ts';

const fn = (impl?: (...a: any[]) => any) => mock.fn(impl);

export function mainProcesses() {
  const cp: any = {
    /** (cmd, args, opts) => { err?, stdout?, stderr? } */
    exec: (_cmd: string, _args: string[], _opts: any) => ({ stdout: '', stderr: '' }),
    execCalls: [] as any[],
    execFileSync: fn(() => Buffer.from('codex-cli 0.1.0\n')),
    spawn: fn(() => {
      const c: any = new EventEmitter();
      c.unref = fn();
      queueMicrotask(() => c.emit('spawn'));
      return c;
    }),
  };
  const childProcess = {
    execFile: (cmd: string, args: string[], opts: any, cb: Function) => {
      cp.execCalls.push({ cmd, args, opts });
      Promise.resolve(cp.exec(cmd, args, opts)).then((r: any) => cb(r.err ?? null, r.stdout, r.stderr));
    },
    execFileSync: (...a: any[]) => cp.execFileSync(...a),
    spawn: (...a: any[]) => cp.spawn(...a),
  };
  /** The mocks that put the stand-in in place, each with restore(). */
  const mocks = () => [mock.module('node:child_process', { exports: childProcess }), procPortMock(childProcess)];
  return { cp, mocks };
}
