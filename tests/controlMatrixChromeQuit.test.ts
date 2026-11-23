// CM-Y06b (#1825): quitting waits only for the Claude Code CLIs whose exit still matters to the app (a running turn,
// background work, a Claude in Chrome group or call); an idle one finishes exiting on its own after the app is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setHoldTurns, claude, until, tick, opened, claudeChrome, groupHolds } from './support/claude-chrome-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

test('CM-Y06b: quitting waits only for a CLI with a tab group, a Chrome call under way or background work; an idle one finishes exiting on its own', async () => {
  const kinds: [string, (q: any) => void][] = [
    ['group', (q) => groupHolds(q, 't1', ['https://shop.test/cart'])],
    [
      'call',
      (q) =>
        q.push({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'c1', name: 'mcp__claude-in-chrome__navigate', input: {} }] },
        }),
    ],
    [
      'task',
      (q) =>
        q.push({
          type: 'system',
          subtype: 'task_started',
          task_id: 'bg1',
          task_type: 'local_bash',
          tool_use_id: 'tb1',
          description: 'npm run dev',
        }),
    ],
  ];
  for (const [kind, give] of [...kinds, ['turn', () => {}] as [string, (q: any) => void]]) {
    // a turn still running: its prompt gets no result
    setHoldTurns(kind === 'turn');
    const held = await claudeChrome(`y06b-${kind}`, `chat-y06b-${kind}`);
    setHoldTurns(false);
    give(held.q);
    const plain = await claudeChrome(`y06b-${kind}-idle`, `chat-y06b-${kind}-idle`);
    await tick(30);
    const [heldExit, plainExit] = [opened(), opened()];
    held.q.exitGate = heldExit.promise;
    plain.q.exitGate = plainExit.promise;
    // a grace far longer than the test: only a CLI the quit waits for holds it
    let quit = false;
    const done = claude.closeAll(60_000).then(() => (quit = true));
    await tick(30);
    assert.equal(quit, false, `the quit waits for the CLI with a ${kind}`);
    heldExit.resolve();
    await done;
    assert.deepEqual(held.q.log, kind === 'turn' ? ['interrupt', 'eof', 'exit hooks', 'close'] : ['eof', 'exit hooks', 'close']);
    assert.deepEqual(plain.q.log, ['eof'], 'the quit went on while the idle CLI was still in its exit hooks');
    plainExit.resolve();
    await until('the idle CLI to finish', () => plain.q.log.includes('close'));
    assert.deepEqual(plain.q.log, ['eof', 'exit hooks', 'close']);
  }
});
