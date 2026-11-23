// A harness that can't start fails, through the Rust core's spawn in the running app, with the code Node's own spawn gives
// on this platform (electron/platform/coreChild.cjs): a missing path, a folder, a quoted path, a file that is no program;
// and a folder with a program beside it by its name runs that program on Windows, as Node's does.
// The unit test beside it (tests/coreBindingSpawn.test.ts) runs where unit tests run; this one also runs on Windows (win-e2e.yml).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

test('a spawn that cannot start says what Node says, through the core', async ({ harness }) => {
  const dir = path.join(harness.dir, 'spawn-failures');
  fs.mkdirSync(dir);
  const win = process.platform === 'win32';
  // a file that is no program: on Windows under a name Node's search takes as it is, elsewhere one with no exec bit
  const noProgram = path.join(dir, win ? 'empty.exe' : 'text');
  fs.writeFileSync(noProgram, win ? '' : 'not a program', { mode: 0o644 });
  // a folder `codex` with `codex.exe` beside it: Windows runs codex.exe (a copy of cmd.exe there), POSIX refuses the folder
  const beside = path.join(dir, 'beside');
  fs.mkdirSync(path.join(beside, 'codex'), { recursive: true });
  if (win) fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), path.join(beside, 'codex.exe'));
  else fs.writeFileSync(path.join(beside, 'codex.exe'), 'not a program');
  const cases: [string, string[]][] = [
    [path.join(dir, win ? 'missing.exe' : 'missing'), []],
    [dir, []],
    [`"${path.join(dir, 'codex.exe')}"`, []],
    [noProgram, []],
    [path.join(beside, 'codex'), ['/d', '/c', 'exit 3']],
  ];
  const entry = path.resolve(__dirname, '../../electron/platform/coreChild.cjs');
  const results = await harness.app.evaluate(
    async (_electron, { entry, cases }) => {
      const require = process.getBuiltinModule('module').createRequire(entry);
      const { spawnCore } = require(entry);
      const childProcess = process.getBuiltinModule('child_process');
      const failure = (spawn: any, bin: string, args: string[]) =>
        new Promise((resolve) => {
          try {
            const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
            child.on('error', (e: any) => resolve([e.code, e.syscall]));
            child.on('exit', (code: number) => resolve(['ran', code]));
          } catch (e: any) {
            resolve(['thrown', e.code, e.syscall]);
          }
        });
      const out = [];
      for (const [bin, args] of cases)
        out.push({ bin, core: await failure(spawnCore, bin, args), node: await failure(childProcess.spawn, bin, args) });
      return out;
    },
    { entry, cases },
  );
  for (const r of results) expect(r.core, r.bin).toEqual(r.node);
  // the folder with a program beside it ran that program, on Windows
  if (win) expect(results.at(-1)!.core).toEqual(['ran', 3]);
});
