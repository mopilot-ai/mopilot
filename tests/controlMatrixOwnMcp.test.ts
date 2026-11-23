// CM-K42: the user's own MCP servers on every basic harness (#1575): each one either turns them off for MoPilot's
// chats through its own layered config (both halves of its quirk's mcp) or reads as not supported with where to turn
// them off; reading them never writes the user's settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/harness/'];

const require = createRequire(import.meta.url);
const Q = require('../electron/harness/quirks/index.cjs');
const { OwnMcp } = require('../electron/harness/acp/ownMcp.cjs');

test('CM-K42: every basic harness turns its own MCP servers off for MoPilot only, or says it cannot; none writes the user settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmk42-'));
  const dir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), '{"mcp": {"rea": {"type": "local", "command": ["x"]}}}');
  const env = { HOME: home };
  const own = new OwnMcp({ quirksOf: Q.quirks, prefs: () => ({ acpMcp: {} }), env: () => env });
  const ids = Q.ids({ packaged: false, env: { MOPILOT_FLAGS: '' } });
  assert.ok(ids.includes('opencode'));
  let supported = 0;
  for (const id of ids) {
    const q = Q.quirks(id);
    const s = own.status(id);
    assert.equal(s.supported, !!q.mcp, id);
    if (!q.mcp) {
      assert.deepEqual(s.servers, [], `${id}: nothing listed it can't act on`);
      continue;
    }
    supported++;
    assert.deepEqual(Q.validate(q), [], `${id}: admitted with its mcp`);
    assert.equal(typeof q.mcp.servers, 'function', `${id}: lists the servers`);
    assert.equal(typeof q.mcp.off, 'function', `${id}: has a layer that turns them off`);
    const layer = q.mcp.off(s.servers.map((m: any) => m.name));
    assert.ok(layer && typeof layer === 'object' && Object.keys(layer).length > 0, `${id}: the layer is env`);
  }
  assert.ok(supported >= 1, 'opencode turns its servers off');
  assert.deepEqual(own.status('opencode').servers, [{ name: 'rea', enabled: true, off: false, managed: false }]);
  assert.equal(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'), '{"mcp": {"rea": {"type": "local", "command": ["x"]}}}');
  assert.deepEqual(fs.readdirSync(dir), ['opencode.json']);
});

test('CM-K42: a quirks file offering half of it (a list with no layer, or the reverse) is not admitted', () => {
  const base = Q.quirks('opencode');
  assert.deepEqual(Q.validate({ ...base, mcp: { servers: () => [] } }), ['mcp']);
  assert.deepEqual(Q.validate({ ...base, mcp: { off: () => ({}) } }), ['mcp']);
  assert.deepEqual(Q.validate({ ...base, mcp: 'yes' }), ['mcp']);
  assert.deepEqual(Q.validate({ ...base, mcp: undefined }), []);
});
