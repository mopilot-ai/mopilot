// Whole-repository invariant for MoMo's task marks (M0a): only the user marks a task done. The marks store (electron/momo/taskMarks.cjs) is reached by its own wiring and by the one IPC handler a window or a paired phone's explicit request calls (momoTasks:mark); no MoMo tool, background pass, routine, nudge or capability names it, and the derivations only read the marks they are handed. The one `.mark(` call in tasksIpc.cjs sits in that handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['electron/', 'shared/remote/'];

const ROOT = path.join(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return files(rel);
    return /\.(cjs|mjs|js|ts)$/.test(e.name) ? [rel] : [];
  });
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The modules that may name the marks store: the store, its sealed-file wiring, main's wiring and the IPC that takes the user's mark. */
const MAY_NAME_THE_STORE = new Set([
  'electron/momo/taskMarks.cjs',
  'electron/momo/tasksIpc.cjs',
  'electron/app/momoTaskMarks.cjs',
  'electron/app/momoBackground.cjs',
]);
/** The modules that may call the mark channel: the IPC itself, the preload's declaration and the phone's remote operation. */
const MAY_CALL_THE_MARK_CHANNEL = new Set(['electron/momo/tasksIpc.cjs', 'electron/bridge/momoTasks.cjs', 'electron/remote/momoOps.cjs']);

test('no module but the store, its wiring and the mark IPC names the marks store', () => {
  const electron = files('electron');
  const named = electron.filter((f) => /require\([^)]*[tT]askMarks|createTaskMarks|openTaskMarks|task-marks/.test(read(f)));
  assert.deepEqual(
    named.filter((f) => !MAY_NAME_THE_STORE.has(f)),
    [],
  );
  assert.ok(
    named.includes('electron/momo/tasksIpc.cjs') && named.includes('electron/app/momoTaskMarks.cjs'),
    'the guard still sees the real users',
  );
});

test('only the mark IPC, the preload and the phone’s remote operation name the mark channel; no MoMo tool or capability does', () => {
  const named = files('electron').filter((f) => /['"`]momoTasks:mark['"`]/.test(read(f)));
  assert.deepEqual(
    named.filter((f) => !MAY_CALL_THE_MARK_CHANNEL.has(f)),
    [],
  );
  assert.deepEqual(named.sort(), [...MAY_CALL_THE_MARK_CHANNEL].sort());
  // and the phone's method is a remote request, never a tool: nothing a MoMo chat can call registers it
  const tools = files('electron/capabilities').concat(files('electron/momo').filter((f) => /Tools\.cjs$/.test(f)));
  for (const f of tools) assert.doesNotMatch(read(f), /tasks\.mark|tasks_mark/, f);
});

test('the one place that sets a mark is the mark handler, and the derivations only read the marks they are given', () => {
  const ipc = read('electron/momo/tasksIpc.cjs');
  assert.equal((ipc.match(/\.mark\(/g) ?? []).length, 1);
  assert.ok(ipc.indexOf("'momoTasks:mark'") < ipc.indexOf('.mark('), 'inside the handler for the mark channel');
  for (const f of ['electron/momo/tasks.cjs', 'electron/momo/tasksPanel.cjs']) {
    const text = read(f);
    assert.doesNotMatch(text, /require\([^)]*[tT]askMarks|createTaskMarks|\.mark\(/, f);
  }
  // the remote method passes the user's request through; it adds no mark of its own
  assert.equal((read('electron/remote/methods/momo.cjs').match(/\.tasks\.mark\(/g) ?? []).length, 1);
});

test('a mark is never made from a pass, a routine run or a nudge: the background modules do not import the mark IPC or the store', () => {
  const background = [
    'electron/momo/memoryPass.cjs',
    'electron/momo/routines.cjs',
    'electron/momo/routineRuns.cjs',
    'electron/momo/nudges.cjs',
    'electron/momo/loopActs.cjs',
  ];
  for (const f of background) assert.doesNotMatch(read(f), /[tT]askMarks|tasksIpc|momoTasks/, f);
});
