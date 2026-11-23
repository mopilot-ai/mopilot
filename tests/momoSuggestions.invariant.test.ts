// Whole-repository invariant for MoMo's suggestions (A7): a suggestion never starts work by itself. The only place a suggestion's first step becomes a message is Start's send (app/momoSuggestions.cjs createStarter), and the only caller of it is the one IPC handler for the user's act (momoSuggestions:act in momo/suggestionsIpc.cjs, which a window and a paired phone's explicit request reach); MoMo's own tool momo_suggest only adds a row, takes no id or action, and sends nothing; no routine, nudge, pass, report or the brief's code names the suggestion store's `act` or the act channel; and the store itself reaches no disk, no Electron and no chat.
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
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

/** The modules that may name the act channel: the IPC itself, the preload's declaration and the phone's remote operation. */
const MAY_CALL_THE_ACT_CHANNEL = ['electron/bridge/momoSuggestions.cjs', 'electron/momo/suggestionsIpc.cjs', 'electron/remote/momoOps.cjs'];
/** The modules that may import the store: the store's own wiring and the tool (for its error type). */
const MAY_IMPORT_THE_STORE = ['electron/app/momoSuggestions.cjs', 'electron/momo/suggestionTools.cjs'];

test('only the act IPC, the preload and the phone’s remote operation name the act channel; no tool or background module does', () => {
  const named = files('electron').filter((f) => /['"`]momoSuggestions:act['"`]/.test(read(f)));
  assert.deepEqual(named.sort(), MAY_CALL_THE_ACT_CHANNEL);
  const tools = files('electron/capabilities').concat(files('electron/momo').filter((f) => /Tools\.cjs$/.test(f)));
  for (const f of tools) assert.doesNotMatch(read(f), /suggestions\.act|suggestions_act|momoSuggestions:act/, f);
});

test('only the store’s own wiring and the tool import the store module', () => {
  const importing = files('electron').filter((f) => /require\([^)]*\/suggestions\.cjs['"]\)/.test(read(f)));
  assert.deepEqual(
    importing.filter((f) => f !== 'electron/momo/suggestions.cjs'),
    MAY_IMPORT_THE_STORE.sort(),
  );
});

test('Start’s send is reached from the act handler alone: one `start(` call, inside the handler for the act channel', () => {
  const ipc = read('electron/momo/suggestionsIpc.cjs');
  assert.equal(count(ipc, /\bstart\(/g), 1);
  assert.ok(ipc.indexOf("'momoSuggestions:act'") < ipc.indexOf('start('), 'inside the handler for the act channel');
  assert.equal(count(ipc, /\.act\(/g), 1);
  // and the send is made by the starter alone, as the user's own input
  const wiring = read('electron/app/momoSuggestions.cjs');
  assert.equal(count(wiring, /await controller\.send\(/g), 1);
  assert.match(wiring, /opts: \{ human: true \}/);
});

test('momo_suggest only adds a row: it takes no id or action and has no way to send, start, hide or add', () => {
  const tool = read('electron/momo/suggestionTools.cjs');
  assert.equal(count(tool, /store\.\w+\(/g), 1);
  assert.match(tool, /store\.add\(/);
  assert.doesNotMatch(tool, /controller|\.send\(|sendRun|authored|mainChat|\.act\(|\.start\(|\.hide\(/);
  const schema = tool.slice(tool.indexOf('properties: {'), tool.indexOf('required:'));
  assert.doesNotMatch(schema, /\b(id|action|start|hide)\s*:/);
});

test('a suggestion is never started from a pass, a routine run, a nudge, a report or the brief: those modules name neither the act channel nor the store’s act', () => {
  const background = files('electron/momo').filter((f) =>
    /\/(memoryPass|routines|routineRuns|routineReport|routineStore|starterRoutines|schedulerTasks|nudges|nudgeGate|nudgeTriggers|loopActs|openLoopsPass|brief\w*)\.cjs$/.test(
      f,
    ),
  );
  assert.ok(background.length >= 8, 'the guard still sees the real modules');
  for (const f of background) assert.doesNotMatch(read(f), /momoSuggestions|suggestionsIpc|suggestions\.act|createStarter\b/, f);
});

test('the store reaches no disk, no Electron and no chat: its seam and clock are given', () => {
  for (const f of ['electron/momo/suggestions.cjs', 'electron/momo/suggestionRank.cjs']) {
    const text = read(f);
    assert.doesNotMatch(text, /require\(['"](electron|node:fs|fs|node:path|path)['"]\)|app\.getPath|\.send\(|controller/, f);
  }
});
