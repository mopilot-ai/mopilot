// Harness picker switching UI cases using shared DOM, harness mocks, and picker state.
import {
  test,
  assert,
  $,
  $$,
  click,
  flush,
  mount,
  mouse,
  EMPTY_SESSION,
  defined,
  events,
  store,
  fx,
  sessionOf,
  createElement,
  ModelPicker,
  models,
  openPicker,
  openHarnesses,
  row,
  item,
  last,
  sub,
} from './fixture.ts';

export function registerBusySelection() {
  for (const busy of [false, true])
    test(`picker uses Accounts and permits future model/harness selection (${busy ? 'running' : 'idle'})`, async () => {
      store.set({
        sessions: { chat: { ...EMPTY_SESSION, turn: busy ? 'running' : 'idle', goal: { objective: 'ship', status: 'active' } } },
        runtime: { chat: { activeTurnId: busy ? 'turn-1' : null } },
      });
      fx.models.codex = [models[0], { ...models[1], fast: false }];
      const m = await mount(createElement(ModelPicker, { threadId: 'chat' }));
      await openPicker();
      if (busy) assert.match(document.body.textContent!, /Applies from the next message/);
      await click($('[aria-label="Select harness and model"]'));
      await flush();
      assert.ok(
        $$('.hp-head').some((x) => x.textContent === 'Account'),
        'one account: a singular heading',
      );
      // an account that is fine still shows its usage line
      assert.equal($('.menu-item.has-desc .acct-status').textContent, 'status ok');
      assert.doesNotMatch(document.body.textContent!, /Account for new chats|Account for this chat/);
      await click($('.hp-models .menu-item:last-child'));
      assert.deepEqual(last('selection'), ['selection', 'codex', { model: 'new', effort: 'high', fast: false }, 'chat']);
      await click($('[aria-label="Select harness and model"]'));
      await flush();
      const claude = row('Claude Code');
      assert.equal(claude.getAttribute('aria-disabled'), null);
      await click(claude);
      await click($('.hp-models .menu-item:last-child'));
      await click($('#ss-confirm'));
      assert.equal(
        events.some((e) => e[0] === 'pause'),
        !busy,
        'running goals must not be interrupted',
      );
      assert.equal(sessionOf('chat').pendingSwitch.harness, 'claude');
      assert.equal(sessionOf('chat').pendingSwitch.model, 'new');
      assert.equal(store.get().runtime.chat.activeTurnId, busy ? 'turn-1' : null);
      await m.unmount();
    });
}

export function registerSwitching() {
  test("in a chat: another harness's account starts a switch on it and never changes what new chats use (R-2)", async () => {
    fx.pin = ['codex', 'claude'];
    fx.accounts.claude = {
      active: sub('c1', 'me@x'),
      accounts: [sub('c1', 'me@x'), sub('c2', 'work@x'), sub('c3', 'gone@x', { status: 'expired' })],
    };
    fx.models.claude = [
      { id: 'sonnet', label: 'Sonnet', efforts: ['low'], defaultEffort: 'low' },
      { id: 'opus', label: 'Opus', efforts: ['low'], defaultEffort: 'low', isDefault: true },
    ];
    // a busy chat can still pick a switch: it waits for the turn
    store.set({ pending: [{ threadId: 'c' }] });
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('AutomaticMoves to another account when one runs out'));
    await click($('#ss-confirm'));
    assert.equal(sessionOf('c').pendingSwitch.automaticAccount, true);
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Sonnet'));
    await click($('#ss-confirm'));
    assert.equal(sessionOf('c').pendingSwitch.automaticAccount, true, 'changing model retains Automatic');
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    assert.doesNotMatch(document.body.textContent!, /Wait for the current turn/);
    assert.equal(item('AutomaticMoves to another account when one runs out').getAttribute('aria-checked'), 'true');
    const work = item('work@xstatus ok');
    assert.equal(work.getAttribute('aria-disabled'), null);
    await click(work);
    // the model the harness would use (its default here), with that account for this chat
    assert.equal($('#ss-confirm').textContent, 'switch to claude on c2');
    assert.equal($('#ss-confirm').dataset.model, '', 'an account-only switch retains Automatic model selection');
    assert.equal(last('chooseAccount'), undefined, 'the default for new chats is never changed');
    assert.equal(last('chatAccount'), undefined);
    await click($('#ss-confirm'));
    assert.equal(sessionOf('c').pendingSwitch.account, 'c2');
    assert.equal(sessionOf('c').pendingSwitch.model, null);
    // A model pick after a pending account switch retains that account.
    fx.selFor = { claude: { model: 'sonnet' } };
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    assert.equal(item('work@xstatus ok').getAttribute('aria-checked'), 'true', 'the pending account remains visible');
    await click(item('work@xstatus ok'));
    assert.equal($('#ss-confirm').dataset.model, 'sonnet', "the harness's own selection when it lists it");
    await click($('#ss-cancel'));
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Sonnet'));
    assert.equal($('#ss-confirm').textContent, 'switch to claude on c2');
    await click($('#ss-confirm'));
    assert.equal(sessionOf('c').pendingSwitch.account, 'c2', 'a model pick preserves the pending account');
    // A pending model-only switch has no account choice and continues to inherit its prior target pin.
    store.set((s: any) => ({
      sessions: {
        ...s.sessions,
        c: { ...sessionOf('c'), pendingSwitch: { ...sessionOf('c').pendingSwitch, account: null, automaticAccount: false } },
      },
    }));
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Sonnet'));
    assert.equal($('#ss-confirm').textContent, 'switch to claude');
    await click($('#ss-cancel'));
    // signed out: picking it signs it in again, and opens nothing
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click($$('.menu-item').find((x) => x.textContent!.startsWith('gone@x'))!);
    assert.deepEqual(last('chooseAccount'), ['chooseAccount', 'c3']);
    assert.ok(!$('#ss-confirm'));
    await m.unmount();
  });

  test("in a chat with a switch to Claude pending: Codex's Automatic or account row keeps the chat on Codex and cancels the switch (#3914)", async () => {
    fx.pin = ['codex', 'claude'];
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test'), sub('a2', 'two@x.test')] };
    fx.models.claude = [{ id: 'opus', label: 'Opus', efforts: [], defaultEffort: null, isDefault: true }];
    const pendingToClaude = {
      harness: 'claude',
      model: 'opus',
      modelLabel: 'Opus',
      mode: 'summary',
      account: null,
    };
    for (const choose of [() => item('AutomaticMoves to another account when one runs out'), () => item('two@x.teststatus ok')]) {
      store.set((s: any) => ({ sessions: { ...s.sessions, c: { ...sessionOf('c'), pendingSwitch: pendingToClaude } } }));
      await flush();
      const again = await mount(createElement(ModelPicker, { threadId: 'c' }));
      await openHarnesses();
      await mouse(row('Codex'), 'mousemove');
      await click(choose());
      await flush();
      assert.equal(sessionOf('c').pendingSwitch, null, 'the switch away is cancelled');
      await again.unmount();
    }
    assert.deepEqual(last('chatAccount'), ['chatAccount', 'codex', 'c', 'a2']);
    // a pin the chat refuses says why and leaves the pending switch alone
    store.set((s: any) => ({ sessions: { ...s.sessions, c: { ...sessionOf('c'), pendingSwitch: pendingToClaude } } }));
    await flush();
    fx.failAccountCalls = true;
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    await mouse(row('Codex'), 'mousemove');
    await click(item('two@x.teststatus ok'));
    await flush();
    assert.deepEqual(last('toast'), ['toast', "Couldn't change the chat's account: chat is locked", 'error']);
    assert.equal(sessionOf('c').pendingSwitch.harness, 'claude');
    await m.unmount();
  });

  test('in a chat: another harness without per-chat accounts switches on its account in use; one still loading its models says so', async () => {
    fx.accounts.claude = { active: sub('c1', 'me@x'), accounts: [sub('c1', 'me@x'), sub('c2', 'work@x')] };
    fx.models.claude = [{ id: 'opus', label: 'Opus', efforts: [], defaultEffort: null }];
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('work@xstatus ok'));
    assert.equal($('#ss-confirm').textContent, 'switch to claude', 'never an account the chat could not be put on');
    assert.equal($('#ss-confirm').dataset.model, '', 'Automatic uses the native recommendation without pinning its current version');
    await click($('#ss-cancel'));
    fx.models.claude = [];
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('work@xstatus ok'));
    assert.deepEqual(last('toast'), ['toast', 'Claude Code is still loading its models']);
    assert.ok(!$('#ss-confirm'));
    await m.unmount();
  });

  test('in a chat: another harness asks first; cancel and outside close drop the sheet', async () => {
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('New'));
    assert.equal($('#ss-confirm').textContent, 'switch to claude');
    assert.equal(last('selection'), undefined);
    await click($('#ss-cancel'));
    assert.ok(!$('#ss-confirm'));
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('New'));
    await mouse(document.body, 'mousedown');
    assert.ok(!$('#ss-confirm'));
    await m.unmount();
  });

  test('in a chat: confirming a switch leaves queued messages in the composer and carries multi-agent as ultra', async () => {
    store.set({
      sessions: {
        c: {
          ...EMPTY_SESSION,
          goal: { objective: 'g', status: 'active' },
          queue: [
            { id: 'q1', text: 'first', attachments: ['a1'], opts: {} },
            { id: 'bad', text: 'second' },
            { id: 'sent', text: 'third' },
            // a goal comes back as the /goal it was typed as; one with only an attachment keeps it
            { id: 'q2', text: 'ship it', attachments: [], opts: { goal: 'ship it' } },
            { id: 'q3', text: '', attachments: ['a2'], opts: {} },
            // what another session sent (a wake-up carrying its notes) is not the user's text: it stays queued
            { id: 'wake', text: 'Your sessions reported', sideSession: { id: 'wake' } },
            // an input no human wrote (a MoMo routine result) is not the user's text either
            { id: 'routine', text: 'Daily summary', authored: { id: 'routine' } },
          ],
        },
      },
      drafts: { c: { text: 'draft', attachments: ['att'] } },
    });
    fx.pauseFails = true;
    fx.choices = { mode: 'summary', goal: 'g', multiAgent: true, queued: 'leave', effort: 'low' };
    fx.models.claude = [{ id: 'opus', label: 'Opus', efforts: ['low', 'ultra'], defaultEffort: 'low' }];
    let focused = 0;
    const onFocus = () => focused++;
    window.addEventListener('focus-composer', onFocus);
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Opus'));
    await click($('#ss-confirm'));
    await flush();
    assert.deepEqual(
      events.filter((e) => ['pause', 'unqueue', 'draft'].includes(e[0])),
      [
        ['pause', 'c'],
        ['unqueue', 'c', 'q1'],
        ['unqueue', 'c', 'bad'],
        ['unqueue', 'c', 'sent'],
        ['unqueue', 'c', 'q2'],
        ['unqueue', 'c', 'q3'],
        // only what left the queue comes back, to the composer on screen (giveBackToComposer), with its attachments:
        // a message still queued, or already sent, would go out twice
        ['draft', 'c', 'first\n\n/goal ship it', ['a1', 'a2']],
      ],
    );
    assert.deepEqual(last('toast'), ['toast', "Couldn't take a queued message back: no bad. It stays queued.", 'error']);
    assert.deepEqual(last('selection'), ['selection', 'claude', { model: 'opus', effort: 'ultra', fast: false }, null]);
    assert.deepEqual(last('session'), [
      'session',
      'c',
      {
        pendingSwitch: {
          harness: 'claude',
          model: 'opus',
          modelLabel: 'Opus',
          mode: 'summary',
          goal: 'g',
          multiAgent: true,
          account: null,
        },
      },
    ]);
    assert.equal(focused, 1);
    window.removeEventListener('focus-composer', onFocus);
    await m.unmount();
  });

  test('in a chat: queued messages go along when chosen; no draft, no queue and a model without ultra are fine', async () => {
    store.set({ sessions: { c: { ...EMPTY_SESSION, queue: [] } }, runtime: { c: { activeTurnId: null } } });
    fx.choices = { mode: 'auto', goal: null, multiAgent: true, queued: 'leave', effort: 'low' };
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Old'));
    await click($('#ss-confirm'));
    await flush();
    assert.equal(
      events.some((e) => ['pause', 'unqueue', 'draft'].includes(e[0])),
      false,
    );
    assert.deepEqual(defined(last('selection'))[2], { model: 'old', effort: 'low', fast: false });
    store.set({ sessions: { c: { ...EMPTY_SESSION, queue: [{ id: 'q1', text: 'only' }] } } });
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Old'));
    await click($('#ss-confirm'));
    await flush();
    assert.deepEqual(last('draft'), ['draft', 'c', 'only', []]);
    // several that stay queued are counted; with none brought back, the draft is left as it was
    const drafts = events.filter((e) => e[0] === 'draft').length;
    store.set({
      sessions: {
        c: {
          ...EMPTY_SESSION,
          queue: [
            { id: 'bad1', text: 'x' },
            { id: 'bad2', text: 'y' },
          ],
        },
      },
    });
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Old'));
    await click($('#ss-confirm'));
    await flush();
    assert.equal(events.filter((e) => e[0] === 'draft').length, drafts);
    assert.deepEqual(last('toast'), ['toast', "Couldn't take 2 queued messages back: no bad1. They stay queued.", 'error']);
    store.set({ sessions: { c: { ...EMPTY_SESSION, queue: [] } } });
    fx.choices = { ...fx.choices, queued: 'send', multiAgent: false };
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Old'));
    await click($('#ss-confirm'));
    await flush();
    assert.equal(events.filter((e) => e[0] === 'draft').length, 1);
    await m.unmount();
  });
}
