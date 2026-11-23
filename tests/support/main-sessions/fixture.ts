// Shared fake timers, main-process harness, and delegation assertions for main session wiring unit cases.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain, unloadMain } from '../electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);
const ready = async (cfg: any = {}) => {
  const h = await loadMain(cfg);
  await h.ready();
  return h;
};
/** calling `via(...args)` calls `target` with `expected` (default: the same args) and returns its result */
const delegates = (via: Function, target: any, args: any[], expected = args) => {
  target.mock.mockImplementation(() => 'r');
  const n = target.mock.callCount();
  const r = via(...args);
  assert.equal(target.mock.callCount(), n + 1);
  assert.deepEqual(target.mock.calls.at(-1).arguments, expected);
  return r;
};

export { test, mock, assert, fs, path, calls, ready, delegates, loadMain, unloadMain };
