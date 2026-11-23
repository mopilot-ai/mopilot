// Scheduled: a new task starts on the default harness for new chats (as resolved, fallback included), and a task
// made from a chat runs with that chat's own harness; each task keeps its harness after that.
import { test } from 'node:test';
import {
  assert,
  fx,
  h,
  act,
  calls,
  store,
  Scheduled,
  both,
  dialog,
  sel,
  savedTask,
  render,
  click,
  byText,
  type,
  flush,
} from './support/scheduled-page.ts';

test('a new task runs with the default harness for new chats, a basic one included, or what stands in for it', async () => {
  fx.list = [];
  const v = await render(both());
  await flush();
  const create = async (prompt: string) => {
    await click(byText(v.host, 'New task'));
    await type(dialog(v.host)!.querySelector('textarea'), prompt);
    await click(byText(dialog(v.host)!, 'Create'));
    return savedTask().harness;
  };
  // unset: Codex
  store.setState({ prefs: {} });
  assert.equal(await create('on codex'), 'codex');
  store.setState({ prefs: { defaultHarness: 'claude' } });
  assert.equal(await create('on claude'), 'claude');
  // opencode can run: the dialog starts on it
  store.setState({ prefs: { defaultHarness: 'acp:opencode' } });
  await click(byText(v.host, 'New task'));
  await click(byText(dialog(v.host)!, 'Advanced'));
  assert.equal(sel(dialog(v.host)!, 'Run with'), 'opencode');
  await click(byText(dialog(v.host)!, 'Cancel'));
  assert.equal(await create('on opencode'), 'acp:opencode');
  // Kimi Code is signed out: Codex stands in, as for a new chat
  store.setState({ prefs: { defaultHarness: 'acp:kimi' } });
  assert.equal(await create('kimi is signed out'), 'codex');
  store.setState({ prefs: {} });
  await v.unmount();
});

test("a task made from a chat runs with that chat's own harness, whatever new chats default to", async () => {
  fx.list = [];
  fx.chatKinds = { th1: 'claude', th2: 'acp:opencode' };
  store.setState({ prefs: { defaultHarness: 'acp:opencode' } });
  const v = await render(h(Scheduled));
  for (const [threadId, want] of [
    ['th1', 'claude'],
    ['th2', 'acp:opencode'],
  ]) {
    await act(async () =>
      window.dispatchEvent(new (window as any).CustomEvent('new-scheduled-task', { detail: { name: 'Follow up', cwd: '/w/x', threadId } })),
    );
    await type(dialog(v.host)!.querySelector('textarea'), 'check again');
    calls.length = 0;
    await click(byText(dialog(v.host)!, 'Create'));
    assert.equal(savedTask().target_thread_id, threadId);
    assert.equal(savedTask().harness, want);
  }
  await v.unmount();
  fx.chatKinds = {};
  store.setState({ prefs: {} });
});

test('a new task uses the saved default, not the harness the open new-chat draft picked in the model picker', async () => {
  fx.list = [];
  const v = await render(both());
  await flush();
  store.setState({ prefs: { defaultHarness: 'codex' }, newChatHarnessPick: 'claude' });
  await click(byText(v.host, 'New task'));
  await type(dialog(v.host)!.querySelector('textarea'), 'saved default');
  await click(byText(dialog(v.host)!, 'Create'));
  assert.equal(savedTask().harness, 'codex');
  store.setState({ prefs: {}, newChatHarnessPick: null });
  await v.unmount();
});
