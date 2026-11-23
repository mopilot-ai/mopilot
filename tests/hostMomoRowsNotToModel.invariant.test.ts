// The rows of MoMo's chat hold text a session or a source wrote (a task's summary, a watch's detail): untrusted, shown to the owner on their devices and never fed to a model. So the only code that reads rows is the store itself and the wire method that serves them to the owner's devices; anything else that reads them (a context provider, a brief, a check) would hand a model text it must treat as data without a taint step, and fails here by file name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
/** The files that may read rows: the store, the wire method that serves them to a paired owner device, and the wiring that makes the store. */
const MAY_READ = new Set(['host/src/momoRows.mjs', 'host/src/methods/momoRows.mjs', 'host/src/momoWiring.mjs', 'host/src/momoHome.mjs']);
/** What reading the rows looks like: the store's `list` or `onRow`, or its sealed file. Writing them (`home.rows.put`, by the gate and the tasks' sink) is how rows get there, and is not reading. */
const READS = /\brows\??\.(?:list|onRow)\(|chat-rows\.json/;

const filesUnder = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(rel) : /\.(?:mjs|cjs|js)$/.test(e.name) ? [rel] : [];
  });

test('nothing but the rows store and its wire method reads the rows, so no row’s text reaches a model', () => {
  const files = [...filesUnder('host/src'), ...filesUnder('shared')].filter((f) => !f.endsWith('.d.mts'));
  assert.ok(files.length > 100 && files.includes('host/src/momoRows.mjs'), `scanned ${files.length} files`);
  const readers = files.filter((f) => READS.test(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '')));
  assert.deepEqual(
    readers.filter((f) => !MAY_READ.has(f)),
    [],
    'a file reads MoMo’s rows: it must not, or it must take them through a taint step and be listed here with the reason',
  );
});
