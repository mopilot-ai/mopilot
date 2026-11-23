// electron/session/orchestration/service.cjs: a linked session runs on the harness of the chat that starts it; a
// harness the agent passes is honored only when the user's own words this turn name it (#2084), for a start, an
// offer and an own-initiative proposal alike, from a Codex, Claude Code or ACP parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const PARENTS = [
  ['claude', { kind: 'claude', id: 'c', key: 'claude:c' }, 'codex', 'startClaude'],
  ['codex', { kind: 'codex', id: 'x', key: 'x' }, 'claude', 'startCodex'],
  ['acp:kimi', { kind: 'acp:kimi', id: 'k', key: 'acp:kimi:k' }, 'codex', 'startAcp'],
] as const;

for (const [kind, ref, other, starts] of PARENTS) {
  test(`a ${kind} parent's agent can't move a linked session to ${other} on its own`, async () => {
    const h = orchestration({ said: () => 'please split the login fix into its own session' });
    h.refs.set('top', ref);
    h.userTurn();
    const r = await h.orch.start('top', { background: BACKGROUND, title: 'Fix', prompt: 'p', use_worktree: false, harness: other });
    assert.equal(r.harness, kind);
    assert.equal(h.log.find((l: any) => String(l[0]).startsWith('start'))[0], starts);
    assert.match(r.harness_ignored, new RegExp(`${other}.*user didn.t name it.*this chat's harness, ${kind}`));
  });

  test(`a ${kind} parent starts on ${other} when the user named it this turn`, async () => {
    const h = orchestration({
      said: (id: string) => (id === 'top' ? `run it in a ${other === 'codex' ? 'Codex' : 'Claude'} session` : ''),
    });
    h.refs.set('top', ref);
    h.userTurn();
    const r = await h.orch.start('top', { background: BACKGROUND, title: 'Fix', prompt: 'p', use_worktree: false, harness: other });
    assert.equal(r.harness, other);
    assert.equal(r.harness_ignored, undefined);
  });
}

test('the parent’s own harness passed explicitly is no choice at all, and no words are needed for it', async () => {
  const h = orchestration();
  h.refs.set('top', { kind: 'claude', id: 'c', key: 'claude:c' });
  h.userTurn();
  const r = await h.orch.start('top', { background: BACKGROUND, title: 'Fix', prompt: 'p', use_worktree: false, harness: 'claude' });
  assert.equal(r.harness, 'claude');
  assert.equal(r.harness_ignored, undefined);
});

test('an offer or own-initiative proposal keeps the parent’s harness unless the user named another', async () => {
  const h = orchestration({ said: () => 'maybe later' });
  h.refs.set('top', { kind: 'claude', id: 'c', key: 'claude:c' });
  h.userTurn();
  for (const initiation of ['offer', 'own_initiative']) {
    // an offer waits for the user's answer on its card: this one is left unanswered, so it returns with the card open
    const ac = new AbortController();
    ac.abort();
    const p = await h.orch.start(
      'top',
      { background: BACKGROUND, title: `T ${initiation}`, prompt: 'p', initiation, harness: 'codex' },
      { signal: ac.signal },
    );
    assert.equal(h.journal.proposal(p.task_id).args.harness, null, initiation);
    assert.match(p.harness_ignored, /codex/);
  }
});

test('a proposal saved before the rule keeps no harness the agent chose: its start runs on the parent’s', async () => {
  const h = orchestration();
  h.refs.set('top', { kind: 'claude', id: 'c', key: 'claude:c' });
  h.userTurn();
  h.journal.change((d: any) => {
    d.proposals.old = {
      parentId: 'top',
      kind: 'own_initiative',
      args: {
        title: 'Old',
        prompt: 'p',
        background: null,
        name: null,
        initiation: 'own_initiative',
        context: 'fresh',
        useWorktree: false,
        harness: 'codex',
      },
      status: 'open',
      createdAt: 1000,
      expiresAt: 9e15,
      chatId: null,
    };
  });
  // a copy of it, started with the harness the user picks on the card: that pick is the user's, so it stands
  h.journal.change((d: any) => {
    d.proposals.picked = { ...d.proposals.old, args: { ...d.proposals.old.args, title: 'Picked' } };
  });
  const r = await h.orch.act('old', 'start');
  assert.equal(r.harness, 'claude');
  assert.equal((await h.orch.act('picked', 'start', { harness: 'codex' })).harness, 'codex');
  // one the rule checked keeps the harness the user named
  const named = orchestration({ said: () => 'use codex for it' });
  named.refs.set('top', { kind: 'claude', id: 'c', key: 'claude:c' });
  named.userTurn();
  const p = await named.orch.start('top', {
    background: BACKGROUND,
    title: 'New',
    prompt: 'p',
    initiation: 'own_initiative',
    use_worktree: false,
    harness: 'codex',
  });
  assert.equal((await named.orch.act(p.task_id, 'start')).harness, 'codex');
});
