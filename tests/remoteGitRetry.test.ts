// Recovery binds to the actual failed turn from each harness producer, independent of wall-clock units/skew, and keeps the draft intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement as h } from 'react';
import { mockStore, autoMock, render, resetStore, setStore, settle, callsTo } from './support/thread-kit.ts';
import { mockSource } from './support/stubs.ts';
import { useFakeNative } from './support/ports/native.ts';
import { buildTurns } from './support/claude-translate.ts';
import { turnFromServer } from '../shared/codexTurns.mjs';
import { identityKey } from '../shared/identityKey.mjs';

mockStore();
mockSource('src/lib/host.ts', { useHostAccess: () => true });
const machine = { id: 'ssh:box', name: 'Build box', away: false };
autoMock('src/lib/chatMachine.ts', 'chatMachine', { useChatMachine: () => ({ machine, pending: false }) });
const { GitSignInNote } = await import('../src/components/composer/GitSignInNote.tsx');
const { buildAcpTurns } = createRequire(import.meta.url)('../electron/harness/items/acpTranslator.cjs');
const LINE =
  'MoPilot: git has no sign-in on this machine for https://github.com. Sign in on this machine in MoPilot, then retry the operation.';

function producedTurns() {
  const timestamp = '2026-11-20T08:00:00.000Z';
  const claude = buildTurns(
    [
      { type: 'user', uuid: 'u1', timestamp, message: { role: 'user', content: 'push' }, parent_tool_use_id: null },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp,
        message: { id: 'm1', content: [{ type: 'tool_use', id: 'cmd', name: 'Bash', input: { command: 'git push' } }] },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        uuid: 'r1',
        timestamp,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cmd', content: LINE, is_error: true }] },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp,
        message: { id: 'm2', content: [{ type: 'text', text: 'Sign-in needed.' }] },
        parent_tool_use_id: null,
      },
    ],
    'claude:chat',
    '/repo',
  )[0];
  const acp = buildAcpTurns(
    [
      { t: 'user', turnId: 'acp-turn', user: { id: 'u', content: [{ type: 'text', text: 'push' }] }, at: Date.parse(timestamp) },
      {
        t: 'update',
        turnId: 'acp-turn',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool',
          title: 'git push',
          kind: 'execute',
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: LINE } }],
        },
      },
      { t: 'end', turnId: 'acp-turn', stopReason: 'end_turn', at: Date.parse(timestamp) },
    ],
    'acp:chat',
    '/repo',
  )[0];
  const codex = turnFromServer({
    id: 'codex-turn',
    status: 'completed',
    completedAt: Date.parse(timestamp) / 1000,
    startedAt: Date.parse(timestamp) / 1000 - 5,
    durationMs: 5000,
    error: null,
    items: [
      {
        id: 'cmd',
        type: 'commandExecution',
        command: 'git push',
        aggregatedOutput: LINE,
        status: 'completed',
        pluginId: null,
        scriptPath: null,
        cwd: '/repo',
        processId: null,
        source: 'agent',
        commandActions: [],
        exitCode: 128,
        durationMs: 0,
      },
    ],
  });
  return [codex, claude, acp];
}

test('Codex, Claude and ACP failures use operation identity, so a historical sign-in never resolves a new turn despite clock skew', async (t) => {
  const api = useFakeNative(t, {
    host: {
      signinViews: async () => [
        { hostId: machine.id, harness: 'git:github.com', state: 'signed-in', attemptId: 'old', recoveryKeys: ['older-turn'], codes: [] },
      ],
    },
  });
  for (const turn of producedTurns()) {
    resetStore();
    setStore({ runtime: { chat: { activeTurnId: null, turns: [turn] } } });
    const ui = await render(h(GitSignInNote, { threadId: 'chat' }));
    assert.match(ui.host.textContent!, /Git isn’t signed in/, `failed turn ${turn.id} remains unresolved`);
    assert.equal(ui.host.querySelector('.fa-dont')?.textContent, 'Sign in to GitHub');
    const recoveryKeys = [identityKey('chat', machine.id, turn.id, 'github.com')];
    await settle(() =>
      api.emit('host.onSignin', {
        hostId: machine.id,
        harness: 'git:github.com',
        state: 'failed',
        reason: 'host_update',
        recoveryKeys,
      }),
    );
    const settings = [...ui.host.querySelectorAll('button')].find((b) => b.textContent === 'My machines')!;
    const retriesBeforeSettings = callsTo('store:giveBackToComposer').length;
    await settle(() => settings.click());
    assert.deepEqual(callsTo('store:navigate').at(-1), [{ name: 'settings', section: 'connections' }]);
    assert.deepEqual(api.callsTo('host.update'), []);
    assert.equal(callsTo('store:giveBackToComposer').length, retriesBeforeSettings);
    await settle(() =>
      api.emit('host.onSignin', {
        hostId: machine.id,
        harness: 'git:github.com',
        state: 'signed-in',
        attemptId: 'current',
        recoveryKeys,
        codes: [],
      }),
    );
    assert.match(ui.host.textContent!, /Git is signed in/);
    assert.equal(ui.host.querySelector('button'), null, 'no follow-up action is required after sign-in');
    assert.equal(callsTo('store:giveBackToComposer').length, 0);
    await settle(() => setStore({ runtime: { chat: { activeTurnId: 'new-turn', turns: [turn] } } }));
    assert.equal(ui.host.querySelector('[data-git-signin-note]'), null);
    await ui.unmount();
  }
});
