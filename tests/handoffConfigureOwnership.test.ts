// Independent issue1584 review: Chrome handoff rollback composes with the actual BrowserControl sequence owner.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { BrowserControl } = require('../electron/capabilities/browser/control.cjs');
const { chromeHandoff } = require('../electron/capabilities/browser/handoff.cjs');

for (const userChanges of [false, true]) {
  test(`real configure rollback ${userChanges ? 'preserves the newer user preference and sequence' : 'restores its own superseded handoff only'}`, async () => {
    const schemas = deferred();
    let waiting = false;
    const tools = new Map();
    const chrome = {
      tools: () => {
        waiting = true;
        return schemas.promise;
      },
      stopAll() {},
    };
    const control = new BrowserControl({
      registry: {
        register(t: any) {
          tools.set(t.name, t);
          return () => tools.delete(t.name);
        },
      },
      panel: {},
      grants: {},
      chromeGrants: {},
      chrome,
      isEnabled: () => true,
    });
    await control.configure('builtin');
    let prefs = { channel: 'builtin', profileDir: 'old' };
    let owner = 'segment-a';
    const committed: unknown[] = [],
      moved: unknown[] = [];
    const handoff = chromeHandoff({
      browserWindows: { owned() {} },
      chromeChannel: { has: () => true, instance: async () => ({ call: async () => ({}) }) },
      browserControl: control,
      isEnabled: () => true,
      getPrefs: () => prefs,
      commitPrefs: (p: any) => {
        committed.push(p);
        prefs = p;
      },
      changed() {},
      route: () => 'your-chrome',
      owner: () => owner,
      signinMoved: (...args: unknown[]) => moved.push(args),
    });
    const run = handoff({ chatId: `rollback-${userChanges}`, url: 'https://site.test' });
    await waitFor(() => waiting, 'the handoff to reach the real schema load');
    assert.equal(waiting, true, 'handoff reached asynchronous real schema load');
    owner = 'segment-b';
    if (userChanges) {
      prefs = { channel: 'builtin', profileDir: 'new-user-choice' };
      await control.configure('builtin');
    }
    const seqBeforeAnswer = control.seq;
    schemas.resolve([{ name: 'browser_snapshot', inputSchema: { type: 'object', properties: {} } }]);
    const result = await run;
    assert.equal(result.ok, false);
    assert.match(result.message, /controller changed/);
    assert.equal(control.active, 'builtin');
    assert.equal(control.wanted, 'builtin');
    assert.equal(control.seq, userChanges ? seqBeforeAnswer : seqBeforeAnswer + 1);
    assert.equal(prefs.profileDir, userChanges ? 'new-user-choice' : 'old');
    assert.deepEqual(committed, []);
    assert.deepEqual(moved, []);
  });
}
