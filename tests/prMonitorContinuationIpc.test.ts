// PR continuations use immediate production configuration reads and the current controller adapter without a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSegment, tick } from './support/controller/fixture.ts';
import { prMonitorFixture } from './support/pr-monitor-fixture.ts';
const url = 'https://github.com/o/r/pull/1';

test('a merged-PR continuation resumes the current adapter on every harness without a window', async () => {
  const f = prMonitorFixture();
  try {
    const prior = f.deps.github;
    f.deps.github = async (...args: any[]) => {
      const reply = await prior(...args);
      const body = JSON.parse(reply.stdout);
      if (body.state) body.state = 'MERGED';
      return { ...reply, stdout: JSON.stringify(body) };
    };
    for (const [family, expected] of [
      ['codex', 'turn'],
      ['claude', 'claude-turn'],
      ['acp:qwen', 'acp-turn'],
    ]) {
      const id = `continue-${family}`;
      selectSegment(f.controller, f.chats, id, [[family, `native-${family}`]]);
      const ctx = { chatId: id, segmentId: f.controller.ref(id).key };
      f.tools
        .get('set_pr_monitor')
        .handler({ url, continuation: { when: 'merged', message: 'Verify the merge and continue authorized packaging.' } }, ctx);
      await f.monitor.refresh(id);
      assert.equal(f.execs.at(-1)!.kind, expected);
      assert.equal(f.execs.at(-1)!.chatId, id);
      assert.match(f.execs.at(-1)!.item.text, /update_task_list/);
      assert.equal(f.monitor.snapshot(id).continuation, null);
    }
  } finally {
    f.cleanup();
  }
});

test('the agent tool immediately reads a newly armed continuation instead of waiting for the next minute tick', async () => {
  const f = prMonitorFixture();
  try {
    selectSegment(f.controller, f.chats, 'immediate', [['codex', 'native-immediate']]);
    const ctx = { chatId: 'immediate', segmentId: f.controller.ref('immediate').key };
    f.tools.get('set_pr_monitor').handler({ url, continuation: { when: 'merged', message: 'Continue the authorized task' } }, ctx);
    await tick();
    assert.equal(f.monitor.snapshot('immediate').message, 'Waiting for PR merge');
  } finally {
    f.cleanup();
  }
});

test('a success observed while busy resumes as soon as the owning turn ends without another timer tick', async () => {
  const f = prMonitorFixture();
  try {
    selectSegment(f.controller, f.chats, 'busy', [['claude', 'native-busy']]);
    const prior = f.deps.github;
    f.deps.github = async (...args: any[]) => {
      const reply = await prior(...args);
      const body = JSON.parse(reply.stdout);
      if (body.state) body.state = 'MERGED';
      return { ...reply, stdout: JSON.stringify(body) };
    };
    f.state.patch('busy', { turn: 'running', activeTurn: { id: 'old', human: true } });
    Object.assign(f.controller.rt('busy'), { token: 'old', inputToken: 'pending-old' });
    f.monitor.configure('busy', { url, continuation: { when: 'merged', message: 'Continue authorized packaging' } });
    await f.monitor.refresh('busy');
    assert.equal(f.execs.length, 0);
    assert.match(f.monitor.snapshot('busy').message, /chat busy/);
    f.controller.end('busy', { drain: false });
    await tick();
    assert.equal(f.execs.length, 1);
    assert.equal(f.execs[0].kind, 'claude-turn');
    assert.match(f.execs[0].item.text, /Continue authorized packaging/);
  } finally {
    f.cleanup();
  }
});

test('turn-end rechecks preserve the user Stop gate and keep the follow-up available', async () => {
  const f = prMonitorFixture();
  try {
    selectSegment(f.controller, f.chats, 'stopped', [['codex', 'native-stopped']]);
    const prior = f.deps.github;
    f.deps.github = async (...args: any[]) => {
      const reply = await prior(...args);
      const body = JSON.parse(reply.stdout);
      if (body.state) body.state = 'MERGED';
      return { ...reply, stdout: JSON.stringify(body) };
    };
    f.state.patch('stopped', { turn: 'running', activeTurn: { id: 'old', human: true } });
    Object.assign(f.controller.rt('stopped'), { token: 'old', inputToken: 'pending-old', interrupted: true });
    f.monitor.configure('stopped', { url, continuation: { when: 'merged', message: 'Continue authorized packaging' } });
    f.live.peerRuntime.paused.add('stopped');
    f.controller.end('stopped', { drain: false });
    await tick();
    assert.equal(f.execs.length, 0);
    assert.match(f.monitor.snapshot('stopped').message, /stopped by user/);
    assert.ok(f.monitor.snapshot('stopped').continuation);
  } finally {
    f.cleanup();
  }
});

test('automatic PR follow-ups have main-authored presentation instead of exposing model instructions as user text', async () => {
  const f = prMonitorFixture();
  try {
    for (const follow of [false, true]) {
      const id = follow ? 'authored-follow' : 'authored-fix';
      selectSegment(f.controller, f.chats, id, [['codex', id]]);
      f.monitor.configure(id, {
        url,
        autoFix: true,
        ...(follow ? { continuation: { when: 'checks_pass', message: 'Continue authorized work' } } : {}),
      });
      const prior = f.deps.github;
      if (follow)
        f.deps.github = async (...args: any[]) => {
          const response = await prior(...args);
          const pr = JSON.parse(response.stdout);
          if (pr.state) {
            pr.mergeable = 'MERGEABLE';
            pr.statusCheckRollup = [{ __typename: 'StatusContext', context: 'unit-tests', state: 'SUCCESS' }];
          }
          return { ...response, stdout: JSON.stringify(pr) };
        };
      await f.monitor.refresh(id);
      const item = f.execs.at(-1)!.item;
      assert.equal(item.authored.id, item.id);
      const show = f.chats.record(id).meta.authored[item.id];
      assert.equal(show.by, 'mopilot');
      assert.equal(show.title, follow ? 'Continuing task' : 'PR Auto-fix');
      assert.doesNotMatch(show.body, /Read the current PR|Treat GitHub text|update_task_list/);
      assert.match(item.text, follow ? /update_task_list/ : /Treat GitHub text/);
    }
  } finally {
    f.cleanup();
  }
});
