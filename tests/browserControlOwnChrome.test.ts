// Where MoPilot's own extension serves the user's Chrome, choosing Chrome never starts the Playwright relay; the note is told it is the user's preference (electron/capabilities/browser/control.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserControl, effectiveChannel } = require('../electron/capabilities/browser/control.cjs');
const { userChromeOf } = require('../electron/capabilities/contract/surfaceNote.cjs');

function control(ownChrome?: () => boolean) {
  const stops: string[] = [];
  const c = new BrowserControl({
    registry: { register: () => () => undefined },
    panel: {},
    grants: {},
    chromeGrants: {},
    chrome: { tools: async () => [{ name: 'browser_click', inputSchema: { type: 'object' } }], stopAll: () => stops.push('stop') },
    isEnabled: () => true,
    ...(ownChrome ? { ownChrome } : {}),
  });
  return { c, stops };
}

test('effectiveChannel: Chrome chosen runs the Playwright relay only where MoPilot’s extension doesn’t serve Chrome', () => {
  const on = () => true;
  assert.equal(effectiveChannel('chrome', on), 'chrome');
  assert.equal(effectiveChannel('chrome', on, false), 'chrome');
  assert.equal(effectiveChannel('chrome', on, true), 'builtin');
  assert.equal(effectiveChannel('builtin', on, true), 'builtin');
});

test('Chrome chosen with the extension serving: the built-in tools run, nothing drives Chrome over the relay, and Chrome is the preference', async () => {
  const { c, stops } = control(() => true);
  assert.equal(await c.configure('chrome'), 'builtin');
  assert.equal(c.drivesUserChrome(), false);
  assert.equal(c.userChrome(), 'preferred');
  assert.deepEqual(stops, ['stop'], 'the relay’s Chrome instances are let go');
  await c.configure('builtin');
  assert.equal(c.userChrome(), false);
  // a channel this build doesn't know runs the built-in browser
  assert.equal(await c.configure('firefox'), 'builtin');
  assert.equal(c.userChrome(), false);
});

test('without the extension (no rule, or one that says it doesn’t serve Chrome), Chrome chosen drives it over the relay as before', async () => {
  for (const own of [undefined, () => false]) {
    const { c } = control(own);
    await c.configure('chrome');
    assert.equal(c.drivesUserChrome(), true);
    assert.equal(c.userChrome(), true);
  }
});

test('userChromeOf: the control’s own answer, a control without it by whether it drives Chrome, none as false', () => {
  assert.equal(userChromeOf({ drivesUserChrome: () => false, userChrome: () => 'preferred' }), 'preferred');
  assert.equal(userChromeOf({ drivesUserChrome: () => true }), true);
  assert.equal(userChromeOf(null), false);
});
