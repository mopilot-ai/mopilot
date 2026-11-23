// Conversation-view UI unit cases for entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, setStore, impl, callsTo, window, friendlyError, flush, T, text, chat, view, setSageApprovals } from './fixture.ts';

export function registerEntry() {
  test('friendly errors pull out the upstream message and explain a bare rate limit', () => {
    assert.equal(friendlyError('{"error":{"message":"bad key"}}'), 'bad key');
    assert.equal(friendlyError('{"message":"top"}'), 'top');
    assert.equal(friendlyError('{"other":1}'), '{"other":1}');
    assert.equal(friendlyError('null'), 'null');
    assert.equal(friendlyError('upstream: {"message": "quota"} trailing'), 'quota');
    assert.equal(friendlyError('plain failure'), 'plain failure');
    assert.match(friendlyError('Task terminated abnormally: rate_limit'), /^Out of usage or rate limited\.$/);
  });

  test('loading, banners, older history and the scroll-to-bottom button', async () => {
    const v = await render(view());
    assert.equal(text(v.$('.thread-empty')), 'Loading…');
    await settle(() => setStore({ runtime: { [T]: { loading: true, turns: [] } } }));
    assert.ok(v.$('.thread-loading'));
    assert.ok(v.$('[data-stub="Composer"]'));
    await settle(() => chat([], { olderCursor: 'c1', error: 'Boom', retry: 'Retrying in 3s' }));
    assert.ok(v.$('.load-older'));
    assert.ok(!v.$('.thread-loading'));
    assert.equal(text(v.$('.error-banner')), 'Boom Retry');
    // Retry reads the chat again
    await settle(() => (v.$('.error-banner button') as HTMLButtonElement).click());
    // (with no refused start behind the banner, nothing is held: the second argument is empty)
    assert.deepEqual(callsTo('store:retryOpen'), [[T, undefined]]);
    // a failed read of a chat Codex holds, while a Codex copy keeps quitting: what to do about it, next to Retry
    const copy = { path: '/opt/homebrew/bin/codex', version: '0.163.0', via: 'brew', from: 'Homebrew' };
    impl['store:readFamilies'] = () => new Set(['codex']);
    await settle(
      () => (
        chat([], { olderCursor: 'c1', error: 'Boom', retry: 'Retrying in 3s', errorFromRead: true }),
        setStore({ codexQuit: { copy, pinned: false } })
      ),
    );
    assert.equal(text(v.$('.error-banner')), 'Boom RetryUse another Codex Copy crash output');
    // no copy named (Codex is up, or quit for another reason): nothing to add
    await settle(() => setStore({ codexQuit: null }));
    assert.equal(text(v.$('.error-banner')), 'Boom Retry');
    await settle(() => setStore({ codexQuit: { copy, pinned: false } }));
    // a chat another harness holds has no Codex copy to pick
    impl['store:readFamilies'] = () => new Set(['claude']);
    await settle(() => setStore({ codexQuit: { copy, pinned: true } }));
    assert.equal(text(v.$('.error-banner')), 'Boom Retry');
    await settle(() => (chat([], { olderCursor: 'c1', error: 'Boom', retry: 'Retrying in 3s' }), setStore({ codexQuit: null })));
    delete impl['store:readFamilies'];
    // with no turn running it is only the harness's words: no next step, no Stop or Retry (src/components/thread/TurnStall.tsx)
    assert.equal(text(v.$('.retry-banner')), 'Retrying in 3s');
    // the view follows the bottom of the column
    const observed = callsTo('scroll:observeBottom');
    assert.ok(observed.length >= 1);
    const [el, column, follows] = observed.at(-1)!;
    assert.ok(el === v.$('.thread-scroll'));
    assert.ok(column === v.$('.thread-column'));
    assert.equal(follows(), true);
    // scrolled to the bottom once loaded
    const scroller = v.$('.thread-scroll')!;
    const metrics = { scrollHeight: 1000, clientHeight: 300 };
    for (const [k, val] of Object.entries(metrics)) Object.defineProperty(scroller, k, { configurable: true, get: () => val });
    await flush();
    assert.equal(scroller.scrollTop, 1000);

    // scrolling up near the top loads older turns once, then keeps the reading position
    let release!: () => void;
    impl['store:loadOlderTurns'] = () => new Promise<void>((r) => (release = r));
    scroller.scrollTop = 100;
    await settle(() => scroller.dispatchEvent(new window.Event('scroll') as any));
    await settle(() => scroller.dispatchEvent(new window.Event('scroll') as any));
    assert.deepEqual(callsTo('store:loadOlderTurns'), [[T]]);
    assert.equal(follows(), false);
    const down = v.$('.scroll-bottom')!;
    // nothing running: a plain arrow, no working mark
    assert.equal(down.className.trim(), 'scroll-bottom');
    assert.ok(!down.querySelector('.working-mark'));
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1500 });
    await settle(() => release());
    await flush();
    assert.equal(scroller.scrollTop, 600);
    const scrolledTo: any[] = [];
    (scroller as any).scrollTo = (o: any) => scrolledTo.push(o);
    await settle(() => down.click());
    assert.deepEqual(scrolledTo, [{ top: 1500, behavior: 'smooth' }]);
    assert.equal(follows(), false, 'resize following yields while the smooth jump is in progress');
    await settle(() => scroller.dispatchEvent(new window.Event('scrollend') as any));
    assert.equal(follows(), true);
    // back at the bottom: no button, and no more loading without a cursor
    scroller.scrollTop = 1200;
    await settle(() => scroller.dispatchEvent(new window.Event('scroll') as any));
    assert.ok(!v.$('.scroll-bottom'));
    await settle(() => chat([], {}));
    scroller.scrollTop = 0;
    await settle(() => scroller.dispatchEvent(new window.Event('scroll') as any));
    assert.equal(callsTo('store:loadOlderTurns').length, 1);
    await v.unmount();
  });

  test('an empty side chat explains itself; read-only and composer-less views; approvals replace the composer', async () => {
    chat([], {}, undefined);
    const v = await render(view({ inPane: true }));
    assert.equal(text(v.$('.side-chat-empty-title')), 'Side chat');
    // MoMo's chat sits in a pane but is no side chat (#2279): none of the side chat's empty state
    await settle(() => setStore({ momoChats: { [T]: 'main' } }));
    assert.ok(!v.$('.side-chat-empty'));
    await settle(() => setStore({ momoChats: {} }));
    await v.rerender(view({ inPane: true, readOnly: true }));
    assert.ok(!v.$('.side-chat-empty'));
    assert.match(text(v.$('.read-only-note')), /Read only/);
    assert.ok(!v.$('[data-stub="ElsewhereNotice"]'));
    await v.rerender(view({ composer: false }));
    assert.ok(!v.$('[data-stub="Composer"]'));
    assert.ok(v.$('[data-stub="ElsewhereNotice"]'));
    await settle(() => setStore({ pending: [{ threadId: 'other' }, { threadId: T }] }));
    assert.ok(v.$('[data-stub="Approvals"]'));
    assert.equal(v.$('[data-stub="StatusStrip"]')!.dataset.approval, 'true');
    await settle(() => v.$('[data-stub="StatusStrip"]')!.click()); // no Stop-all question while approving
    assert.equal(v.$('[data-stub="StatusStrip"]')!.dataset.confirm, 'false');
    await settle(() => setStore({ pending: [] }));
    setSageApprovals([{ id: 1 }]);
    await v.rerender(view({ composer: true }));
    assert.ok(v.$('[data-stub="Approvals"]'));
    await v.unmount();
  });
}
