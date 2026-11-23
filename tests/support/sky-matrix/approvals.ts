// approvals Sky matrix cases using shared fake harness and desktop fixtures.
import {
  test,
  assert,
  path,
  controlStep,
  nativeAppAnswer,
  nativeAppApproval,
  SessionStore,
  ChatController,
  ChatsStore,
  tmp,
  settle,
  js,
  turn,
  NOTES,
  BROWSER,
  adapterRig,
} from './fixture.ts';

export function registerAppApprovals() {
  test('CM-V07: the Codex Computer Use app card offers what Sky offers, led by Allow this conversation, elevated risk included', () => {
    const card = (persist: unknown, riskLevel?: string) => ({
      mode: 'form',
      serverName: 'cua_repl',
      message: 'Allow Computer Use to use "Notes"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        connector_id: 'computer-use',
        tool_params: { app: 'com.apple.Notes' },
        persist,
        riskLevel,
      },
    });
    for (const risk of [undefined, 'high']) {
      const a = nativeAppApproval(card(['session', 'always'], risk))!;
      assert.deepEqual(
        a.scopes.map((s) => s.label),
        ['Always allow', 'Allow this conversation'],
        'no Allow once, which Sky never offers',
      );
      assert.equal(a.lead, 'session', `primary: Allow this conversation (risk ${risk})`);
    }
    assert.deepEqual(nativeAppAnswer(card(['session', 'always']), 'session'), {
      action: 'accept',
      content: {},
      _meta: { persist: 'session' },
    });
    assert.deepEqual(nativeAppAnswer(card(['session', 'always']), 'always'), {
      action: 'accept',
      content: {},
      _meta: { persist: 'always' },
    });
    assert.deepEqual(nativeAppAnswer(card(['session', 'always']), 'once'), { action: 'cancel', content: null, _meta: null });
  });
}

export function registerStaleApprovals() {
  test('CM-V09: a cua_repl approval held for the release never surfaces once it was resolved or its turn ended; the controller drops a late copy', async () => {
    const r = adapterRig({ hold: ['mcpServer/tool/call'] });
    r.notify('item/started', js('nat', 't1', NOTES));
    r.notify('turn/completed', turn('nat', 't1'));
    await settle();
    const ask = (id: string, turnId: string | null) =>
      r.server.ask(id, 'mcpServer/elicitation/request', { threadId: 'nat', turnId, serverName: 'cua_repl', mode: 'form', message: 'x' });
    ask('e1', 't2');
    r.notify('serverRequest/resolved', { threadId: 'nat', requestId: 'e1' });
    ask('e2', 't2');
    // a request the app-server ties to no turn belongs to the thread's running turn
    r.notify('turn/started', turn('nat', 't3', 'inProgress'));
    ask('e3', null);
    ask('e5', null);
    r.notify('turn/completed', turn('nat', 't2'));
    ask('e4', 't4');
    // its turn ended while it waited: answered now with a decline, never left unanswered
    assert.deepEqual(
      r.server.answers().map((a) => [a.id, a.result.action]),
      [['e2', 'decline']],
    );
    // and the step it declined reads as stopped with the turn, not as the user's "Not approved"
    r.notify(
      'item/completed',
      js('nat', 't2', NOTES, 'j2', 'failed', { error: { message: 'Computer Use was not approved to use Notes' } }),
    );
    const step = r.events.filter((e) => e.kind === 'notification' && e.method === 'item/completed').at(-1).params.item;
    assert.equal(step.mopilotDeclined, 'stopped');
    assert.equal(controlStep(step)?.problem?.kind, 'requestStopped');
    assert.equal(controlStep(step)?.problem?.title, 'Stopped with the turn');
    // the late completion of an earlier (stopped) turn does not take the running turn's requests with it
    r.notify('turn/completed', turn('nat', 't1', 'interrupted'));
    r.notify('serverRequest/resolved', { threadId: 'nat', requestId: 'e5' });
    assert.deepEqual(r.requests(), [], 'held while the release runs');
    r.server.release('mcpServer/tool/call');
    await settle();
    assert.deepEqual(r.requests(), ['e3', 'e4'], 'only the requests still live surface');
    // the controller: a request the app-server already resolved never becomes a card, even arriving late
    const state = new SessionStore();
    const c = new ChatController({
      state,
      chats: new ChatsStore(path.join(tmp(), 'threads')),
      codex: {},
      claudeTurns: {},
      acpTurns: {},
      switcher: {},
      claude: {},
      acp: {},
    });
    state.get('nat');
    c.onCodexMessage({ method: 'serverRequest/resolved', params: { requestId: 9 } });
    c.onCodexMessage({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'nat' } });
    assert.deepEqual(state.get('nat').approvals, []);
    // a new app-server numbers its requests again: the same id is a new request then
    c.onCodexExit();
    c.onCodexMessage({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'nat' } });
    assert.deepEqual(
      state.get('nat').approvals.map((a: any) => a.id),
      [9],
    );
    for (let i = 0; i < 502; i++) c.onCodexMessage({ method: 'serverRequest/resolved', params: { requestId: `r${i}` } });
    assert.equal(c.resolvedRequests.size, 500);
  });
}

export function registerBlockedApprovals() {
  test('host decline reasons keep opaque thread IDs and literal star turns separate', () => {
    const r = adapterRig();
    const decline = (threadId: string, turnId: string, id: string) => {
      r.adapter.heldRequests.set(id, { threadId, turnId });
      r.adapter.droppedWithTurn(threadId, turnId);
    };
    const denied = { error: { message: 'Computer Use was not approved to use Notes' } };
    const completed = (thread: string, turn: string) => {
      r.notify('item/completed', js(thread, turn, NOTES, 'denied', 'failed', denied));
      return r.events.filter((e) => e.kind === 'notification').at(-1).params.item.mopilotDeclined;
    };
    decline('a', 'b\nc', 'one');
    decline('a\nb', 'c', 'two');
    assert.equal(completed('a', 'b\nc'), 'stopped');
    assert.equal(completed('a\nb', 'c'), 'stopped');
    decline('a\nb', 'kept', 'three');
    r.adapter.droppedWithTurn('a', null);
    assert.equal(completed('a\nb', 'kept'), 'stopped');
    decline('nat', '*', 'star');
    assert.equal(completed('nat', 'other'), undefined);
    assert.equal(completed('nat', '*'), 'stopped');
    decline('other-thread', 'pending', 'other');
    assert.equal(completed('nat', null as any), undefined);
    assert.equal(completed('other-thread', 'pending'), 'stopped');
  });
  test('CM-V12: a step MoPilot declined because the release failed reads as blocked until Codex lets go, not as "Not approved"', async () => {
    const r = adapterRig({
      handlers: {
        'mcpServer/tool/call': () => {
          throw new Error('plugin gone');
        },
      },
    });
    r.notify('item/started', js('nat', 't1', NOTES));
    r.notify('turn/completed', turn('nat', 't1'));
    await settle();
    r.server.ask('e1', 'mcpServer/elicitation/request', {
      threadId: 'nat',
      turnId: 't2',
      serverName: 'cua_repl',
      mode: 'form',
      message: 'x',
    });
    await settle();
    assert.deepEqual(r.server.answers().at(-1), { id: 'e1', result: { action: 'decline', content: null, _meta: null } });
    assert.ok(r.toasts().some((t) => t.startsWith('Native browser and computer control is blocked')));
    const denied = { error: { message: 'Computer Use was not approved to use Notes' } };
    // a step of the turn that did not fail this way keeps its own reading
    r.notify('item/completed', js('nat', 't2', BROWSER, 'ok', 'completed'));
    r.notify('item/completed', js('nat', 't2', NOTES, 'j2', 'failed', denied));
    r.notify('item/completed', js('nat', 't2', NOTES, 'j3', 'failed', denied));
    const items = r.events.filter((e) => e.kind === 'notification' && e.method === 'item/completed').map((e) => e.params.item);
    assert.deepEqual(
      items.map((i) => i.mopilotDeclined ?? null),
      [null, 'cleanupBlocked', null],
      'the declined step only; the user declining a later one is theirs',
    );
    const problem = (it: any) => controlStep(it)?.problem;
    assert.equal(problem(items[1])?.kind, 'cleanupBlocked');
    assert.equal(problem(items[1])?.title, 'Blocked until Codex lets go');
    assert.equal(problem(items[2])?.kind, 'notApproved');
    // a request the app-server could not tie to a turn is matched in any turn of its thread, and a turn end forgets it
    r.server.ask('e2', 'mcpServer/elicitation/request', {
      threadId: 'nat',
      turnId: null,
      serverName: 'cua_repl',
      mode: 'form',
      message: 'x',
    });
    await settle();
    r.notify('item/completed', js('nat', 't3', NOTES, 'j4', 'failed', denied));
    r.server.ask('e3', 'mcpServer/elicitation/request', {
      threadId: 'nat',
      turnId: 't4',
      serverName: 'cua_repl',
      mode: 'form',
      message: 'x',
    });
    await settle();
    r.notify('turn/completed', turn('nat', 't4'));
    r.notify('item/completed', js('nat', 't4', NOTES, 'j5', 'failed', denied));
    const later = r.events.filter((e) => e.kind === 'notification' && e.method === 'item/completed').map((e) => e.params.item);
    assert.deepEqual(
      later.slice(3).map((i) => i.mopilotDeclined ?? null),
      ['cleanupBlocked', null],
    );
  });
}
