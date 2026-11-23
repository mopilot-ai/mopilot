// The open-mode lint guard (lint/rules/open-mode.grit, #2144): any write or mkdir with a plain fs call and no mode
// warns, whatever its path names (a store writing to this.file included); an explicit mode and the private helpers do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a write or mkdir without a mode warns wherever it writes; a mode or the private helpers stay valid', () => {
  for (const [input, expected] of [
    ['fs.writeFileSync(this.file, JSON.stringify(list));', 1],
    ["fs.writeFileSync(path.join(userData, 'notes.json'), body, 'utf8');", 1],
    ["fs.mkdirSync(path.join(app.getPath('userData'), 'shots'), { recursive: true });", 1],
    ['fs.appendFileSync(this.log, line);', 1],
    ['await fs.promises.writeFile(file, s, { flag: "wx" });', 1],
    ['await fsp.mkdir(dir, { recursive: true });', 1],
    ['fs.createWriteStream(part, { flags: "a" });', 1],
    ['fs.writeFileSync(file, body, { mode: 0o600 });', 0],
    ['fs.mkdirSync(dir, { recursive: true, mode: 0o700 });', 0],
    ['fs.writeFileSync(manifest, text, { mode });', 0],
    ['mkdirPrivate(dir);', 0],
    ['writeAtomic(file, s);', 0],
    ['writePrivate(file, s);', 0],
    ['fs.copyFileSync(src, dst);', 0],
    // a store's own writeFile (MoMo's encrypted memory store) is not a file-system call
    ['await store.writeFile(name, text);', 0],
    ['this.memory.mkdir(name);', 0],
    // file systems under other names still warn
    ['this.fs.writeFileSync(file, body);', 1],
    ['fileFs.mkdirSync(dir);', 1],
    ['await fsPromises.appendFile(file, line);', 1],
    ['fsm.mkdirSync(dir, { recursive: true });', 1],
    ['this.fsSync.mkdirSync(this.dir, { recursive: true });', 1],
    ['await p.mkdir(path.dirname(file), { recursive: true });', 1],
    // an open FileHandle: the open() that made the file is not checked, so its write is
    ['await handle.writeFile(JSON.stringify(record));', 1],
    ['writeFileSync(file, body);', 1],
  ] as const) {
    const report = lintFixtures({ 'electron/store.cjs': `${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[open-mode]'));
    assert.equal(hits.length, expected, input);
  }
});
