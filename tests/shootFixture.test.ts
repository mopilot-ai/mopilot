// Screenshot capture must finish even when offscreen finite animations never settle.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
mock.module('@playwright/test', {
  namedExports: { test: { info: () => ({ outputPath: (name: string) => `/reports/${name}` }) }, expect: () => ({}) },
});
const { shoot } = await import('./e2e/fixtures/shoot.ts');
test('capture delegates animation settling to Playwright even with a never-finished finite animation', async () => {
  const original = document.getAnimations;
  document.getAnimations = () => [{ effect: { getComputedTiming: () => ({ iterations: 1 }) }, finished: new Promise(() => {}) }] as any;
  const captures: unknown[] = [];
  const page: any = {
    evaluate: (fn: () => unknown) => fn(),
    locator: () => ({ getAttribute: async () => 'dark' }),
    screenshot: async (options: unknown) => {
      captures.push(options);
    },
  };
  try {
    const result = await Promise.race([
      shoot(page, 'outputs').then(() => 'captured'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 30)),
    ]);
    assert.equal(result, 'captured');
    assert.deepEqual(captures, [{ animations: 'disabled', path: '/reports/outputs-dark.png' }]);
  } finally {
    document.getAnimations = original;
  }
});
test('capture retains caller geometry and output naming in the current theme', async () => {
  let options: any;
  const page: any = {
    evaluate: async () => {},
    locator: () => ({ getAttribute: async () => 'light' }),
    screenshot: async (value: unknown) => {
      options = value;
    },
  };
  await shoot(page, 'tools', { clip: { x: 1, y: 2, width: 300, height: 400 }, omitBackground: true });
  assert.deepEqual(options, {
    animations: 'disabled',
    clip: { x: 1, y: 2, width: 300, height: 400 },
    omitBackground: true,
    path: '/reports/tools-light.png',
  });
});
