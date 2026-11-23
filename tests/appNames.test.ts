// appNames.ts: what computer-use UI calls an app: main's display name and icon once known, a common app's name, never a raw bundle id.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/async-scenarios.ts';
import { installNative } from '../src/lib/native.ts';

const { appLabel, appIcon, requestApp, resetAppNames } = await import('../src/lib/appNames.ts');

let asked: string[] = [];

beforeEach(() => {
  asked = [];
  installNative({
    computer: {
      appIdentity: async (app: string) => {
        asked.push(app);
        if (app === 'com.broken.thing') throw new Error('down');
        if (app === 'com.anthropic.claudefordesktop') return { name: 'Claude', bundleId: app, icon: 'data:icon' };
        if (app === 'Weird') return { name: 42 };
        if (app === 'NoIcon') return { name: 'No Icon' };
        return null;
      },
    },
  } as any);
  resetAppNames();
});

test('before main answers: a common app by its name, an app file without ".app", "App" for an unknown bundle id, a name as given', () => {
  assert.equal(appLabel('com.apple.MobileSMS'), 'Messages');
  assert.equal(appLabel('Notes.app'), 'Notes');
  assert.equal(appLabel('com.example.thing'), 'App');
  assert.equal(appLabel(' Notes '), 'Notes');
});

test("main's answer replaces the fallback; asked once per app; failures and junk keep the fallback", async () => {
  assert.equal(appLabel('com.anthropic.claudefordesktop'), 'App');
  appLabel('com.broken.thing');
  appLabel('Weird');
  appLabel('NoIcon');
  await tick();
  assert.equal(appLabel('NoIcon'), 'No Icon');
  assert.equal(appIcon('NoIcon'), null);
  assert.equal(appLabel('com.anthropic.claudefordesktop'), 'Claude');
  assert.equal(appIcon('com.anthropic.claudefordesktop'), 'data:icon');
  assert.equal(appLabel('com.broken.thing'), 'App');
  assert.equal(appLabel('Weird'), 'Weird');
  assert.equal(appIcon('Weird'), null);
  assert.deepEqual(asked, ['com.anthropic.claudefordesktop', 'com.broken.thing', 'Weird', 'NoIcon']);
});

test('nothing to ask: an empty name, or no window (tests, tooling)', () => {
  requestApp('  ');
  installNative(null);
  assert.equal(appLabel('com.example.x'), 'App');
  assert.deepEqual(asked, []);
});
