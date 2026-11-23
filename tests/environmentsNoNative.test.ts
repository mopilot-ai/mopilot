// environment.toml (src/lib/environments.ts) in a window without the native bridge: the macOS view.
import { test } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as any).window = {};
const { environmentOf } = await import('../src/lib/environments.ts');
delete (globalThis as any).window;

test('a window without native reads the darwin scripts', () => {
  assert.equal(environmentOf('[setup.darwin]\nscript = "brew"\n[setup.win32]\nscript = "choco"\n').setup.script, 'brew');
});
