// A folder is synced only through electron/platform/folderSync.cjs, which skips Windows: there FlushFileBuffers on a folder
// is refused (EPERM), and every sealed file (browser history, MoMo's data, Mobile Remote's keys) failed to save after its
// rename had landed. The app's sources and the Host's open no folder for a sync of their own, directly or through a local
// helper that syncs whatever it is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/', 'shared/', 'host/src/'];
const ROOT = path.join(import.meta.dirname, '..');
const HELPER = 'electron/platform/folderSync.cjs';
/** How many lines after an open its sync may come (a try/withCleanup block, a write in between). */
const REACH = 12;

/**
 * An expression that names a folder: `path.dirname(…)`, or a name (or a property, `this.dir`, `s.dir`) that is dir,
 * parent, folder, directory or root, or ends in Dir, Folder, Directory or Root.
 */
const FOLDER = String.raw`(?:path\.dirname\((?:[^()]|\([^()]*\))*\)|(?:[\w$]+\.)*(?:dir|parent|folder|directory|root|[\w$]*(?:Dir|Folder|Directory|Root)))`;
/** An open of a folder for reading: `open(dir)`, `openSync(dir, 'r')`, `fs.promises.open(path.dirname(f))`. */
const OPENS_FOLDER = new RegExp(String.raw`\bopen(?:Sync)?\(\s*${FOLDER}\s*(?:,\s*['"]r['"]\s*)?\)`);
const SYNCS = /\b(?:fsyncSync|fdatasyncSync)\(|\.(?:sync|datasync)\(\)/;
const SYNCS_FOLDER = /\bsyncFolder(?:Async)?\(/;

/** Local helpers that open what they are given and sync it: `function sync(io, file) { const fd = io.openSync(file, 'r'); … }`. */
function syncingHelpers(lines: string[]): string[] {
  const names: string[] = [];
  lines.forEach((line, i) => {
    const m = /^\s*(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)|^\s*const\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/.exec(line);
    if (!m) return;
    const name = m[1] ?? m[3];
    const params = (m[2] ?? m[4])
      .split(',')
      .map((p) => p.replace(/[=/].*$/, '').trim())
      .filter(Boolean);
    const body = lines.slice(i, i + REACH).join('\n');
    if (SYNCS_FOLDER.test(body) || !SYNCS.test(body)) return;
    if (params.some((p) => new RegExp(String.raw`\bopen(?:Sync)?\(\s*${p.replace(/\$/g, '\\$')}\s*[,)]`).test(body))) names.push(name);
  });
  return names;
}

/** Where `text` syncs a folder by hand: the lines of each open of a folder followed by a sync, and of each call that hands a folder to a local syncing helper. */
export function folderSyncs(text: string): number[] {
  const lines = text.split('\n');
  const found = new Set<number>();
  lines.forEach((line, i) => {
    if (OPENS_FOLDER.test(line) && lines.slice(i, i + REACH).some((l) => SYNCS.test(l))) found.add(i + 1);
  });
  for (const name of syncingHelpers(lines)) {
    const call = new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}\(\s*(?:[^(),]+,\s*)*${FOLDER}\s*[,)]`);
    lines.forEach((line, i) => {
      if (call.test(line) && !/^\s*(?:async\s+)?function\s|^\s*const\s+[\w$]+\s*=/.test(line)) found.add(i + 1);
    });
  }
  return [...found].sort((a, b) => a - b);
}

test('the matcher finds each shape of a folder synced by hand', () => {
  const positive: [string, string][] = [
    ['openSync with r', "const fd = fs.openSync(dir, 'r');\ntry {\n  fs.fsyncSync(fd);\n}"],
    ['open with no flags', 'const fd = fs.openSync(dir);\nfs.fsyncSync(fd);'],
    ['promises open with no flags', 'const fh = await fs.promises.open(dir);\nawait fh.sync();'],
    ['a name ending in Dir', "const fh = await fs.open(parentDir, 'r');\nawait fh.sync();"],
    ['path.dirname of a file', "const d = fs.openSync(path.dirname(file), 'r');\nfs.fsyncSync(d);"],
    ['path.dirname with a nested call', "const d = fs.openSync(path.dirname(fileOf(id)), 'r');\nfs.fsyncSync(d);"],
    ['a property', "const fd = fs.openSync(this.dir, 'r');\nfs.fsyncSync(fd);"],
    ['another object property', "const fd = io.openSync(s.dir, 'r');\nio.fsyncSync(fd);"],
    ['root', "const fd = fs.openSync(root, 'r');\nfs.fsyncSync(fd);"],
    ['fdatasync', "const fd = fs.openSync(dir, 'r');\nfs.fdatasyncSync(fd);"],
    ['datasync on a handle', "const fh = await fs.open(dir, 'r');\nawait fh.datasync();"],
    ['a sync well after the open', `const fd = fs.openSync(dir, 'r');\n${'// …\n'.repeat(6)}fs.fsyncSync(fd);`],
    [
      'a local helper given path.dirname',
      "function sync(io, file) {\n  const fd = io.openSync(file, 'r');\n  try {\n    io.fsyncSync(fd);\n  } finally {\n    io.closeSync(fd);\n  }\n}\nsync(io, tmp);\nsync(io, path.dirname(file));",
    ],
    [
      'a local helper given a folder',
      "function sync(io, file) {\n  const fd = io.openSync(file, 'r');\n  io.fsyncSync(fd);\n  io.closeSync(fd);\n}\nsync(io, dir);",
    ],
    ['an arrow helper', "const flush = (p) => {\n  const fd = fs.openSync(p, 'r');\n  fs.fsyncSync(fd);\n};\nflush(path.dirname(file));"],
  ];
  for (const [shape, text] of positive) assert.notDeepEqual(folderSyncs(text), [], shape);
  // the helper given a file and the helper given a folder: only the folder's call (and only its line)
  assert.deepEqual(folderSyncs(positive[12][1]), [10]);
  const negative: [string, string][] = [
    ['a file read', "const fh = await fs.promises.open(file, 'r');\nconst text = await fh.readFile();"],
    ['a file synced', "const fd = fs.openSync(file, 'r');\nfs.fsyncSync(fd);"],
    ['a folder opened and not synced', "const fd = fs.openSync(dir, 'r');\nconst names = fs.readdirSync(dir);"],
    ['a folder opened to write', "const fd = fs.openSync(dir, 'w');\nfs.fsyncSync(fd);"],
    ['the shared helper', 'syncFolder(path.dirname(file), { fs: io });\nawait syncFolderAsync(dir);'],
    ['a helper that delegates', 'const syncDir = (dir) => syncFolder(dir, { fs: io });\nsyncDir(path.dirname(file));'],
    [
      'a local helper given only files',
      "function sync(io, file) {\n  const fd = io.openSync(file, 'r');\n  io.fsyncSync(fd);\n}\nsync(io, tmp);",
    ],
    ['an injected helper', 'syncDir(path.dirname(root));\nsyncDir(root);'],
    ['a sync out of reach', `const fd = fs.openSync(dir, 'r');\n${'// …\n'.repeat(REACH)}fs.fsyncSync(other);`],
    ['a method named sync', 'await live.remote.sync();\nstore.sync(dir);'],
  ];
  for (const [shape, text] of negative) assert.deepEqual(folderSyncs(text), [], shape);
});

test('the app and the Host sync a folder only through platform/folderSync.cjs', () => {
  const sources = GUARDS.flatMap((dir) => treeFiles(path.join(ROOT, dir), /\.(?:[cm]?js|ts)$/)).map((f) => path.relative(ROOT, f));
  assert.ok(sources.includes(HELPER), `${HELPER} is where folders are synced`);
  assert.ok(
    sources.some((f) => f.startsWith('host/src/')),
    'the Host sources are scanned',
  );
  const offenders = sources
    .filter((f) => f !== HELPER)
    .flatMap((f) => folderSyncs(fs.readFileSync(path.join(ROOT, f), 'utf8')).map((line) => `${f}:${line}`));
  assert.deepEqual(offenders, [], 'sync a folder with syncFolder or syncFolderAsync (electron/platform/folderSync.cjs)');
});
