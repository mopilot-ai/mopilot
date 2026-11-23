// locks Sky matrix cases using shared fake harness and desktop fixtures.
import { test, assert, NativeDesktopHolds, guarded, settle, js, turn, NOTES, BROWSER, governed, fakeLock } from './fixture.ts';

export function registerLocks() {
  test('CM-V01: a native Codex turn running a desktop program holds the desktop lock until the turn ends; other chats are refused meanwhile', async () => {
    const g = governed();
    g.notify('turn/started', turn('nat-a', 't1', 'inProgress'));
    // a browser-only program does not take the desktop
    g.notify('item/started', js('nat-a', 't1', BROWSER, 'b1'));
    assert.equal(g.cu.controlling, null);
    g.notify('item/started', js('nat-a', 't1', NOTES, 'j1'));
    assert.equal(g.cu.controlling, 'chat-a', 'the chat holds the lock, never the thread id');
    await settle();
    assert.deepEqual(g.helperCalls, ['acquireControl MoPilot'], "the helper's lock too: other apps and profiles, its Esc and take-over");
    assert.deepEqual(g.state.get('chat-a').computer, { app: 'Notes', state: 'active' }, 'the working-in state names the app');
    assert.equal(g.runtime.indicator.chatId, 'chat-a', 'the overlay and Esc, with MoPilot desktop tools off too');
    // another chat's desktop_* is refused, as with MoPilot's own desktop tools (CM-C01)
    await assert.rejects(g.runtime.desktop.acquire('chat-b', 'Notes', 'com.apple.Notes'), /Another chat is controlling this Mac/);
    // between programs the turn keeps the lock; a later program on the bound app names it again
    g.notify('item/completed', js('nat-a', 't1', NOTES, 'j1', 'completed'));
    g.notify('item/started', js('nat-a', 't1', "await notes.typeText('hi')", 'j2'));
    assert.equal(g.cu.controlling, 'chat-a');
    // a native program on a thread that is not native never holds it
    g.runtime.nativeHolds.observe({ method: 'item/started', params: js('managed', 't9', NOTES) });
    g.notify('item/completed', js('nat-a', 't1', "await notes.typeText('hi')", 'j2', 'completed'));
    g.notify('turn/completed', turn('nat-a', 't1'));
    await settle();
    assert.equal(g.cu.controlling, null, 'let go when the turn ends');
    assert.deepEqual(g.helperCalls, ['acquireControl MoPilot', 'releaseControl'], "the helper's lock goes with it");
    assert.equal(g.runtime.indicator.chatId, null);
    assert.equal(g.state.get('chat-a').computer, null);
    await g.runtime.desktop.acquire('chat-b', 'Notes', 'com.apple.Notes');
    assert.equal(g.cu.controlling, 'chat-b');
  });

  test('CM-V01c: a native desktop program while another app or MoPilot profile holds the helper lock stops its turn and leaves no in-process lock', async () => {
    const g = governed({ helperBusy: true });
    g.notify('turn/started', turn('nat-a', 't1', 'inProgress'));
    g.notify('item/started', js('nat-a', 't1', NOTES, 'j1'));
    await settle();
    assert.equal(g.cu.controlling, null);
    assert.equal(g.runtime.indicator.chatId, null);
    assert.equal(g.state.get('chat-a').computer, null);
    assert.deepEqual(g.busy, [['nat-a', 't1', 'chat-a', null]], 'holder null: another app or profile');
    assert.ok(g.server.methods().includes('turn/interrupt'));
  });
}

export function registerLockLifecycle() {
  test('CM-V02: a native desktop program that starts while another chat holds the desktop stops its own turn, with the plugin Interrupt hook', async () => {
    const g = governed();
    await g.runtime.desktop.acquire('chat-b', 'Notes', 'com.apple.Notes');
    g.notify('turn/started', turn('nat-a', 't1', 'inProgress'));
    g.notify('item/started', js('nat-a', 't1', NOTES, 'j1'));
    // the next program of the same stopped turn is not reported again
    g.notify('item/started', js('nat-a', 't1', NOTES, 'j2'));
    await settle();
    assert.equal(g.cu.controlling, 'chat-b', 'the holder keeps it');
    assert.deepEqual(g.busy, [['nat-a', 't1', 'chat-a', 'chat-b']]);
    assert.ok(g.server.methods().includes('turn/interrupt'));
    assert.deepEqual(
      g.server.hooks().filter((h) => h[1] === 'turn_ended'),
      [['nat-a', 'turn_ended', 'Interrupt', 'nat-a']],
    );
    // once the stopped turn ends, the chat's next turn may take the desktop when it is free
    g.notify('turn/completed', turn('nat-a', 't1', 'interrupted'));
    await g.runtime.desktop.turnEnded('chat-b');
    g.notify('turn/started', turn('nat-a', 't2', 'inProgress'));
    g.notify('item/started', js('nat-a', 't2', NOTES, 'j3'));
    assert.equal(g.cu.controlling, 'chat-a');
  });

  test("CM-V03: a sub-agent's desktop program holds the desktop for its parent's chat, and its own turn end lets go", async () => {
    const g = governed();
    g.notify('thread/started', { thread: { id: 'nat-a-sub', parentThreadId: 'nat-a' } });
    g.notify('turn/started', turn('nat-a-sub', 's1', 'inProgress'));
    g.notify('item/started', js('nat-a-sub', 's1', NOTES));
    assert.equal(g.cu.controlling, 'chat-a', "the parent's chat, through the shared sub-agent map");
    g.notify('turn/completed', turn('nat-a-sub', 's1'));
    await settle();
    assert.equal(g.cu.controlling, null);
    // the parent's turn ends (the turn-end ledger lets go of the chat's desktop) while the sub-agent's program runs:
    // the sub-agent's turn takes it straight back
    g.notify('turn/started', turn('nat-a', 't1', 'inProgress'));
    g.notify('turn/started', turn('nat-a-sub', 's2', 'inProgress'));
    g.notify('item/started', js('nat-a-sub', 's2', NOTES));
    g.notify('turn/completed', turn('nat-a', 't1'));
    await g.runtime.turnEnded('chat-a');
    assert.equal(g.cu.controlling, 'chat-a', "never free under the sub-agent's program");
    // Esc stops the sub-agent's turn too, not only the chat's own thread
    g.runtime.indicator.onEscape('chat-a');
    await settle();
    assert.ok(
      g.server.sent.some((m) => m.method === 'turn/interrupt' && m.params.threadId === 'nat-a-sub' && m.params.turnId === 's2'),
      "the sub-agent's turn is interrupted",
    );
    // the stopped sub-agent turn never takes it back; its next turn does, and a closed thread drops it
    g.notify('item/started', js('nat-a-sub', 's2', NOTES));
    assert.equal(g.cu.controlling, null);
    g.notify('turn/started', turn('nat-a-sub', 's3', 'inProgress'));
    g.notify('item/started', js('nat-a-sub', 's3', NOTES));
    assert.equal(g.cu.controlling, 'chat-a');
    assert.equal(g.cu.controlling, 'chat-a');
    g.notify('thread/closed', { threadId: 'nat-a-sub' });
    assert.equal(g.cu.controlling, null);
    // the app-server exiting lets go of every native hold
    g.notify('item/started', js('nat-a', 't3', NOTES));
    g.runtime.nativeHolds.clear();
    assert.equal(g.cu.controlling, null);
    assert.equal(g.runtime.indicator.chatId, null);
  });

  test('CM-V04: Esc while Codex Computer Use holds the desktop lets go at once and stops the Codex turn with the Interrupt hook and a JS reset', async () => {
    const g = governed({ parity: true });
    g.notify('turn/started', turn('nat-a', 't1', 'inProgress'));
    g.notify('item/started', js('nat-a', 't1', NOTES, 'j1'));
    assert.equal(g.runtime.indicator.chatId, 'chat-a');
    // the overlay's global Esc
    g.runtime.indicator.onEscape('chat-a');
    await settle();
    assert.equal(g.cu.controlling, null, 'the lock goes with Esc, not with the turn end');
    assert.deepEqual(g.stopped, ['chat-a']);
    assert.ok(g.server.methods().includes('turn/interrupt'));
    assert.deepEqual(
      g.server.hooks().map((h) => [h[1], h[2]]),
      [
        ['turn_ended', 'Interrupt'],
        ['js_reset', null],
      ],
    );
    // the reset kernel no longer holds `notes`: the next turn's program on it acts on no app
    g.notify('turn/completed', turn('nat-a', 't1', 'interrupted'));
    g.notify('item/started', js('nat-a', 't2', 'await notes.click([1, 1])', 'j2'));
    assert.equal(g.cu.controlling, null);
  });

  test('CM-V04b: a stopped native turn never takes the desktop again; a take the chat stopped while the helper answered lets go at once; nothing takes it once computer use shuts down', async () => {
    const g = governed();
    g.notify('turn/started', turn('nat-a', 't1', 'inProgress'));
    g.notify('item/started', js('nat-a', 't1', NOTES, 'j1'));
    g.runtime.indicator.onEscape('chat-a');
    await settle();
    assert.equal(g.cu.controlling, null);
    // the stopped turn's next program (Sky has not stopped yet) is not given the desktop back
    g.notify('item/started', js('nat-a', 't1', NOTES, 'j2'));
    assert.equal(g.cu.controlling, null, 'a stopped turn never takes the desktop');
    g.notify('turn/completed', turn('nat-a', 't1', 'interrupted'));
    // the chat's turn ends while the helper is still answering the take: the guard is dead, and it lets go
    let answer = (_v?: unknown) => {};
    g.runtime.helper.acquireControl = () => new Promise((r) => (answer = r));
    g.notify('turn/started', turn('nat-a', 't2', 'inProgress'));
    g.notify('item/started', js('nat-a', 't2', NOTES, 'j3'));
    assert.equal(g.cu.controlling, 'chat-a');
    await settle(1);
    g.runtime.cu.interrupt('chat-a');
    answer({ ok: true });
    await settle();
    assert.equal(g.cu.controlling, null, 'a take whose chat was stopped meanwhile lets go');
    // computer use shutting down (quit, switched off): no native program takes the desktop
    g.runtime.cu.closed = true;
    g.notify('turn/started', turn('nat-b', 'u1', 'inProgress'));
    g.notify('item/started', js('nat-b', 'u1', NOTES, 'k1'));
    assert.equal(g.cu.controlling, null);
  });
}

export function registerLockEdges() {
  test('native desktop holds preserve opaque thread and turn IDs through stop, cleanup and busy errors', async () => {
    const lock = fakeLock();
    const stopped: any[] = [];
    const busy: any[] = [];
    const holds = new NativeDesktopHolds({
      cu: lock,
      isNativeThread: () => true,
      chatOf: () => 'chat',
      isSubagent: (thread: string) => thread === 'a\nb',
      onBusy: (...args: any[]) => busy.push(args),
      onStop: (...args: any[]) => stopped.push(args),
    });
    holds.take('a', 'b\nc', 'Notes');
    holds.take('a\nb', 'c', 'Notes');
    holds.interrupt('chat');
    assert.deepEqual(stopped, [
      ['a', 'b\nc'],
      ['a\nb', 'c'],
    ]);
    holds.ended('a', null);
    assert.equal(holds.holding('chat'), true);
    holds.chatTurnEnded('chat');
    assert.equal(holds.holding('chat'), true);
    holds.ended('a\nb', 'c');
    assert.equal(holds.holding('chat'), false);
    await settle();
    lock.helper.acquireControl = async () => {
      throw Object.assign(new Error('busy'), { reason: 'lock_busy' });
    };
    holds.take('a\nb', 'c\nd', 'Notes');
    await settle();
    assert.deepEqual(busy, [['a\nb', 'c\nd', 'chat', null]]);
    holds.take('a\nb', 'c\nd', 'Notes');
    assert.equal(busy.length, 1);
    holds.clear();
  });
  test('the lock helper edges: retaking, stopping without a listener, a helper that cannot run, a busy helper after the hold moved on', async () => {
    const lock = fakeLock();
    const busy: any[] = [];
    const holds = new NativeDesktopHolds({
      cu: lock,
      isNativeThread: () => true,
      chatOf: () => 'chat',
      onBusy: (...a: any[]) => busy.push(a),
    });
    // nothing to take back, and Esc on a chat with no native turn
    holds.retake('chat');
    holds.interrupt('chat');
    holds.observe({ method: 'item/started', params: js('th', 't1', NOTES) });
    // still held: nothing to take back
    holds.retake('chat');
    assert.equal(lock.controlling, 'chat');
    // a helper that can't run leaves the in-process lock
    lock.helper.acquireControl = async () => {
      throw new Error('helper not installed');
    };
    await lock.release('chat');
    holds.retake('chat');
    await settle();
    assert.equal(lock.controlling, 'chat');
    assert.equal(lock.app, 'your Mac');
    // the helper's lock found busy after the chat's hold already moved on: nothing of the new holder is touched
    lock.helper.acquireControl = async () => {
      throw Object.assign(new Error('busy'), { reason: 'lock_busy' });
    };
    await lock.release('chat');
    holds.retake('chat');
    lock.controlling = 'other';
    holds.ended('th', 't1');
    await settle();
    assert.equal(lock.controlling, 'other');
    assert.deepEqual(busy, [['th', 't1', 'chat', null]]);
    // the chat's own turn ends: its own threads' turns no longer hold (a sub-agent's would); Esc marks the rest stopped
    const own = new NativeDesktopHolds({ cu: fakeLock(), isNativeThread: () => true, chatOf: () => 'chat', onBusy: () => {} });
    own.observe({ method: 'item/started', params: js('th', 't2', NOTES) });
    assert.equal(own.holding('chat'), true);
    own.chatTurnEnded('chat');
    own.chatTurnEnded('nobody');
    assert.equal(own.holding('chat'), false);
    // the helper's lock found busy for a turn the user stopped meanwhile: it is not stopped twice
    const late = fakeLock();
    let busyNow = (_e?: unknown) => {};
    late.helper.acquireControl = () => new Promise((_r, rej) => (busyNow = rej));
    const told: any[] = [];
    const h4 = new NativeDesktopHolds({
      cu: late,
      isNativeThread: () => true,
      chatOf: () => 'chat',
      onBusy: (...x: any[]) => told.push(x),
    });
    h4.observe({ method: 'item/started', params: js('th', 'b1', NOTES) });
    await settle(1);
    h4.interrupt('chat');
    busyNow(Object.assign(new Error('busy'), { reason: 'lock_busy' }));
    await settle();
    assert.deepEqual(told, []);
    const subs = new NativeDesktopHolds({
      cu: fakeLock(),
      isNativeThread: () => true,
      chatOf: () => 'chat',
      onBusy: () => {},
      isSubagent: (id: string) => id === 'sub',
    });
    subs.observe({ method: 'item/started', params: js('sub', 's1', NOTES) });
    subs.observe({ method: 'item/started', params: js('own', 'o1', NOTES) });
    subs.chatTurnEnded('chat');
    assert.equal(subs.holding('chat'), true);
    subs.interrupt('chat');
    subs.cu.controlling = null;
    subs.retake('chat');
    assert.equal(subs.cu.controlling, null, 'a stopped turn is not retaken');
    // a dead take that a newer one replaced leaves the newer one alone; a helper failure after a stop lets go
    const lock2 = fakeLock();
    let fail = (_e?: unknown) => {};
    lock2.helper.acquireControl = () => new Promise((_r, rej) => (fail = rej));
    const h2 = new NativeDesktopHolds({ cu: lock2, isNativeThread: () => true, chatOf: () => 'chat', onBusy: () => {} });
    h2.observe({ method: 'item/started', params: js('th', 'a1', NOTES) });
    await settle(1);
    lock2.epochs++;
    fail(new Error('aborted'));
    await settle();
    assert.equal(lock2.controlling, null);
    // a take inside a call that may no longer act (the guard every lock taker checks) never sets the lock
    const h3 = new NativeDesktopHolds({ cu: fakeLock(), isNativeThread: () => true, chatOf: () => 'chat', onBusy: () => {} });
    const ac = new AbortController();
    ac.abort();
    guarded({ signal: ac.signal }, () => h3.takeGuarded('chat', { took: false, turns: new Set() }, 'th\nz', 'Notes'));
    assert.equal(h3.cu.controlling, null);
    // retake while closed does nothing
    h2.observe({ method: 'item/started', params: js('th', 'a2', NOTES) });
    lock2.controlling = null;
    lock2.closed = true;
    h2.retake('chat');
    assert.equal(lock2.controlling, null);
  });
}
