// Control notifications name the app as a person reads it: a bundle id (Codex Computer Use) is resolved first, and a chat done before that is never noted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ControlNotifications } = require('../electron/capabilities/controlNotifications.cjs');
const { AppIdentity } = require('../electron/capabilities/appIdentity.cjs');

function rig() {
  const sent: string[] = [];
  const resolves: ((name: string) => void)[] = [];
  const n = new ControlNotifications({
    notify: (_kind: string, _chat: string, o: any) => sent.push(o.title),
    agentName: () => 'Codex',
    appName: (app: string) => (app.includes('.') ? new Promise<string>((r) => resolves.push(r)) : app),
  });
  return { n, sent, resolves };
}

test('a name is noted at once; a bundle id once its name arrives, and done follows it (the text names the agent, not the app)', async () => {
  const r = rig();
  r.n.started('c1', 'Notes', { background: true });
  assert.deepEqual(r.sent, ['Codex is using your computer']);
  const p = r.n.started('c1', 'com.anthropic.claudefordesktop', { background: true });
  assert.equal(r.n.started('c1', 'com.anthropic.claudefordesktop', { background: true }), null, 'once per app');
  assert.equal(r.sent.length, 1, 'not noted before its name arrives');
  r.resolves[0]('Claude');
  await p;
  r.n.finished('c1', 'com.anthropic.claudefordesktop');
  assert.deepEqual(r.sent.slice(1), ['Codex is using your computer', 'Codex is done using your computer']);
});

test('done before the name arrives: neither note is shown', async () => {
  const r = rig();
  const p = r.n.started('c1', 'com.x.y', { background: true });
  assert.equal(r.n.finished('c1', 'com.x.y'), null);
  r.resolves[0]('Y');
  assert.equal(await p, null);
  assert.deepEqual(r.sent, []);
});

test('AppIdentity.label: a name as it is, a bundle id by its resolved name, else "an app"', async () => {
  const id = new AppIdentity({ run: async () => '', exists: () => false });
  assert.equal(id.label('Notes'), 'Notes');
  assert.equal(await id.label('com.nothing.here'), 'an app');
  id.cache.set('com.anthropic.claudefordesktop', Promise.resolve({ name: 'Claude', bundleId: null, icon: null }));
  assert.equal(await id.label('com.anthropic.claudefordesktop'), 'Claude');
});
