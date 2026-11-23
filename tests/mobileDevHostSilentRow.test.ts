// The dev host's silent-row scenario: rows reach the Mac's chat with no live event, so the phone's re-read net can be seen working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createScenarios } from '../scripts/mobile-dev-host/scenarios.mjs';

function rig() {
  const app = createFakeApp({ repo: '/repo', now: () => 9_000_000, sleep: async () => undefined, status: async () => '' });
  const events: unknown[] = [];
  app.bind({ attached: true, onFeedEvent: (e: unknown) => events.push(e), onSessionPatch: () => undefined });
  const scenarios = createScenarios({ app, now: () => 9_000_000, after: () => undefined });
  return { app, events, run: (args?: string[]) => scenarios.run('silent-row', args) as string };
}

test('silent-row stores a message and its answer in the newest chat and sends no live event', () => {
  const r = rig();
  const newest = [...r.app.chats.values()].sort((a: any, b: any) => b.at - a.at)[0];
  const before = newest.rows.length;
  const said = r.run();
  assert.match(said, new RegExp(`chat ${newest.id}: two rows stored, no live event`));
  assert.deepEqual(
    newest.rows.slice(before).map((x: any) => [x.role, x.text]),
    [
      ['user', 'Sent from the Mac'],
      ['assistant', 'Got it: Sent from the Mac'],
    ],
  );
  assert.equal(newest.at, 9_000_000);
  assert.deepEqual(r.events, [], 'the phone is told nothing');
});

test('silent-row names a chat and its words, and a wrong chat says what to do', () => {
  const r = rig();
  const id = [...r.app.chats.keys()][0];
  r.run([id, 'hello', 'there']);
  assert.equal(r.app.chats.get(id).rows.at(-2).text, 'hello there');
  assert.throws(() => r.run(['nope']), /No chat nope\. Say run chats/);
  r.app.chats.clear();
  assert.throws(() => r.run(), /There is no chat/);
});
