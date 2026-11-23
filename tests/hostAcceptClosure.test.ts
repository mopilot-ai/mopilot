// What the Host's acceptance run (scripts/host-accept.mjs) uploads for its fake ACP agent: every module the agent loads, and the app's own pieces it builds the Host from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureClosure, realDeps } from '../scripts/host-accept.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-accept-closure-')));

test('B: the fake agent is sent with every module it imports, found from the repository itself', () => {
  const files = fixtureClosure('tests/fixtures/fake-acp-agent.mjs', ROOT);
  assert.ok(files.includes('tests/fixtures/fake-acp-agent.mjs') && files.includes('tests/fixtures/acpError.mjs'));
  assert.ok(files.every((f) => fs.existsSync(path.join(ROOT, f))));
  const dir = fs.mkdtempSync(path.join(tmp, 'f-'));
  fs.writeFileSync(path.join(dir, 'a.mjs'), "import { b } from './b.mjs';\nimport { a } from './a.mjs';\nimport x from 'node:fs';\n");
  fs.writeFileSync(path.join(dir, 'b.mjs'), 'export {};\n');
  assert.deepEqual(fixtureClosure('a.mjs', dir), ['a.mjs', 'b.mjs']);
  // CommonJS and dynamic loads count too: a module reached only by require() was left behind and the agent died on start
  fs.writeFileSync(path.join(dir, 'c.mjs'), "import './d.cjs';\nconst e = await import( './e.mjs' );\n");
  fs.writeFileSync(path.join(dir, 'd.cjs'), "const f = require('./f.cjs');\nrequire('node:path');\n");
  fs.writeFileSync(path.join(dir, 'e.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(dir, 'f.cjs'), 'module.exports = {};\n');
  assert.deepEqual(fixtureClosure('c.mjs', dir).sort(), ['c.mjs', 'd.cjs', 'e.mjs', 'f.cjs']);
  assert.deepEqual(fixtureClosure('d.cjs', dir), ['d.cjs', 'f.cjs']);
  assert.ok(files.includes('electron/capabilities/mcp/appTiers.cjs'), 'toolTiers.cjs requires appTiers.cjs');
  const deps = realDeps();
  assert.equal(typeof deps.buildBundle, 'function');
  assert.equal(typeof deps.helloParams().protocol, 'object');
  assert.ok(deps.agentFiles().every((f) => Buffer.isBuffer(f.data)));
  assert.ok(Buffer.isBuffer(deps.readFile(path.join(ROOT, 'host/package.json'))));
});
