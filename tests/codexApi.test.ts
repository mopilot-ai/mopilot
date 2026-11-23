import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { installNativeStub } from './support/ports/native.ts';

// The typed Codex calls a window makes: each forwards its name and arguments to main's adapter
// (native.codex.api), and none is sent while Codex is idle. The real native bridge reads window.native.
const calls: unknown[][] = [];
const fixture = { idle: false };
(globalThis as any).__codexApiFixture = fixture;
(globalThis as any).window = {
  native: { codex: { api: async (name: string, args: unknown[]) => (calls.push([name, args]), { requirements: null }) } },
};
// the window's bridge, installed in the native port (src/lib/native.ts)
installNativeStub((globalThis as any).window.native);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './codex' && context.parentURL?.endsWith('/adapters/codexApi.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export const codexLeftIdle=()=>globalThis.__codexApiFixture.idle;' };
    }
    // the bundler resolves extensionless imports; load the real bridge module
    if (specifier === '../../lib/native' && context.parentURL?.endsWith('/adapters/codexApi.ts')) {
      return { shortCircuit: true, url: new URL('../src/lib/native.ts', import.meta.url).href };
    }
    return next(specifier, context);
  },
});
const { codexApi } = await import('../src/harness/adapters/codexApi.ts');

test('configRequirementsRead asks main for Codex requirements by name', async () => {
  assert.deepEqual(await codexApi.configRequirementsRead(), { requirements: null });
  assert.deepEqual(calls, [['configRequirementsRead', []]]);
});

test('no call reaches Codex while it is idle', async () => {
  fixture.idle = true;
  await assert.rejects(codexApi.configRequirementsRead(), /Codex isn't started/);
  assert.equal(calls.length, 1);
  fixture.idle = false;
});
