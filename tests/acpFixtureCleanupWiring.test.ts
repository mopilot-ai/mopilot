// The real ACP fixture stops its producers and drains owned transcripts before removing their directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('the ACP fixture awaits every owned transcript after stopping its hosts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cleanup-repro-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cleanup.test.mts');
  const fixture = new URL('./support/acp-host/fixture.ts', import.meta.url).href;
  const register = new URL('./support/register.ts', import.meta.url).pathname;
  fs.writeFileSync(
    file,
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, dir } from ${JSON.stringify(fixture)};
test('a pending transcript outlives the last assertion', () => {
  const { host, items } = setup();
  let stopped = false;
  let drained = false;
  host.closeAll = () => { stopped = true; };
  items.drain = async () => {
    assert.equal(stopped, true, 'stop producers before draining');
    await new Promise(resolve => setImmediate(resolve));
    drained = true;
  };
  const remove = fs.rmSync;
  fs.rmSync = (target, ...args) => {
    if (target === dir) assert.equal(drained, true, 'await the transcript before directory removal');
    return remove(target, ...args);
  };
});
`,
  );
  const result = spawnSync(process.execPath, ['--test', '--import', register, file], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
});
