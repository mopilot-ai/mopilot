// opencode's isolation quirk (#2278): MoMo's opencode process runs with every tool but MoPilot's own denied on its
// one agent, its own config folder with only the user's providers and models carried over, project and Claude Code
// instructions off, and no start while ~/.opencode holds settings of its own.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-iso-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const folder = () => fs.mkdtempSync(path.join(tmp, 'f-'));

test('opencode’s isolation: every tool but MoPilot’s denied on MoMo’s only agent, its instructions and settings off', () => {
  const quirks = require('../electron/harness/quirks/index.cjs');
  const { ISOLATED_CONFIG, MOMO_ONLY } = require('../electron/harness/quirks/opencodeIsolation.cjs');
  const q = quirks.quirks('opencode');
  assert.deepEqual(quirks.validate(q), []);
  const data = folder();
  // the user's own settings: their providers and models are carried over, nothing else is
  const home = folder();
  const userConfig = path.join(home, '.config', 'opencode');
  fs.mkdirSync(userConfig, { recursive: true });
  fs.writeFileSync(
    path.join(userConfig, 'opencode.json'),
    JSON.stringify({
      model: 'local/m1',
      provider: { local: { name: 'Local' } },
      mcp: { rea: {} },
      instructions: ['x.md'],
      agent: { build: {} },
    }),
  );
  fs.writeFileSync(
    path.join(userConfig, 'opencode.jsonc'),
    '{ // later\n "provider": { "other": { "name": "O" } }, "small_model": "local/s" }',
  );
  fs.writeFileSync(path.join(userConfig, 'config.json'), '{not json');
  // opencode's own binaries in ~/.opencode are no settings
  fs.mkdirSync(path.join(home, '.opencode', 'bin'), { recursive: true });
  const env = q.isolation.env({ dataDir: data, env: { HOME: home } });
  const config = path.join(data, 'isolated', 'opencode', 'config');
  assert.equal(env.XDG_CONFIG_HOME, config);
  assert.equal(fs.statSync(config).mode & 0o777, 0o700);
  for (const k of ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT'])
    assert.equal(env[k], '1', k);
  for (const k of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_PERMISSION']) assert.equal(env[k], '', k);
  const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  const { provider, model, small_model, ...rest } = content;
  assert.deepEqual(
    { provider, model, small_model },
    {
      provider: { local: { name: 'Local' }, other: { name: 'O' } },
      model: 'local/m1',
      small_model: 'local/s',
    },
  );
  assert.deepEqual(rest, JSON.parse(JSON.stringify(ISOLATED_CONFIG)));
  // settings of its own in ~/.opencode, which opencode always loads: MoMo's process doesn't start
  fs.mkdirSync(path.join(home, '.opencode', 'plugin'));
  assert.throws(() => q.isolation.env({ dataDir: data, env: { HOME: home } }), /has settings of its own \(plugin\)/);
  // no user settings at all, the home folder from the system
  const none = JSON.parse(q.isolation.env({ dataDir: data, env: {} }, { exists: () => false, read: () => '{}' }).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(none, JSON.parse(JSON.stringify(ISOLATED_CONFIG)));
  assert.deepEqual(MOMO_ONLY, { '*': 'deny', 'sage_*': 'allow' });
  assert.deepEqual(content.agent.momo.permission, MOMO_ONLY);
  assert.deepEqual(content.permission, MOMO_ONLY);
  assert.equal(content.default_agent, 'momo');
  for (const a of ['build', 'plan', 'general', 'explore']) assert.equal(content.agent[a].disable, true, a);
  assert.equal(content.share, 'disabled');
  assert.deepEqual(q.isolation.mode, { configOption: 'mode', value: 'momo' });
  assert.throws(() => q.isolation.env({ dataDir: null }), /no folder of its own/);
  // the coding process's config is unchanged: MoPilot's own modes, nothing denied
  assert.equal(JSON.parse(q.env.OPENCODE_CONFIG_CONTENT).agent.momo, undefined);
});
