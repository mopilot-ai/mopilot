// A field that takes a code or a command is not prose: no keyboard may "correct" it (an Android keyboard turned the pairing code's "ws" into "WS" and the code stopped working).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, click, createElement, createRoot, openCodeEntry } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const pairingPath = '../mobile/src/screens/Pairing';
const { Pairing } = await import(pairingPath);

test('the pairing code field turns off auto-correct and spell check; the phone name keeps them', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Pairing, { runtime: scripted(() => undefined).runtime, back: () => {} })));
  await openCodeEntry();
  const attr = (placeholder: string, name: string) => host.querySelector(`input[placeholder="${placeholder}"]`)?.getAttribute(name);
  assert.equal(attr('Paste pairing code', 'data-auto-correct'), 'false');
  assert.equal(attr('Paste pairing code', 'data-spell-check'), 'false');
  await click('Advanced');
  assert.equal(attr('Phone name', 'data-auto-correct'), 'true');
  await act(async () => root.unmount());
  host.remove();
});

test('the pairing code field stops growing at a height that leaves Connect in reach, and scrolls inside', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Pairing, { runtime: scripted(() => undefined).runtime, back: () => {} })));
  await openCodeEntry();
  const field = host.querySelector('input[placeholder="Paste pairing code"]')!;
  const style = JSON.parse(field.getAttribute('data-style') ?? '{}');
  assert.ok(style.maxHeight > 0 && style.maxHeight <= 200, `max height ${style.maxHeight}`);
  await act(async () => root.unmount());
  host.remove();
});

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : [],
  );
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const countOf = (source: string, pattern: RegExp) => withoutComments(source).match(pattern)?.length ?? 0;
const CAPITALIZE_OFF = /autoCapitalize=(?:"none"|'none'|\{\s*['"]none['"]\s*\})/g;
const CORRECT_OFF = /autoCorrect=\{\s*false\s*\}/g;

test('every field that switches auto-capitalize off for a code also switches auto-correct off', () => {
  const missing = files('mobile/src').filter((file) => {
    const source = readFileSync(file, 'utf8');
    return countOf(source, CAPITALIZE_OFF) > countOf(source, CORRECT_OFF);
  });
  assert.deepEqual(missing, []);
});

test('the count check sees quote variants and ignores comments', () => {
  assert.equal(countOf("<Field autoCapitalize='none' autoCapitalize={'none'} />", CAPITALIZE_OFF), 2);
  assert.equal(countOf('// autoCorrect={false}\n<Field autoCapitalize="none" />', CORRECT_OFF), 0);
  assert.equal(countOf('<Field autoCorrect={ false } />', CORRECT_OFF), 1);
});
