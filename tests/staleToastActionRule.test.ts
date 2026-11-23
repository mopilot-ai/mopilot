// The stale-toast-action lint guard (lint/rules/stale-toast-action.grit) through the production Biome configuration: a
// toast action that acts on the chat, account or pin it captured warns; one that runs a helper reading it again at the
// click, or only navigates, does not. docs/bug-prevention/stale-async-results.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

const ARGS = 'toast, store, way, addAccount, setSession, setChatAccount, navigate, takeWayForward, e, chatId, model, chats, h';
/** Whether each snippet warns [stale-toast-action], in one Biome run. */
const warns = (snippets: string[]) => {
  const files = Object.fromEntries(snippets.map((s, i) => [`src/p${i}.ts`, `export async function f(${ARGS}) {\n  ${s}\n}\n`]));
  const report = lintFixtures(files);
  return snippets.map((_, i) =>
    report.diagnostics.some((d) => d.message.includes('[stale-toast-action]') && d.location?.path?.endsWith(`p${i}.ts`)),
  );
};

test('a toast action that acts on what it captured warns (the shapes #1988 found)', () => {
  const shapes = [
    "toast('x', 'error', { action: { label: 'Sign in again', run: () => addAccount(e.id) } });",
    "toast('x', 'error', { action: { label: 'Continue', run: () => setSession(chatId, { pendingSwitch: { model } }) } });",
    "toast('x', 'error', { action: { label: 'Go', run: () => Promise.all(chats.map((c) => setChatAccount(h, c, null))) } });",
    "store.toast('x', 'error', { action: { label: 'Sign in again', run() { return addAccount(e.id); } } });",
    // the way forward worked out before the toast and handed to it whole
    "toast('x', 'error', { action: way.action });",
  ];
  assert.deepEqual(
    warns(shapes),
    shapes.map(() => true),
  );
});

test('a toast action that reads again at the click, or only navigates, and a run outside a toast do not warn', () => {
  const shapes = [
    "toast('x', 'error', { action: { label: 'Continue', run: () => takeWayForward(chatId, 'codex') } });",
    "toast('x', 'error', { action: { label: 'View usage', run: () => navigate({ name: 'settings' }) } });",
    "const way = { label: 'Continue', run: () => setSession(chatId, { pendingSwitch: { model } }) };",
    "toast('x', 'error', { duration: 5, action: { label: 'Undo', run: () => navigate({ name: 'home' }) } });",
    'const w = { action: way.action };',
  ];
  assert.deepEqual(
    warns(shapes),
    shapes.map(() => false),
  );
});
