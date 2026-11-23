// A reader on this Mac (git, files, search, a shell) must not be given the folder of a chat that runs on a machine (src/lib/chatMachine.ts): the folder is a path on the machine. Any component that reads a thread's `cwd` takes it through the gate (useFolderHere, useChatMachine, useLocalFolder, chatFolderHere) or is named below with the issue that tracks it. A panel file under src/components/panels that calls native.git or native.fs is either reached only through an entry point that gates it (SidePane, SummaryPanel) or gates itself; a new one has to be named here, so someone decides which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['src/components/', 'src/App.tsx'];

const ROOT = path.join(import.meta.dirname, '..');
const PANELS = path.join(ROOT, 'src/components/panels');
/** Mounted only by an entry point that reads the chat's machine first. */
const GATED_BY_ENTRY: Record<string, string> = {
  // DiffPanel itself reads through a ChangesSource (src/lib/changesSource.ts): this Mac's git for the folder SidePane gates, or a machine's Host (MachineChanges)
  'useReviewThreads.tsx': 'SidePane',
  'files/FilePreview.tsx': 'SidePane',
  // opens a file the user names, for the pane's file tab (gated by SidePane when it shows the chat's folder)
  'FileDocumentPreview.tsx': 'SidePane',
  // reads this Mac's own temp folder
  'BrowserAnnotate.tsx': 'SidePane',
};
const ENTRIES = ['SidePane.tsx', 'SummaryPanel.tsx'];

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const rel = (f: string) => path.relative(PANELS, f);

test('every panel that reads git or files with this Mac is gated for a chat on a machine', () => {
  const readers = walk(PANELS)
    .filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
    .filter((f) => /native\.(git|fs)\./.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  const ungated = readers.filter((f) => !GATED_BY_ENTRY[f] && !/lib\/chatMachine/.test(fs.readFileSync(path.join(PANELS, f), 'utf8')));
  assert.deepEqual(
    ungated,
    [],
    'read git or files of a chat folder with no gate: use useChatMachine/useLocalFolder, or name the entry that gates it',
  );
  // a name in the table that no longer reads anything is stale
  assert.deepEqual(
    Object.keys(GATED_BY_ENTRY).filter((f) => !readers.includes(f)),
    [],
  );
});

test('the entry points read the chat’s machine', () => {
  for (const f of ENTRIES) assert.match(fs.readFileSync(path.join(PANELS, f), 'utf8'), /lib\/chatMachine/, f);
});

/** Components that read a thread's folder without the gate, each for one reason. */
const NOT_GATED: Record<string, string> = {
  // the approval's folder label only: nothing is opened, read or linked from it
  'thread/NeedsYouStrip.tsx': 'display only',
  // the folder shortens the paths it shows; its links go through ChatScope, which reads the chat's machine
  'thread/ThreadView.tsx': 'display; links via ChatScope',
};
const COMPONENTS = path.join(ROOT, 'src/components');
const THREAD_CWD = /(threads\[[^\]]+\]\??\.cwd|[tT]hread\??\.cwd)/;
const GATE = /lib\/(chatMachine|hostChats)/;

test('every component that reads a thread’s folder takes it through the gate, or is named with its issue', () => {
  const files = [...walk(COMPONENTS), path.join(ROOT, 'src/App.tsx')].filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'));
  const readers = files.filter((f) => THREAD_CWD.test(fs.readFileSync(f, 'utf8')));
  const rels = readers.map((f) => path.relative(COMPONENTS, f));
  const ungated = readers.filter((f) => !GATE.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(COMPONENTS, f));
  assert.deepEqual(
    ungated.filter((f) => !NOT_GATED[f]),
    [],
    'reads a thread’s cwd with no gate: take it through useFolderHere (src/lib/chatMachine.ts), or name it in NOT_GATED with its issue',
  );
  assert.deepEqual(
    Object.keys(NOT_GATED).filter((f) => !ungated.includes(f)),
    [],
    'listed in NOT_GATED but gated or no longer reading a thread’s cwd: remove it',
  );
  assert.ok(rels.length > 10, 'the sweep reads the components that read a thread’s cwd');
});
