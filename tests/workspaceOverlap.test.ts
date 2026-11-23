// Directory scopes used by per-turn snapshot attribution on POSIX and Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const { overlappingDirectories } = createRequire(import.meta.url)('../electron/session/workspaceOverlap.cjs');

test('POSIX directory scopes overlap by ancestry, preserving directory boundaries and casing', () => {
  for (const [a, b, expected] of [
    ['/work', '/work/src', true],
    ['/work/src', '/work', true],
    ['/work/', '/work/./', true],
    ['/work/src/..', '/work', true],
    ['/', '/work', true],
    ['/work/src', '/work/tests', false],
    ['/work', '/workspace', false],
    ['/Work', '/work', false],
    ['/work', '/work/../other', false],
    ['/work', '/work/..draft', true],
  ] as const)
    assert.equal(overlappingDirectories(a, b, path.posix), expected, `${a} / ${b}`);
});

test('Windows scopes normalize case and separators, and keep drives and UNC shares separate', () => {
  for (const [a, b, expected] of [
    ['C:\\Work', 'c:/work/src', true],
    ['C:\\Work\\src', 'c:/work', true],
    ['C:\\Work\\', 'c:/work/.', true],
    ['C:\\Work', 'C:\\Work\\src\\..', true],
    ['C:\\', 'C:\\Work', true],
    ['C:\\Work', 'D:\\Work', false],
    ['C:\\Work', 'C:\\Workspace', false],
    ['C:\\Work\\src', 'C:\\Work\\tests', false],
    ['\\\\server\\share', '\\\\SERVER\\share\\src', true],
    ['\\\\server\\share', '\\\\server\\other', false],
  ] as const)
    assert.equal(overlappingDirectories(a, b, path.win32), expected, `${a} / ${b}`);
});
