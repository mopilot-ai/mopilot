// AppleScript starts an app it addresses when the app isn't running, so bench code may address Chrome only behind an `is running` check: an unguarded tell left a default-profile Chrome on the VM's profile picker (#3571).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeFixtureWindowsArgs, frontFixtureTabArgs } from '../bench/lib/motion/fixtureChrome.mjs';

export const GUARDS = ['bench/', 'scripts/'];

const ROOT = path.join(import.meta.dirname, '..');
const SOURCE = /\.(mjs|cjs|js|sh|ts)$/;
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'results') return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : SOURCE.test(e.name) ? [p] : [];
  });

/**
 * The lines addressing Chrome by AppleScript or JXA with no running check on that line or the two before (an argument
 * list puts `-e` between them). `open -a` is not matched: starting Chrome is what it says. An app name held in a
 * variable can't be matched either; those tidy paths quit apps they just saw running.
 */
function unguardedTells(text: string): number[] {
  const lines = text.split('\n');
  const tell =
    /tell app(?:lication)? (?:id )?\\?["'](?:Google Chrome|com\.google\.Chrome)|Application\(\\?["'](?:Google Chrome|com\.google\.Chrome)/;
  const check = /["'](?:Google Chrome|com\.google\.Chrome)\\?["'] is running|processes\.whose\(\{name:\s*["']Google Chrome["']\}\)/;
  return lines.flatMap((line, i) => (tell.test(line) && !lines.slice(Math.max(0, i - 2), i + 1).some((l) => check.test(l)) ? [i + 1] : []));
}

test('B: the check finds an unguarded tell and accepts a guarded one', () => {
  for (const bad of [
    `osascript -e 'tell application "Google Chrome" to quit'`,
    `osascript -e 'tell application \\"Google Chrome\\" to quit'`,
    `tell app "Google Chrome" to quit`,
    `tell application id "com.google.Chrome" to quit`,
    `Application('Google Chrome').windows()`,
  ])
    assert.deepEqual(unguardedTells(bad), [1], bad);
  assert.deepEqual(unguardedTells(`'if application "Google Chrome" is running then'\n'tell application "Google Chrome" to quit'`), []);
  assert.deepEqual(
    unguardedTells(`if (se.processes.whose({name:'Google Chrome'})().length) {\n  Application('Google Chrome').windows();\n}`),
    [],
  );
  assert.deepEqual(unguardedTells(`tell application "Notes" to quit`), []);
});

test('B: no bench or script source addresses Chrome by AppleScript without checking it runs', () => {
  const sources = [...files(path.join(ROOT, 'bench')), ...files(path.join(ROOT, 'scripts'))];
  assert.ok(sources.length > 50, 'the sources were found');
  const found = sources.flatMap((f) => unguardedTells(fs.readFileSync(f, 'utf8')).map((n) => `${path.relative(ROOT, f)}:${n}`));
  assert.deepEqual(found, []);
});

test('B: closing the motion fixture window only runs when Chrome already runs', () => {
  const args = closeFixtureWindowsArgs();
  const script = args.filter((a) => a !== '-e');
  assert.equal(script[0], 'if application "Google Chrome" is running then');
  assert.equal(script[1], 'tell application "Google Chrome" to close (every window whose title is "Motion fixture")');
  assert.equal(script[2], 'end if');
  assert.deepEqual(unguardedTells(script.join('\n')), []);
});

test('I: the close names only the fixture title it is given', () => {
  assert.match(closeFixtureWindowsArgs('Other').join(' '), /whose title is "Other"/);
  assert.doesNotMatch(closeFixtureWindowsArgs('Other').join(' '), /Motion fixture/);
});

test('B: a quote in the title cannot end the script string', () => {
  assert.match(closeFixtureWindowsArgs('a"b').join(' '), /whose title is "a\\"b"\)/);
});

test('B: fronting the fixture tab only runs when Chrome already runs, and names only its title (#4033)', () => {
  const script = frontFixtureTabArgs().filter((a) => a !== '-e');
  assert.equal(script[0], 'if application "Google Chrome" is running then');
  assert.equal(script.at(-1), 'end if');
  assert.deepEqual(unguardedTells(script.join('\n')), []);
  assert.match(script.join('\n'), /\(title of tab i of w\) is "Motion fixture" then/);
  assert.match(frontFixtureTabArgs('a"b').join(' '), /is "a\\"b" then/);
  // the window is raised on every tick, not only when the tab changes: MoPilot's window sits over Chrome's even with Chrome frontmost
  assert.ok(script.includes('set index of w to 1'));
  assert.ok(script.includes('if not frontmost then activate'));
  // balanced blocks: every opener has its end
  const text = script.join('\n');
  const opens = (text.match(/^(if |repeat |tell )/gm) ?? []).length - (text.match(/^if .* then .+/gm) ?? []).length;
  assert.equal((text.match(/^end /gm) ?? []).length, opens);
});
