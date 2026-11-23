// The running turn's own command is not a background terminal (src/harness/codexTranslate.ts, #1940): the tasks poller
// and the summary panel leave it out until its turn ends, so it reads "Running <cmd>" and Stop ends it with the turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leftInBackground, runningTurnCommands } from '../src/harness/codexTranslate.ts';

const term = (itemId: string) => ({ itemId, processId: `p-${itemId}`, command: itemId, cwd: '/', osPid: null });
const cmd = (id: string) => ({ type: 'commandExecution', id });

test("the running turn's command items, as a stable selection", () => {
  const turns = [
    { id: 'T0', items: [cmd('old')] },
    { id: 'T1', items: [cmd('a'), { type: 'agentMessage', id: 'm' }, null, cmd('b')] },
  ];
  assert.equal(runningTurnCommands({ turns, activeTurnId: 'T1' }), 'a\nb');
  assert.equal(runningTurnCommands({ turns, activeTurnId: null }), '');
  assert.equal(runningTurnCommands({ turns, activeTurnId: 'gone' }), '');
  assert.equal(runningTurnCommands(undefined), '');
});

test("terminals left in the background: all but the running turn's own", () => {
  const all = [term('old'), term('a'), term('b')];
  assert.deepEqual(
    leftInBackground(all, 'a\nb').map((t) => t.itemId),
    ['old'],
  );
  assert.equal(leftInBackground(all, ''), all);
});

test('a turn whose items have not changed is not scanned again, and a changed one is', () => {
  let reads = 0;
  const watched = (id: string) => ({
    get type() {
      reads += 1;
      return 'commandExecution';
    },
    id,
  });
  const items = [watched('a')];
  const rt = (list: unknown[]) => ({ turns: [{ id: 'T1', items: list }], activeTurnId: 'T1' });
  assert.equal(runningTurnCommands(rt(items)), 'a');
  assert.equal(runningTurnCommands(rt(items)), 'a');
  assert.equal(reads, 1);
  assert.equal(runningTurnCommands(rt([...items, cmd('b')])), 'a\nb');
  // a turn with no commands is remembered as '' rather than scanned each time
  const none = [{ type: 'agentMessage', id: 'm' }];
  assert.equal(runningTurnCommands(rt(none)), '');
  assert.equal(runningTurnCommands(rt(none)), '');
  // a turn record without items runs no command
  assert.equal(runningTurnCommands({ turns: [{ id: 'T1' } as never], activeTurnId: 'T1' }), '');
});
