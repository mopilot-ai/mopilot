// Always-selected app guards for structured identity and validated authentication boundary records.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { treeFiles } from '../scripts/source-tree.mjs';
import { identityKey } from '../shared/identityKey.mjs';

const { parseClaudeStatus } = createRequire(import.meta.url)('../electron/harness/claude/status.cjs');

test('identity owners preserve tuple boundaries, empty values and opaque characters', () => {
  const tuples = [
    ['a:b', 'c'],
    ['a', 'b:c'],
    ['a', '', 'b'],
    ['a', 'b', ''],
    ['', 'a', 'b'],
    ['a', null, 'b'],
    ['a', 'null', 'b'],
    ['a', 'b'],
    ['a|b', 'c'],
    ['a', 'b|c'],
    ['quote"', '\\slash'],
    ['quote', '"\\slash'],
  ];
  const keys = tuples.map((parts) => identityKey(...parts));
  assert.equal(new Set(keys).size, tuples.length);
});

test('authentication boundaries reject malformed statuses while preserving valid optional fields', () => {
  for (const text of ['{', 'null', '[]', '{}', '{"loggedIn":"false"}', '{"loggedIn":true,"email":42}'])
    assert.throws(() => parseClaudeStatus(text), TypeError, text);
  for (const value of [{ loggedIn: false }, { loggedIn: true, email: null }, { loggedIn: true, email: 'a@test', extra: 1 }])
    assert.deepEqual(parseClaudeStatus(JSON.stringify(value, null, 2)), value);
});

/**
 * A reader of the document selection that only listens for events is left standing on one stale read: the event
 * fires once, and nothing makes it look again when the transcript moves under it (#1245, stuck state). Every such
 * reader must also observe the DOM it reads, through `watchTranscript` or an observer of its own.
 */
async function selectionReaders(root: URL, read = (file: URL) => readFile(file, 'utf8')) {
  const dir = fileURLToPath(root);
  const readers: string[] = [];
  for (const source of treeFiles(dir, /\.tsx?$/)) {
    const file = path.relative(dir, source).replaceAll('\\', '/');
    const text = await read(pathToFileURL(source));
    // any spelling of the event, so a reader that registers it another way cannot slip past this guard
    if (!text.includes('selectionchange')) continue;
    readers.push(file);
    assert.match(
      text,
      /watchTranscript|new (?:Resize|Mutation|Intersection)Observer/,
      `${file} reads the selection but never looks again when its container changes`,
    );
  }
  return readers;
}

test('every reader of the document selection also observes the DOM it reads', async () => {
  const readers = await selectionReaders(new URL('../src/', import.meta.url));
  // the scan itself has to keep finding things: these two read the selection today
  for (const known of ['components/thread/SelectionToolbar.tsx', 'components/thread/view/turnWindow.tsx'])
    assert.ok(readers.includes(known), `${known} was not scanned`);
});

async function sourceFixture(t: TestContext, files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'selection-readers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = pathToFileURL(`${dir}${path.sep}`);
  for (const [file, text] of Object.entries(files)) {
    const source = path.join(dir, file);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, text);
  }
  return root;
}

test('selection scan ignores hidden fixtures deleted between listing and reading', async (t) => {
  const root = await sourceFixture(t, {
    '.lint-fixture-race/view.tsx': 'selectionchange',
    'nested/.lint-fixture-live/view.tsx': 'selectionchange watchTranscript',
    'node_modules/pkg/view.tsx': 'selectionchange watchTranscript',
    'nested/reader.tsx': 'selectionchange watchTranscript',
    'plain.ts': 'no selection events',
    'notes.md': 'selectionchange',
  });
  const reads: string[] = [];
  const readers = await selectionReaders(root, async (file) => {
    await rm(new URL('.lint-fixture-race/', root), { recursive: true, force: true });
    reads.push(file.href.slice(root.href.length));
    return readFile(file, 'utf8');
  });
  assert.deepEqual(readers, ['nested/reader.tsx']);
  assert.deepEqual(reads.sort(), ['nested/reader.tsx', 'plain.ts']);
  // The scanner leaves other tests' live fixtures untouched.
  assert.equal(await readFile(new URL('nested/.lint-fixture-live/view.tsx', root), 'utf8'), 'selectionchange watchTranscript');
});

test('selection scan still rejects a visible reader with no DOM observer', async (t) => {
  const root = await sourceFixture(t, { 'nested/bad.tsx': 'selectionchange' });
  await assert.rejects(selectionReaders(root), /nested\/bad\.tsx reads the selection but never looks again/);
});

test('selection scan propagates a visible source read failure', async (t) => {
  const root = await sourceFixture(t, { 'reader.ts': 'selectionchange watchTranscript' });
  await assert.rejects(
    selectionReaders(root, async (file) => {
      await rm(file);
      return readFile(file, 'utf8');
    }),
    { code: 'ENOENT' },
  );
});

test('selection scan preserves filesystem names with URL-special characters', async (t) => {
  const root = await sourceFixture(t, { 'reader # ? %.tsx': 'selectionchange watchTranscript' });
  assert.deepEqual(await selectionReaders(root), ['reader # ? %.tsx']);
});
