// Saved local previews restart their real server before a restored browser tab loads its page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DevPreviews, probePort } = require('../electron/capabilities/browser/devPreview.cjs');
const until = async (check: () => Promise<boolean>) => {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('server did not exit');
};

test('a saved live preview survives process shutdown and fresh registry creation', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-restart-'));
  const stateFile = path.join(cwd, 'previews.json');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const first = new DevPreviews({ stateFile, pollMs: 5 });
  t.after(() => first.stopAll());
  const s = first.start('chat', {
    run: [
      process.execPath,
      '-e',
      `require('http').createServer((q,r)=>r.end('restored preview')).listen(0,'127.0.0.1',function(){console.log('http://127.0.0.1:'+this.address().port+'/')})`,
    ],
    display: 'homepage preview',
    cwd,
    project: cwd,
  });
  assert.equal(await first.waitReady(s), 'ready');
  const oldUrl = s.url;
  assert.equal(fs.existsSync(stateFile), true, 'a live link needs its approved launch recipe on disk');
  first.stopAll({ preserveSaved: true });
  await until(async () => !(await probePort(s.port, { host: '127.0.0.1' })));
  const second = new DevPreviews({ stateFile, pollMs: 5, canRestore: async () => true });
  t.after(() => second.stopAll());
  const url = await second.prepare('chat', `${oldUrl}tour?size=phone#demo`);
  assert.equal(await (await fetch(url)).text(), 'restored preview');
  assert.equal(new URL(url).pathname, '/tour');
  assert.equal(new URL(url).search, '?size=phone');
  assert.equal(new URL(url).hash, '#demo');
  assert.equal(second.list('chat').length, 1);
  assert.equal(second.list('chat')[0].id, s.id, 'stop/list/logs retain the restored server identity');
  second.stopChat('chat');
  const third = new DevPreviews({ stateFile });
  assert.equal(third.prepare('chat', oldUrl), null, 'an archived chat cannot resurrect its preview');
});
