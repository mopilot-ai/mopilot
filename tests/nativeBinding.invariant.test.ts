// Native bridge binding identity and the absence of runtime exports in domain contract modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';

// every file under src/lib/native is checked, not only the ones this test imports, so a new port module is held to it
export const GUARDS = ['src/lib/native/', 'src/lib/native.ts', 'src/lib/chatDeletion.ts'];

test('native forwards to the preload bridge and contract modules have no runtime exports', async () => {
  const bridge = { platform: 'darwin', marker: Symbol('preload') };
  const { installNative, installedNative, native } = await import('../src/lib/native.ts');
  const previous = installNative(bridge as any);
  try {
    // the port reads the bridge's own values, not copies
    assert.equal((native as any).marker, bridge.marker);
    assert.equal(native.platform, 'darwin');
    for (const contracts of await Promise.all([
      ...treeFiles('src/lib/native', /\.ts$/)
        .filter((file) => !/^export\s+(?:const|function|class)/m.test(readFileSync(file, 'utf8')))
        .map((file) => import(pathToFileURL(path.resolve(file)).href)),
      import('../src/lib/chatDeletion.ts'),
    ])) {
      // Node supplies interop keys when an erased type-only module is loaded as CommonJS.
      const values = (contracts as any).default ?? contracts;
      assert.deepEqual(Object.keys(values), []);
      assert.ok(Object.keys(contracts).every((key) => key === 'default' || key === 'module.exports'));
    }
    // the port neither copies the bridge nor needs a window: the installed bridge is what it reads
    assert.equal(installedNative(), bridge);
  } finally {
    installNative(previous);
  }
});
