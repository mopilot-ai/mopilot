// MoPilot's own desktop tools refusing MoPilot itself (#1724): a call that names it (by name, a helper's name,
// a development build's Electron, or a bundle id) is refused as the no-go app it is, with the hint toward list_sidebar and
// the browser tools, and the chat's transcript gets the same line as a native stop (the Registry's guard, noteNoGo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig as desktopRig, rejects } from './support/desktop-kit.ts';
import { rig as appsRig } from './support/app-scoped-kit.ts';

const require = createRequire(import.meta.url);
const { refuseSelf } = require('../electron/capabilities/contract/controlRefusals.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
const { ComputerUse } = require('../electron/capabilities/tools/computer.cjs');

/** Runs `fn` as a tool call whose no-go refusals are collected. */
async function noted(fn: () => Promise<unknown>) {
  const seen: any[] = [];
  await guarded({ onNoGo: (r: any) => seen.push(r) }, fn);
  return seen;
}
const SELF_HINT = /\(MoPilot itself\)\. Its projects and chats are listed by the list_sidebar tool/;

test('refuseSelf: MoPilot by any of its names or bundle ids is refused; any other app, or none, is not', () => {
  for (const q of ['MoPilot', ' mopilot.app ', 'MoPilot Computer Use', 'Electron', 'ai.mopilot.code', 'com.github.Electron'])
    assert.throws(
      () => refuseSelf(q),
      (e: any) => e.code === 'refused' && SELF_HINT.test(e.message),
      q,
    );
  for (const q of ['Notes', 'com.apple.Notes', 'Code', '', null, undefined]) assert.doesNotThrow(() => refuseSelf(q), String(q));
});

test('desktop_open_application and a keyboard action naming MoPilot: refused as a no-go app, and noted', async () => {
  const r = desktopRig();
  const open = await noted(() => rejects(r.call('desktop_open_application', { app: 'MoPilot' }), 'refused', SELF_HINT));
  assert.deepEqual(open, [{ reason: 'self', app: 'MoPilot', name: 'MoPilot' }]);
  await r.grant();
  const key = await noted(() => rejects(r.call('desktop_key', { app: 'ai.mopilot.code', text: 'cmd+n' }), 'refused', SELF_HINT));
  assert.deepEqual(key, [{ reason: 'self', app: 'ai.mopilot.code', name: 'MoPilot' }]);
  // another app that isn't granted is still "not granted": the user may grant it
  await rejects(r.call('desktop_open_application', { app: 'Mail' }), 'denied', /isn't granted/);
});

test('a desktop_app_* call naming MoPilot: refused as a no-go app, and noted', async () => {
  const r = appsRig();
  const seen = await noted(() => rejects(r.call('desktop_app_screenshot', { app: 'com.github.Electron' }), 'refused', SELF_HINT));
  assert.deepEqual(seen, [{ reason: 'self', app: 'com.github.Electron', name: 'MoPilot' }]);
  await rejects(r.call('desktop_app_screenshot', { app: 'Pages' }), 'denied', /isn't granted/);
});

test('a computer_* call on an app the user blocked: refused, and noted with the app’s name', async () => {
  const helper: any = {
    running: true,
    start: async () => ({}),
    targetInfo: async () => ({ bundleId: 'com.apple.Notes', name: 'Notes', pid: 5 }),
    permissionStatus: async () => ({}),
  };
  const cu = new ComputerUse({
    helper,
    grants: { forChat: () => [], deny: () => ['com.apple.Notes'], grant: () => {} },
    broker: { ask: async () => ({ decision: 'deny' }) },
    session: () => ({ modality: 'image' }),
    onActivity: () => {},
    settleMs: 0,
    waitMs: 0,
    pollMs: 1,
  });
  const by = Object.fromEntries(cu.tools().map((t: any) => [t.name, t.handler]));
  const seen = await noted(() =>
    assert.rejects(
      by.computer_click({ x: 1, y: 1 }, { chatId: 'c' }),
      (e: any) => e.code === 'blocked' && /Notes is blocked/.test(e.message),
    ),
  );
  assert.deepEqual(seen, [{ reason: 'blocked', app: 'Notes', name: 'Notes' }]);
});
