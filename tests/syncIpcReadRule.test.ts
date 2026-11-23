// The sync-ipc-read lint guard (lint/rules/sync-ipc-read.grit): a whole file read, folder listing or process run
// synchronously inside an ipcMain handler warns; the asynchronous forms, and synchronous calls outside a handler, do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a synchronous read or process run in an IPC handler warns, other reads stay valid', () => {
  for (const [input, expected] of [
    ["ipcMain.handle('fs:image', (_e, p) => fs.readFileSync(p).toString('base64'));", 1],
    ["ipcMain.handle('fs:list', (_e, p) => { const names = readdirSync(p); return names; });", 1],
    ["ipcMain.handle('img:png', (_e, p) => cp.execFileSync('/usr/bin/sips', [p]));", 1],
    ["ipcMain.handle('fs:image', async (_e, p) => (await fs.promises.readFile(p)).toString('base64'));", 0],
    ["ipcMain.handle('img:png', (_e, p) => new Promise((r) => cp.execFile('/usr/bin/sips', [p], r)));", 0],
    ["const text = fs.readFileSync(file, 'utf8');", 0],
    ["other.handle('fs:image', (_e, p) => fs.readFileSync(p));", 0],
  ] as const) {
    const report = lintFixtures({ 'electron/app/ipc.cjs': `const fs = require('node:fs');\n${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[sync-ipc-read]'));
    assert.equal(hits.length, expected, input);
  }
});
