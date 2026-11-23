// The swallowed-error lint guard (lint/rules/swallowed-error.grit) through the production Biome configuration:
// a failure turned into an empty value, directly or handed to a setter, warns; a handler that uses the error does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

const hits = (input: string) => {
  return lintFixtures({ 'shared/read.mjs': input }).diagnostics.filter((d) => d.message.includes('[swallowed-error]')).length;
};

test('a failure handed on as an empty value warns, whether returned or passed to a setter', () => {
  for (const input of [
    'export const f = (p) => p.catch(() => {});',
    'export const f = (p) => p.catch(() => null);',
    'export const f = (p, setChecks) => p.catch(() => setChecks([]));',
    'export const f = (p, setDiff) => p.catch((e) => setDiff(""));',
    'export const f = (p, setR) => p.then(setR, () => setR(null));',
    'export const f = (p, ok, done) => p.then(ok, (e) => done(false));',
    'export const f = (p, set) => p.catch(() => set({}));',
  ])
    assert.equal(hits(input), 1, input);
});

test('a handler that keeps, shows or records the error does not warn', () => {
  for (const input of [
    'export const f = (p, setError) => p.catch((e) => setError(e));',
    'export const f = (p, setR, setError) => p.then(setR, (e) => setError(String(e)));',
    'export const f = (p, note, set) => p.catch((e) => { note(e); set([]); });',
    'export const f = (p, setR) => p.then(setR);',
    'export const f = (p, set, fallback) => p.then(set, () => set(fallback));',
  ])
    assert.equal(hits(input), 0, input);
});
