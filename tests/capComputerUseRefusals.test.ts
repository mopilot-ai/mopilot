// Computer use wired up in main (setupComputerUse) keeps a refused no-go app as one line in the chat (#1724): a tool call's
// refusal reaches the Registry's onNoGo, which notes it on the chat's running turn and tells every window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './support/computer-use-setup-rig.ts';

test('a no-go refusal is noted on the chat’s running turn, or its latest turn when none runs, and every window hears of it', () => {
  const r = rig();
  r.states.set('c1', { activeTurn: { id: 't9' } });
  const SELF = { reason: 'self', app: 'MoPilot', name: 'MoPilot' };
  r.registry.onNoGo('c1', SELF);
  r.registry.onNoGo('c2', { reason: 'blocked', app: 'Notes', name: 'Notes' });
  assert.deepEqual(
    r.meta.get('c1').notes.map((n: any) => [n.kind, n.text, n.turnId]),
    [['control', "Computer use can't control MoPilot itself.", 't9']],
  );
  assert.equal(r.meta.get('c2').notes[0].turnId, null);
  assert.deepEqual(
    r.log.filter((l) => l[1] === 'chats:changed').map((l) => l[2].id),
    ['c1', 'c2'],
  );
  assert.equal(r.runtime.refusals.note('c1', SELF), false, 'once per turn');
});
