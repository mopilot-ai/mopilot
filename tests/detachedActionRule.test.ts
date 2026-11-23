// The detached-action lint guard (lint/rules/detached-action.grit) through the production Biome configuration: a click
// that drops the answer of an action bound to the turn, tab, task or app it showed warns; one read through liveAction,
// liveClick or an await does not. docs/bug-prevention/stale-async-results.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

const ARGS =
  'threadId, native, t, chatId, key, k, b, id, toastFailure, setError, liveAction, liveClick, f, takeOver, interrupt, stopBackgroundTask';
/** Whether each snippet warns [detached-action], in one Biome run. */
const warns = (snippets: string[]) => {
  const files = Object.fromEntries(snippets.map((s, i) => [`src/p${i}.tsx`, `export async function f(${ARGS}) {\n  ${s}\n}\n`]));
  const report = lintFixtures(files);
  return snippets.map((_, i) =>
    report.diagnostics.some((d) => d.message.includes('[detached-action]') && d.location?.path?.endsWith(`p${i}.tsx`)),
  );
};

test('a click or void that drops an id-taking action’s answer warns (the shapes #1866 found)', () => {
  const shapes = [
    'void interrupt(threadId);',
    "void interrupt(threadId).catch(toastFailure('x'));",
    'void native.browser.takeOver(key, null, true);',
    'const a = <button onClick={() => void interrupt(threadId)}>x</button>;',
    'const a = <button onClick={(e) => e.nativeEvent.isTrusted && native.computer.handBack(threadId, b)}>x</button>;',
    'const a = <button onClick={(e) => e.nativeEvent.isTrusted && native.computer.stop(threadId)}>x</button>;',
    'const a = <button onClick={() => native.computer.resume(threadId)}>x</button>;',
    'const a = <button onClick={() => interrupt(threadId!).catch((e) => setError(e))}>x</button>;',
    'const a = <button onClick={() => void stopBackgroundTask(chatId, t)}>x</button>;',
  ];
  assert.deepEqual(
    warns(shapes),
    shapes.map(() => true),
  );
});

test('an answer read through liveAction, liveClick or an await, and the composer’s Stop of whatever runs, do not warn', () => {
  const shapes = [
    'await interrupt(threadId);',
    'interrupt(threadId).catch(toastFailure("x"));',
    'void liveAction(interrupt(threadId, id)).catch(toastFailure("x"));',
    'const a = <button onClick={() => liveClick(native.computer.stop(threadId))}>x</button>;',
    'const a = <button onClick={(e) => e.nativeEvent.isTrusted && liveClick(native.computer.handBack(threadId, b))}>x</button>;',
    'if (!(await liveAction(native.browser.takeOver(k, null, true)))) return;',
    'const ok = await native.browser.takeOver(k, null, true);',
    'const a = <button onClick={() => takeOver(false)}>x</button>;',
  ];
  assert.deepEqual(
    warns(shapes),
    shapes.map(() => false),
  );
});
