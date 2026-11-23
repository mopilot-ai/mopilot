// A chat on a machine keeps /goal and /init as this app's own commands (src/session/harness/acp.ts acpRegistry, src/harness/commands.ts machineCommands): the chat is drawn as an ACP chat, whose registry used to send every command it did not list to the agent as text, so /goal went out as typed and /init never reached runInit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/harness-logic-fakes.ts';

const acp = await import('../src/session/harness/acp.ts');

test('a machine chat’s /goal and /init are this app’s own, typed or listed: they are not sent to the agent as text', () => {
  // the shape of a chat started from the local Codex row: `acp:host-codex:<uuid>`, whose agent has pushed no command list yet
  for (const [id, commands] of [
    ['host-codex', null],
    ['host-claude', null],
    [
      'host-codex',
      [{ name: 'goal', description: 'the agent’s own' }, { name: 'init', description: 'the agent’s own' }, { name: 'review' }],
    ],
  ] as const) {
    const goal = acp.acpTyped('/goal make it SLOW', id, commands as any);
    assert.deepEqual([goal.kind, (goal as any).command.name, (goal as any).args], ['rpc', 'goal', 'make it SLOW'], `${id} /goal`);
    const init = acp.acpTyped('/init extra', id, commands as any);
    assert.deepEqual([init.kind, (init as any).command.name, (init as any).args], ['polyfill', 'init', 'extra'], `${id} /init`);
    assert.deepEqual(
      acp
        .acpRegistry(id, commands as any)
        .menu.filter((c) => ['goal', 'init'].includes(c.name))
        .map((c) => c.dispatch),
      ['rpc', 'polyfill'],
    );
  }
  // the init line names the file for the agent; the agent's other commands go through as before
  assert.match(acp.acpRegistry('host-claude', null).menu.find((c) => c.name === 'init')!.description, /CLAUDE\.md/);
  assert.match(acp.acpRegistry('host-codex', null).menu.find((c) => c.name === 'init')!.description, /AGENTS\.md/);
  assert.equal(acp.acpTyped('/review now', 'host-codex', [{ name: 'review' }] as any).kind, 'passthrough');
  // a basic agent of this Mac has neither as its own: /goal and /init go to it as text, and its own list says what it has
  assert.equal(acp.acpTyped('/goal x', 'kimi', null).kind, 'passthrough');
  assert.equal(acp.acpTyped('/init', 'kimi', [{ name: 'init' }] as any).kind, 'passthrough');
});
