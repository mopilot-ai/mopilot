// The extension's service worker has no window of its own: a chrome.tabs.create there with no windowId throws
// "No current window" when Chrome runs with none open (#3714). Every module the worker loads opens tabs through
// src/openTab.mjs instead. Extension pages (the side panel, options, mic page) open theirs in the window they are in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['electron/chrome-extension/'];

const EXT = path.join(import.meta.dirname, '../electron/chrome-extension');

/** Every module the service worker loads, from the manifest's service_worker through its relative imports. */
function workerModules(): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    // static imports and re-exports, side-effect imports and dynamic import()s
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) visit(path.resolve(path.dirname(file), m[1]));
  };
  visit(path.join(EXT, manifest.background.service_worker));
  return [...seen];
}

test('I: the service worker opens every tab through openTab.mjs, which survives a windowless Chrome', () => {
  const modules = workerModules();
  assert.ok(
    modules.some((f) => f.endsWith('src/sessions.mjs')) && modules.some((f) => f.endsWith('src/openTab.mjs')),
    'the worker graph was read',
  );
  for (const file of modules) {
    if (file.endsWith('src/openTab.mjs')) continue;
    const text = fs.readFileSync(file, 'utf8').replace(/^\s*(?:\/\/|\*).*$/gm, '');
    assert.doesNotMatch(
      text,
      // a call, or the method taken off chrome.tabs to call later
      /\btabs\.create\s*\(|\{[^}]*\bcreate\b[^}]*\}\s*=\s*(?:\w+\.)?tabs\b/,
      `${path.relative(EXT, file)} calls chrome.tabs.create directly; use tabOpener (src/openTab.mjs)`,
    );
  }
});
