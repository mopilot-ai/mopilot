// parents Sky matrix cases using shared fake harness and desktop fixtures.
import {
  test,
  assert,
  path,
  codexConnection,
  world,
  NativeCodexLifecycle,
  CodexThreadParents,
  codexParentLinks,
  SessionStore,
  ChatController,
  ChatsStore,
  tmp,
} from './fixture.ts';

export function registerParents() {
  test('CM-V08: guard: the tool injection, the plugin lifecycle and the controller resolve a sub-agent through one parent map, from every signal', async () => {
    const signals = {
      'thread/started parentThreadId': (child: string, parent: string) => ({
        method: 'thread/started',
        params: { thread: { id: child, parentThreadId: parent } },
      }),
      'thread/started thread_spawn': (child: string, parent: string) => ({
        method: 'thread/started',
        params: { thread: { id: child, source: { subAgent: { thread_spawn: { parent_thread_id: parent } } } } },
      }),
      'spawnAgent item': (child: string, parent: string) => ({
        method: 'item/started',
        params: { threadId: parent, turnId: 'p1', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: [child] } },
      }),
      'subAgentActivity item': (child: string, parent: string) => ({
        method: 'item/completed',
        params: { threadId: parent, turnId: 'p1', item: { type: 'subAgentActivity', agentThreadId: child, kind: 'interacted' } },
      }),
    };
    for (const [signal, make] of Object.entries(signals)) {
      const w = world();
      const conn = codexConnection(w, (id) => id, { chrome: true, computer: true });
      await conn.startThread();
      const root = 'cx-1';
      const child = `${root}-child`;
      const parents = conn.inj.parents;
      const lifecycle = new NativeCodexLifecycle({
        call: async () => ({ content: [] }),
        isNativeThread: (id: string) => conn.inj.isNativeThread(id),
        isLoadedThread: (id: string) => conn.inj.isLoadedThread(id),
        parents,
      });
      const state = new SessionStore();
      const chats = new ChatsStore(path.join(tmp(), 'threads'));
      chats.ensure(root);
      const controller = new ChatController({
        state,
        chats,
        codex: {},
        claudeTurns: {},
        acpTurns: {},
        switcher: {},
        claude: {},
        acp: {},
        parents,
      });
      const msg = make(child, root);
      // each sees the message in main's order: the injection's intercept, then the adapter's lifecycle, then the controller
      conn.inj.observe(msg);
      lifecycle.observe(msg);
      controller.onCodexMessage(msg);
      assert.equal(conn.inj.chatThreadOf(child), root, `${signal}: the injection`);
      assert.equal(conn.inj.isNativeThread(child), true, `${signal}: runs with its root's plugin`);
      assert.equal(lifecycle.subagents.get(child)?.parent, root, `${signal}: the lifecycle`);
      assert.equal(controller.requestChat(child), root, `${signal}: the controller`);
      // the sub-agent's approval card reaches the chat, whatever named its parent
      state.get(root);
      controller.onCodexMessage({ id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: child } });
      assert.deepEqual(
        state.get(root).approvals.map((a: any) => a.id),
        [41],
        `${signal}: the card`,
      );
    }
    // links are first-writer and acyclic; requests never link; a closed thread is no one's child
    const p = new CodexThreadParents();
    assert.deepEqual(p.observe(signals['spawnAgent item']('a', 'b')), [['a', 'b']]);
    assert.deepEqual(p.observe(signals['spawnAgent item']('a', 'c')), []);
    assert.deepEqual(p.observe(signals['spawnAgent item']('b', 'a')), []);
    assert.deepEqual(codexParentLinks({ id: 1, method: 'item/started', params: { threadId: 'b' } }), []);
    assert.deepEqual(codexParentLinks({ method: 'item/started', params: { threadId: 7 } }), []);
    assert.deepEqual(codexParentLinks({ method: 'thread/started', params: { thread: { id: 'x' } } }), []);
    assert.deepEqual(codexParentLinks({ method: 'turn/started', params: { threadId: 'x' } }), []);
    assert.deepEqual(codexParentLinks(null), []);
    assert.deepEqual(p.observe(signals['subAgentActivity item']('d', 'a')), [['d', 'a']]);
    assert.equal(p.rootOf('d'), 'b');
    p.observe({ method: 'thread/closed', params: { threadId: 'a' } });
    assert.equal(p.parentOf('a'), null);
    assert.equal(p.parentOf('d'), 'a', "a closed thread's children keep their link");
    p.clear();
    assert.equal(p.parentOf('d'), null);
  });
}
