// What the Rust core owns has no JS copy to come back to (docs/architecture/rust-core.md). Line framing of a stream is the
// core's (core/crates/framing; electron/transport/jsonReader.cjs reads it): no product source frames a stream's lines itself.
// Nor does one batch a stream: the stream batcher's queues, keys and joins are the core's (core/crates/batcher).
// A chat record's commit is the core's too (core/crates/store, store.writeRecord): no JS writer writes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
/** The product's JS: main, the Host, the shared modules and the window. Tests, scripts and benches are not the product. */
const PRODUCT = ['electron', 'host/src', 'shared', 'src'];
const SOURCE = /\.(?:c|m)?[jt]sx?$/;

const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.name === 'node_modules'
        ? []
        : e.isDirectory()
          ? files(path.join(dir, e.name))
          : SOURCE.test(e.name)
            ? [path.join(dir, e.name)]
            : [],
    );
const product = () =>
  PRODUCT.flatMap((dir) => files(path.join(root, dir))).map((file) => [path.relative(root, file).replaceAll('\\', '/'), file]);

/**
 * The framer JS had: its names and its files. They were the transport's own and nothing else's, so naming one is bringing it
 * back, never a coincidence (word-bounded, so `JsonInputs` or `MyLineFramerTest` are not them).
 */
const OLD_FRAMER = /\b(?:LineFramer|JsonInput)\b|jsonLines\.mjs|jsonInput\.cjs|jsonWorker\.cjs/;

/**
 * Framing a stream: searching a buffer for its first newline from the start, again after each line is cut off its front
 * (`for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n'))`, or `while ((i = buf.indexOf(10)) >= 0)`). The second
 * search names the same buffer with the newline as its only argument: a scan of fixed text passes where to go on from
 * (`indexOf('\n', i + 1)`), so it never matches; only a buffer whose front is cut away between searches is read this way.
 */
const NEWLINE = String.raw`(?:'\\n'|"\\n"|10|0x0a|0xa)`;
const RESCAN = new RegExp(
  String.raw`(?:([\w.$]+)\.indexOf\(${NEWLINE}\)\s*;\s*\w+\s*>=\s*0\s*;\s*\w+\s*=\s*\1\.indexOf\(${NEWLINE}\))` +
    String.raw`|(?:while\s*\(\s*\(\s*\w+\s*=\s*[\w.$]+\.indexOf\(${NEWLINE}\)\s*\)\s*(?:>=\s*0|!==?\s*-1))`,
);

/**
 * Framing a stream by carrying what follows its last newline: the carried piece joined to the next chunk, then split at
 * newlines (`(partial + text).split('\n')`, or a CR-aware pattern), whose last piece becomes the next carry. Fixed text has
 * nothing before it to join, so a split of one string never matches; only a remainder kept between chunks reads this way.
 * The parentheses group the join: a call's (`text.slice(a + b).split`) is not one.
 */
const SPLIT = new RegExp(String.raw`(?<![\w$)\]])\(\s*[\w.$]+\s*\+[^;\n]*?\)\.split\(\s*(?:'\\n'|"\\n"|/\\r\?\\n(?:\|\\r)?/|/\\n/)\s*\)`);

/** Framing a stream with Node's readline, which cuts lines in JS: whatever its input, it is a reader of lines. */
const READLINE = /\bcreateInterface\s*\(/;

const SHAPES = [RESCAN, SPLIT, READLINE];

/**
 * Sources that still cut lines in JS, each with why, for their own port: none is a harness's or a tool's JSON stream (Stage
 * 4.2 moved those). The test fails when one stops matching, so the list only shrinks.
 */
const NOT_YET: Record<string, string> = {
  'host/src/server.mjs': "the Host's control socket for its CLI, whose line limit changes once a client is paired",
  'electron/harness/codexRemoteControl.cjs': "Codex's stderr log text, of which an unended line keeps its last 2,000 units",
  'electron/harness/acp/providerErrors.cjs': "an ACP harness's stderr logfmt text, CRLF, each line cut at 8,000 units",
  'host/src/login.mjs': "a sign-in's prose output, read for links and codes with its unended last line",
  'host/src/agentInstall.mjs': "npm's output, cut at a lone CR too for its progress, with its unended last line",
  'electron/platform/searchText.cjs': "ripgrep's output, whose unended last line is read at its close",
  'electron/platform/claudeCompactedHistory.cjs': "a Claude transcript file read line by line (the transcript crate's to take)",
  'electron/platform/claudeTranscriptNotices.cjs': "a Claude transcript file read line by line (the transcript crate's to take)",
  'host/src/cliLogin.mjs': "a person's typed answer at a terminal",
};
const frames = (text: string) => SHAPES.some((shape) => shape.test(text));

test('no product source frames a stream in JS, or brings back the framer it had', () => {
  const found = product().flatMap(([rel, file]) => {
    const text = fs.readFileSync(file, 'utf8');
    return [
      ...(OLD_FRAMER.test(text) ? [`${rel}: the old JS framer`] : []),
      ...(frames(text) && !NOT_YET[rel] ? [`${rel}: frames a stream`] : []),
    ];
  });
  assert.deepEqual(found, []);
  for (const rel of Object.keys(NOT_YET))
    assert.ok(frames(fs.readFileSync(path.join(root, rel), 'utf8')), `${rel} no longer frames: drop it from NOT_YET`);
});

/**
 * The stream batcher JS had (Stage 4.3): its files, its class and each family's contract of keys, joins and sizes. A chat's
 * queue, the keys, joins, sizes and waits are the core's (core/crates/batcher); electron/harness/coreBatcher.cjs keeps the
 * timers, the sends and the events' objects. These names were the batcher's alone, so naming one is bringing it back.
 */
const OLD_BATCHER =
  /\b(?:StreamBatcher|streamContracts|codexContract|claudeContract|acpContract|claudeDelta)\b(?!\.test)|streamBatcher\.cjs|streamContracts\.cjs|acpItems\/agentItems/;

test('no product source batches a stream in JS, or brings back the batcher it had', () => {
  const found = product().flatMap(([rel, file]) => (OLD_BATCHER.test(fs.readFileSync(file, 'utf8')) ? [`${rel}: the old JS batcher`] : []));
  assert.deepEqual(found, []);
  assert.ok(OLD_BATCHER.test("const { StreamBatcher } = require('./streamBatcher.cjs');"));
  assert.ok(OLD_BATCHER.test("import { parentOf } from '../shared/acpItems/agentItems.mjs';"));
  assert.ok(!OLD_BATCHER.test("const { CoreBatcher, familyChats } = require('./coreBatcher.cjs'); ctl.parents.parentOf(key);"));
});

/**
 * A chat record's commit written by a JS writer, as ChatsStore.commit did before Stage 4.5 (`writeAtomic(this.file(rec.id),
 * …)`): the core writes it (store.writeRecord, electron/platform/recordFiles.cjs `writeRecordFile`).
 */
const OLD_RECORD_WRITE = /\b(?:writeAtomic|writeAtomicAsync|writeDurable|writePrivate|writeFileSync)\(\s*this\.file\(rec\.id\)/;

test("a chat record's commit is written by the core, never by a JS writer", () => {
  const found = product().flatMap(([rel, file]) => (OLD_RECORD_WRITE.test(fs.readFileSync(file, 'utf8')) ? [rel] : []));
  assert.deepEqual(found, []);
  const chats = fs.readFileSync(path.join(root, 'electron/platform/chats.cjs'), 'utf8');
  assert.match(chats, /labeled\('chats\.commit', \(\) => writeRecordFile\(this\.file\(rec\.id\), JSON\.stringify\(next\)\)\)/);
  assert.match(fs.readFileSync(path.join(root, 'electron/platform/recordFiles.cjs'), 'utf8'), /dispatchSync\('store\.writeRecord'/);
  assert.ok(OLD_RECORD_WRITE.test("labeled('chats.commit', () => writeAtomic(this.file(rec.id), JSON.stringify(next)));"));
  assert.ok(!OLD_RECORD_WRITE.test('writeAtomic(this.file(), JSON.stringify(state));'));
});

test('the scan finds framing in each shape it names, and not a scan of fixed text', () => {
  for (const framing of [
    "for (let i = buffer.indexOf('\\n'); i >= 0; i = buffer.indexOf('\\n')) {",
    'for (let at = this.buf.indexOf(10); at >= 0; at = this.buf.indexOf(10)) {',
    "while ((i = buf.indexOf('\\n')) >= 0) buf = buf.slice(i + 1);",
    'while ((end = pending.indexOf(0x0a)) !== -1) {',
  ])
    assert.ok(RESCAN.test(framing), framing);
  for (const scan of [
    "for (let i = text.indexOf('\\n'); i >= 0; i = text.indexOf('\\n', i + 1)) starts.push(i + 1);",
    "const end = text.indexOf('\\n');",
    'const next = data.indexOf(0x0a, from) + 1;',
    "while ((i = text.indexOf('\\n', i + 1)) >= 0) count++;",
  ])
    assert.ok(!RESCAN.test(scan), scan);
  for (const framing of [
    "const lines = (partial + text).split('\\n');",
    'const parts = (rest + String(chunk)).split(/\\r?\\n/);',
    'const lines = (this.partial + chunk).split(/\\r?\\n|\\r/);',
  ])
    assert.ok(SPLIT.test(framing), framing);
  for (const scan of [
    "text.split('\\n')",
    "(a + b).split(',')",
    "text.slice(at + 1).split('\\n')",
    "const parts = `${head}\\n${tail}`.split('\\n');",
  ])
    assert.ok(!SPLIT.test(scan), scan);
  assert.ok(READLINE.test('const lines = readline.createInterface({ input: socket });'));
  assert.ok(!READLINE.test('const reader = new JsonReader({ stream: socket });'));
  assert.ok(OLD_FRAMER.test("const { LineFramer } = require('../../shared/jsonLines.mjs');"));
  assert.ok(!OLD_FRAMER.test("const { JsonReader } = require('./jsonReader.cjs'); class JsonInputs {}"));
});
