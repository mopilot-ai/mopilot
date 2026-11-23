// Packaging failures remain nonzero even when a builder's teardown listener resets the process exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { packageExit } from '../scripts/package-exit.mjs';

test('a packaging success preserves another failure, while a failure survives conflicting teardown', () => {
  const proc = Object.assign(new EventEmitter(), { exitCode: 7 });
  packageExit(0, proc as any);
  assert.equal(proc.exitCode, 7);
  assert.equal(proc.listenerCount('exit'), 0);
  proc.once('exit', () => {
    proc.exitCode = 0;
  });
  packageExit(1, proc as any);
  assert.equal(proc.exitCode, 1);
  proc.emit('exit');
  assert.equal(proc.exitCode, 1);
});

test('the real Linux packaging CLI fails when its builder omits artifacts, despite a conflicting teardown listener', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'package-exit-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const app = path.join(temp, 'out/MoPilot-linux-x64');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'mopilot'), 'fixture');
  const entry = new URL('../scripts/package-linux.mjs', import.meta.url);
  const builder = createRequire(import.meta.url).resolve('electron-builder');
  const script = [
    "import { mock } from 'node:test';",
    "import { fileURLToPath } from 'node:url';",
    `mock.module(${JSON.stringify(builder)}, { namedExports: {
      build: async () => { process.once('exit', () => { process.exitCode = 0; }); },
      Platform: { LINUX: { createTarget: () => ({}) } }, Arch: { x64: 1 },
    } });`,
    `process.argv = [process.execPath, fileURLToPath(${JSON.stringify(entry.href)}), '--arch', 'x64'];`,
    `await import(${JSON.stringify(entry.href)});`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], {
    cwd: temp,
    encoding: 'utf8',
  });
  assert.match(result.stderr, /electron-builder finished without/);
  assert.equal(result.status, 1, 'A missing distribution must fail npm/CI, including after builder teardown.');
});

test('app-folder and Windows packaging CLIs propagate failed validation without starting a build', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'package-exit-siblings-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const [name, args, error] of [
    ['package.mjs', ['--platform', 'unsupported'], /Unsupported --platform/],
    ['package-win.mjs', [], /not found/],
  ] as const) {
    const entry = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: temp, encoding: 'utf8' });
    assert.match(result.stderr, error);
    assert.equal(result.status, 1);
  }
});
