// The raw-error-text, silent-open and unread-permission-answer lint guards (lint/rules/*.grit) through the production Biome configuration:
// a caught error's raw text in a toast or error state warns, errorText does not; an open whose failure nobody
// handles warns, an awaited or caught one does not. docs/bug-prevention/misleading-error-text-and-silent-opens.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';
import fs from 'node:fs';

/** Line numbers of the rule's warnings in a renderer file (the rules apply to src/**). */
const hits = (rule: string, input: string, name = 'view.tsx') => {
  const report = lintFixtures({ [`src/${name}`]: input });
  return report.diagnostics.filter((d) => d.message.includes(`[${rule}]`)).map((d) => d.location?.start?.line);
};

test("a caught error's raw text in a toast, an error setter or an error field warns", () => {
  for (const input of [
    "p.catch((e) => toast(String(e?.message ?? e), 'error'));",
    "p.catch((e) => toast(`Rename failed: ${(e as Error)?.message ?? e}`, 'error'));",
    "p.catch((err) => toast(String(err), 'error'));",
    "p.catch((e) => toast(`Couldn't ${e}`, 'error'));",
    "p.catch((e) => actions.toast(`Couldn't: ${e instanceof Error ? e.message : String(e)}`, 'error'));",
    'p.catch((e) => setError((e as Error | null)?.message ?? String(e)));',
    'p.catch((error) => setLoadError(`Could not load: ${String((error as Error)?.message ?? error)}`));',
    "p.catch((e) => setErr(String(e?.message ?? e ?? '') || 'Could not read file'));",
    'p.catch((e) => setFailed(String(e)));',
    'p.catch((e) => useReview.setState({ error: String(e), lists: [] }));',
    'p.catch((e) => set({ configError: e.message }));',
    'p.catch((reason) => ({ ok: false, error: reason.message }));',
  ])
    assert.deepEqual(
      hits(
        'raw-error-text',
        `export const f = (p, toast, actions, set, useReview, setError, setLoadError, setErr, setFailed) =>\n  ${input}\n`,
      ),
      [2],
      input,
    );
});

test('errorText, toastFailure, other text and non-error fields do not warn', () => {
  for (const input of [
    "p.catch((e) => toast(errorText(e), 'error'));",
    "p.catch((e) => toast(`Couldn't: ${errorText(e)}`, 'error'));",
    'p.catch(toastFailure("Couldn\'t rename"));',
    "toast(p.message, 'info');",
    "toast(String(count), 'info');",
    "toast(`Couldn't load plugins: ${error}`, 'error');",
    'setError(j?.error?.message);',
    'set({ error: null });',
    'setName(e.message);',
    'p.load({ onError: (e) => toast(errorText(e)) });',
    // only the toast's text is read: an action that handles an error elsewhere is not its message
    "toast('Archived', 'info', { action: { run: () => fail(e.message) } });",
  ])
    assert.deepEqual(
      hits(
        'raw-error-text',
        `export const f = (p, toast, set, setError, setName, errorText, toastFailure, count, error, e, j, fail) =>\n  ${input}\n`,
      ),
      [],
      input,
    );
});

test('an open whose failure nobody handles warns', () => {
  for (const input of [
    "() => native.shell.openExternal('https://x')",
    '() => void native.shell.openExternal(url)',
    '() => a && native.shell.openPath(a)',
    '() => (a ? native.shell.openExternal(a) : null)',
    '() => { if (a) return native.shell.reveal(a); }',
    "() => p.catch(() => native.shell.openIn('code', a))",
    "() => native.mopilot.openWeb('/credits')",
  ])
    assert.deepEqual(hits('silent-open', `export const f = (native, p, url, a) =>\n  ${input};\n`), [2], input);
});

test('an awaited or caught open, other native calls and the open helpers themselves do not warn', () => {
  for (const input of [
    '() => native.shell.openExternal(url).catch((e) => toast(e))',
    'async () => { await native.shell.openExternal(url); }',
    '() => native.shell.openExternal(url).then(ok, fail)',
    '() => native.shell.openExternal(url).then(ok).catch(fail)',
    '() => native.shell\n      .openExternal(url)\n      .then(() => ok())\n      .catch(fail)',
    '() => native.dialog.openFiles()',
    "() => native.mopilot.openWeb('/privacy').catch(toast)",
    '() => openLink(url)',
  ])
    assert.deepEqual(hits('silent-open', `export const f = (native, url, toast, ok, fail, openLink) =>\n  ${input};\n`), [], input);
});

test('src/session/open.ts, where the helpers call native.shell, is outside silent-open', () => {
  const config = JSON.parse(fs.readFileSync('biome.json', 'utf8'));
  const override = config.overrides.find((o: { plugins?: string[] }) => o.plugins?.includes('./lint/rules/silent-open.grit'));
  assert.deepEqual(override.includes, ['src/**', '!src/session/open.ts']);
  const raw = config.overrides.find((o: { plugins?: string[] }) => o.plugins?.includes('./lint/rules/raw-error-text.grit'));
  assert.deepEqual(raw.includes, ['src/**']);
});

test('a permission request or look again whose answer is dropped warns (unread-permission-answer)', () => {
  for (const input of [
    "await native.computer.requestPermission('screenRecording');",
    'await native.computer.recheck(id);',
    'void native.computer.recheck(id);',
    'native.computer.recheck(id);',
    // a request followed by a look again still drops what macOS answered
    "await native.computer.requestPermission('screenRecording');\n  return native.computer.recheck(id);",
  ])
    assert.deepEqual(hits('unread-permission-answer', `export async function f(native, id) {\n  ${input}\n}\n`), [2], input);
});

test('a permission answer that is read or returned does not warn', () => {
  for (const input of [
    'const on = await native.computer.recheck(id);',
    "if (await native.computer.requestPermission('screenRecording')) return;",
    'return native.computer.recheck(id);',
    'show(await native.computer.recheck(id));',
    "const on = await native.computer.requestPermission('screenRecording');\n  return (await native.computer.recheck(id)) && on;",
    'await native.computer.status();',
  ])
    assert.deepEqual(hits('unread-permission-answer', `export async function f(native, id, show) {\n  ${input}\n}\n`), [], input);
  assert.deepEqual(hits('unread-permission-answer', 'export const f = (native, id) => native.computer.recheck(id);\n'), []);
});
