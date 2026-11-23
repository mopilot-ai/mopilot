// The Linux Chrome native host gate must be fed the real app.isPackaged: main's wiring passes it from `app`, never a constant (a packaged build must never open the gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const tools = fs.readFileSync(new URL('../electron/app/browserTools.cjs', import.meta.url), 'utf8');
const relay = fs.readFileSync(new URL('../electron/app/chromeRelay.cjs', import.meta.url), 'utf8');

test('the Chrome host gate is computed from app.isPackaged in the real wiring, not a constant', () => {
  assert.match(tools, /files:\s*\{[^}]*\bpackaged:\s*app\.isPackaged\b/);
  assert.doesNotMatch(tools, /packaged:\s*(true|false)\b/);
  assert.match(relay, /linuxE2E:\s*linuxHostEnabled\(\{\s*packaged\b/);
  assert.match(relay, /binary:\s*sageMcpPath\(\{\s*packaged\s*\}\)/);
});
