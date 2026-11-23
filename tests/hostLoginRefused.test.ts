// A Claude Code login the provider refuses for its organization (#4908): learned from the failed turn, the Host stops offering the agent as ready before the next send, says why, and takes it back once the login works again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportedHarness } from '../host/src/harnessState.mjs';
import { agentsOf } from '../shared/host/agentReadiness.mjs';
import { codeOfText } from '../shared/host/turnErrorCode.mjs';
import { setup, keyOf, idle } from './support/host/claudeKit.ts';

const row = (h: ReturnType<typeof setup>) =>
  reportedHarness({ id: 'claude', detected: true, signedIn: true }, {
    codex: { models: async () => [] },
    sessions: h.sessions,
    leases: { has: () => false },
    credentials: undefined,
  } as any) as Promise<any>;

test('a turn the provider refuses for the login’s organization ends as an auth failure and the agent then reads as not ready, with why', async () => {
  const h = setup();
  try {
    assert.equal((await row(h)).signedIn, true, 'ready before anything was refused');
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'REFUSE-LOGIN', cwd: h.dir });
    await idle(h, key);
    const [end] = h.of('turnEnd', key);
    assert.equal(end.stopReason, 'error');
    assert.equal(end.error.code, 'auth', 'the clients act on the code, not on the words');
    // the next status says it before the next send
    const after = await row(h);
    assert.deepEqual([after.signedIn, after.reason], [false, 'login-refused']);
    // the shared reader of a machine's agents puts it in the person's words
    const [agent] = agentsOf([after], 'mini');
    assert.equal(agent.state, 'signin');
    assert.match(agent.reason, /Claude Code.*mini.*can.t run/i);
    assert.match(agent.reason, /Sign in again on mini/);
    // a turn that answers proves the login works: what the failed one marked is over
    const next = keyOf();
    await h.sessions.chatRuntime.send({ key: next, text: 'hello again', cwd: h.dir });
    await idle(h, next);
    const answered = await row(h);
    assert.deepEqual([answered.signedIn, answered.reason], [true, undefined]);
    // and a login signed in again on the machine takes a later refusal back as well
    const third = keyOf();
    await h.sessions.chatRuntime.send({ key: third, text: 'REFUSE-LOGIN', cwd: h.dir });
    await idle(h, third);
    assert.equal((await row(h)).signedIn, false);
    h.family.loginWorks();
    const healed = await row(h);
    assert.deepEqual([healed.signedIn, healed.reason], [true, undefined]);
  } finally {
    await h.close();
  }
});

test('other agents and a key-run turn are not marked by it, and the card’s words read as a sign-in problem', async () => {
  const h = setup();
  try {
    const gemini = await reportedHarness({ id: 'gemini', detected: true, signedIn: true }, {
      codex: { models: async () => [] },
      sessions: h.sessions,
      leases: { has: () => false },
    } as any);
    assert.equal(gemini.signedIn, true);
    assert.equal(
      codeOfText('Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead'),
      'auth',
    );
  } finally {
    await h.close();
  }
});
