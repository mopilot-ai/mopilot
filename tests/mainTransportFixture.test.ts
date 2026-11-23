// Main's wiring fixtures preserve their target OS through readiness and own each load's transport descriptor.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain, unloadMain, withPlatform } from './support/electron-main-harness.ts';

after(() => unloadMain());

test('a macOS wiring fixture registers its desktop actions as macOS even when its test host is Linux', async () => {
  await withPlatform('linux', async () => {
    const h = await loadMain({ platform: 'darwin', before: (h) => h.exists.add('/Applications/Visual Studio Code.app') });
    await h.ready();
    assert.equal((await h.invoke('app:installed')).vscode, true);
    assert.equal(await h.invoke('app:icon', 'vscode'), 'icon:/Applications/Visual Studio Code.app');
  });
});

test('each main load owns its valid transport path and missing transport remains unavailable', async () => {
  await withPlatform('linux', async () => {
    for (const packaged of [false, true]) {
      const h = await loadMain({ packaged, before: (h) => fs.writeFileSync(path.join(h.tmp, 'sage-mcp'), '') });
      await h.ready();
      assert.equal(h.one('SessionMcp').opts.command, path.join(h.tmp, 'sage-mcp'));
      assert.deepEqual(h.one('SessionMcp').opts.args, []);
      assert.deepEqual(h.one('ToolSessions').opts.preloaded(), [], 'browser preloading stays wired alongside the portable transport');
    }
    const missing = await loadMain();
    await missing.ready();
    assert.throws(() => missing.one('SessionMcp'), /no SessionMcp/);
  });
});
