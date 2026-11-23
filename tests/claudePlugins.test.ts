// Claude native plugin delivery, legacy CLI fallback and folder-release lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, until, tmp, lastQuery } from './support/electron-claude.ts';
const bin = fakeBin('plugins/claude');
const user = (text: string) => ({ role: 'user', content: text });

test("MoPilot's plugins: each folder goes to the SDK's plugins option, is let go when the process ends, and a failed delivery doesn't stop the session", async () => {
  const t = load();
  const released: string[] = [];
  const asked: any[] = [];
  let mode = 'deliver';
  t.claude.setPlugins({
    markNative: () => undefined,
    forClaude: async (o: any) => {
      asked.push(o);
      if (mode === 'fail') throw new Error('store unreadable');
      return {
        plugins: [{ type: 'local', path: '/plugins/tidy' }],
        alreadyOn: [],
        withheld: [{ id: 'odd@acme', why: 'changed since trusted' }],
        release: () => released.push('tidy'),
      };
    },
  });
  const cwd = fs.mkdtempSync(path.join(tmp, 'plugins-'));
  await t.claude.send('claude:plugins', { bin, sessionId: 'plugins', ephemeral: true, cwd }, user('hi'));
  const q = lastQuery();
  // its settings read (the init message) carries whether it loaded the plugin folders: the plugins probe
  q.push({ type: 'system', subtype: 'init', session_id: 'plugins' });
  await until('settings read', () => t.claude.appliedOf('claude:plugins'));
  assert.equal(t.claude.appliedOf('claude:plugins').pluginDirs, true);
  assert.deepEqual(q.options.plugins, [{ type: 'local', path: '/plugins/tidy' }]);
  assert.equal(asked[0].cwd, cwd);
  assert.equal(released.length, 0);
  await t.call('claude:control', 'claude:plugins', 'close');
  await until('the plugin folders were let go', () => released.length === 1);

  mode = 'fail';
  await t.claude.send('claude:plugins-off', { bin, sessionId: 'plugins-off', ephemeral: true, cwd }, user('hi'));
  assert.equal(lastQuery().options.plugins, undefined);
  await t.call('claude:control', 'claude:plugins-off', 'close');
});

test('a Claude Code too old for --plugin-dir starts without plugins; its --help is asked once per binary', async () => {
  const t = load();
  const old = fakeBin('old/claude');
  const silent = fakeBin('silent/claude');
  fakes.helps[old] = '  --model <model>\n';
  fakes.helps[silent] = null;
  let asked = 0;
  const native: [string, boolean][] = [];
  t.claude.setPlugins({
    markNative: (f: string, ok: boolean) => void native.push([f, ok]),
    forClaude: async () => {
      asked++;
      return { plugins: [{ type: 'local', path: '/p' }], alreadyOn: [], withheld: [], release: () => undefined };
    },
  });
  await t.claude.send('claude:old', { bin: old, sessionId: 'old', ephemeral: true }, user('hi'));
  assert.equal(lastQuery().options.plugins, undefined);
  await t.call('claude:control', 'claude:old', 'close');
  await t.claude.send('claude:silent', { bin: silent, sessionId: 'silent', ephemeral: true }, user('hi'));
  assert.equal(lastQuery().options.plugins, undefined);
  await t.call('claude:control', 'claude:silent', 'close');
  assert.equal(asked, 0, 'nothing is held for a CLI that cannot load it');
  assert.deepEqual(
    native,
    [
      ['claude', false],
      ['claude', false],
    ],
    'while it cannot, plugin_skills serves them',
  );
  // the answer is kept: changing what --help says doesn't change it until the binary changes
  fakes.helps[old] = '  --plugin-dir <path>\n';
  await t.claude.send('claude:old2', { bin: old, sessionId: 'old2', ephemeral: true }, user('hi'));
  assert.equal(lastQuery().options.plugins, undefined);
  await t.call('claude:control', 'claude:old2', 'close');
  fs.utimesSync(old, new Date(), new Date(Date.now() + 5000));
  await t.claude.send('claude:old3', { bin: old, sessionId: 'old3', ephemeral: true }, user('hi'));
  assert.deepEqual(lastQuery().options.plugins, [{ type: 'local', path: '/p' }]);
  await t.call('claude:control', 'claude:old3', 'close');
});

test("a CLI binary that can't be looked at is asked under its path alone", async () => {
  const { createCli } = await import('../electron/harness/claude/cli.cjs');
  const cli = createCli({} as never, { cleanEnv: () => ({}) } as never);
  const gone = path.join(tmp, 'gone', 'claude');
  assert.equal(await cli.takesPluginDirs(gone), true);
  fakes.helps[gone] = '';
  assert.equal(await cli.takesPluginDirs(gone), true, 'kept under its path');
});

test('a session whose SDK query fails to start lets go of its plugin folders', async () => {
  const t = load();
  let released = 0;
  t.claude.setPlugins({
    markNative: () => undefined,
    forClaude: async () => ({ plugins: [], alreadyOn: [], withheld: [], release: () => void released++ }),
  });
  const sdkQuery = fakes.sdk.query;
  fakes.sdk.query = () => {
    throw new Error('bad option');
  };
  try {
    await assert.rejects(t.claude.send('claude:broken', { bin, sessionId: 'broken', ephemeral: true }, user('hi')), /bad option/);
  } finally {
    fakes.sdk.query = sdkQuery;
  }
  assert.equal(released, 1);
});
