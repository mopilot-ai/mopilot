// Whole-repository guard: every agent the app can offer for a Host has its modules in the Host bundle and the unpacked bundle's detection finds it (a quirk file loaded by a computed name once went missing, and Kimi, Gemini and the rest read "not installed" on a real Host).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { ACP_PUBLIC_IDS } from '../shared/harnessCatalog.mjs';
const require = createRequire(import.meta.url);
const { buildBundle, hostFiles } = require('../electron/host/bundle.cjs');
const quirks = require('../electron/harness/quirks/index.cjs');

const ROOT = path.join(import.meta.dirname, '..');
const QUIRKS_DIR = path.join(ROOT, 'electron/harness/quirks');

test('every quirk module the app can load for an agent is in the Host bundle file list', () => {
  const listed = new Set(hostFiles(ROOT));
  const onDisk = fs.readdirSync(QUIRKS_DIR).filter((f) => f.endsWith('.cjs'));
  assert.ok(onDisk.length > 10);
  for (const f of onDisk) assert.ok(listed.has(`electron/harness/quirks/${f}`), `${f} is not in the Host bundle`);
});

test('detection inside the unpacked bundle finds every offered agent whose CLI is on PATH, and reports the rest as missing', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-bundle-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const built = buildBundle({ root: ROOT, outDir: path.join(tmp, 'out') });
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  assert.equal(spawnSync('tar', ['-xzf', built.file, '-C', home]).status, 0);
  const fakeBin = path.join(tmp, 'bin');
  fs.mkdirSync(fakeBin);
  for (const id of ACP_PUBLIC_IDS)
    for (const b of quirks.quirks(id).bins) fs.writeFileSync(path.join(fakeBin, b), '#!/bin/sh\n', { mode: 0o755 });
  const probe = `import { acpHarnesses } from ${JSON.stringify(path.join(home, 'host/src/acp.mjs'))};
console.log(JSON.stringify(acpHarnesses({ dataDir: ${JSON.stringify(path.join(tmp, 'data'))}, env: { PATH: process.env.PROBE_PATH } })));`;
  const detect = (probePath: string) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, PROBE_PATH: probePath },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as { id: string; bin: string | null }[];
  };
  const found = detect(fakeBin);
  for (const id of ACP_PUBLIC_IDS) assert.ok(found.find((h) => h.id === id)?.bin, `${id} is not detected inside the bundle`);
  const none = detect(path.join(tmp, 'empty'));
  for (const id of ACP_PUBLIC_IDS) assert.equal(none.find((h) => h.id === id)?.bin, null, `${id} reads as missing, not as a broken bundle`);
});
