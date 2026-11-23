// Harness picker selection UI cases using shared DOM, harness mocks, and picker state.
import {
  test,
  assert,
  $,
  $$,
  click,
  fire,
  flush,
  mount,
  mouse,
  EMPTY_SESSION,
  defined,
  events,
  store,
  fx,
  createElement,
  ModelPicker,
  models,
  sub,
  openHarnesses,
  row,
  item,
  last,
} from './fixture.ts';

export function registerButton() {
  test('the button: harness, Fast, model label and effort; the API chip; the event that opens it', async () => {
    fx.sel = { ...fx.sel, fast: true };
    fx.status = { codex: { state: 'apikey' } };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    const btn = $('[aria-label="Select model"]');
    assert.ok(btn.querySelector('.icon-codex'));
    assert.ok(btn.querySelector('.fast-icon'));
    assert.equal(btn.querySelector('.model-name')!.textContent, 'Old');
    assert.equal(btn.querySelector('.model-effort')!.textContent, 'High');
    assert.equal($('.api-chip').textContent, 'API');
    btn.parentElement!.setAttribute('data-composer-chat', '');
    btn.parentElement!.setAttribute('data-composer-main', 'true');
    await fire(window, new (window as any).Event('open-model-picker'));
    assert.ok($('.effort-pop'));
    // the label falls back to the model id, then "Model"; no effort no badge
    fx.sel = { ...fx.sel, model: { id: 'other', label: 'Other' }, effort: null, fast: false };
    fx.status = {};
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal(btn.querySelector('.model-name')!.textContent, 'old');
    assert.ok(!btn.querySelector('.model-effort'));
    assert.ok(!$('.api-chip'));
    fx.sel = { ...fx.sel, model: null, modelId: null };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal(btn.querySelector('.model-name')!.textContent, 'Model');
    await m.unmount();
  });

  test('the button never names an account; the picker does, last, when there is a choice', async () => {
    const accountRow = () => $('.effort-pop .hp-account') as HTMLButtonElement | null;
    const btn = () => $('[aria-label="Select model"]');
    // one account, no pin: nothing to choose, so no row either
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await click(btn());
    assert.equal(accountRow(), null);
    assert.ok(!$('.effort-pop .menu-sep'));
    // several accounts: a new chat names the one in use, after the effort and speed controls
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test'), sub('a2', 'two@x.test')] };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal($('.effort-pop')!.lastElementChild, accountRow());
    assert.equal(accountRow()!.getAttribute('aria-haspopup'), 'menu');
    assert.equal(accountRow()!.getAttribute('aria-label'), 'Account: one@x.test');
    assert.equal(accountRow()!.querySelector('.hp-account-name')!.textContent, 'one@x.test');
    assert.ok(accountRow()!.querySelector('.profile-avatar'));
    assert.ok(!btn().querySelector('.profile-avatar'), 'the button shows no avatar');
    assert.doesNotMatch(btn().textContent!, /one@x\.test|Account/);
    // › opens the harness list, where the current harness's account list flies out
    await click(accountRow()!);
    assert.ok(!$('.effort-pop'));
    assert.ok($('.hp-harnesses'));
    await click(item('two@x.teststatus ok'));
    assert.deepEqual(last('chooseAccount'), ['chooseAccount', 'a2']);
    await m.unmount();
    // a chat pinned to its only account, on another harness: still the row, never the button
    fx.accounts.claude = { active: sub('c1', 'me@x'), accounts: [sub('c1', 'me@x')] };
    fx.own['claude:t'] = { id: 'c1', pinned: true, serving: 'c1' };
    store.set({ harnessOf: { t: 'claude' } });
    const c = await mount(createElement(ModelPicker, { threadId: 't' }));
    await click(btn());
    assert.equal(accountRow()!.querySelector('.hp-account-note')!.textContent, 'Pinned to this chat');
    assert.ok(!btn().querySelector('.profile-avatar'));
    await c.unmount();
  });
}

export function registerSelection() {
  test('accounts for new chats: picking one chooses it; unhealthy ones say why', async () => {
    fx.accounts.codex = {
      active: sub('a1', 'one@x.test'),
      accounts: [sub('a1', 'one@x.test'), sub('a2', 'two@x.test', { status: 'limited' })],
    };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    assert.match(item('one@x.teststatus ok').className, /menu-item has-desc/, 'a healthy account shows its usage too');
    assert.ok(item('one@x.teststatus ok').querySelector('svg'));
    const two = $$('.menu-item').find((x) => x.textContent!.startsWith('two@x.test'))!;
    assert.equal(two.querySelector('.acct-status')!.textContent, 'status limited');
    assert.equal(two.getAttribute('aria-disabled'), null);
    await click(two);
    assert.deepEqual(last('chooseAccount'), ['chooseAccount', 'a2']);
    // a healthy one becomes the account new chats use
    await click(item('one@x.teststatus ok'));
    assert.deepEqual(last('chooseAccount'), ['chooseAccount', 'a1']);
    // no accounts: no Accounts section
    fx.accounts.claude = undefined;
    await mouse(row('Claude Code'), 'mousemove');
    assert.doesNotMatch($$('.popover-layer .menu').at(-1)!.textContent!, /Accounts/);
    await m.unmount();
  });

  test("an account the caller says cannot be picked (MoMo's brain) shows that as its line and is disabled", async () => {
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test'), sub('a2', 'two@x.test')] };
    const { AccountList } = await import('../../../src/components/harnessPicker/rows.tsx');
    const m = await mount(
      createElement(AccountList, {
        h: 'codex',
        chatId: null,
        busy: false,
        unavailable: (a: { id: string }) => (a.id === 'a2' ? 'Needs an API key' : null),
      }),
    );
    const two = $$('.menu-item').find((x) => x.textContent!.startsWith('two@x.test'))!;
    assert.equal(two.querySelector('.acct-status')!.textContent, 'Needs an API key');
    assert.equal(two.querySelector('.acct-status')!.className.trim(), 'menu-desc acct-status');
    assert.equal(two.getAttribute('aria-disabled'), 'true');
    assert.equal(
      $$('.menu-item')
        .find((x) => x.textContent!.startsWith('one@x.test'))!
        .hasAttribute('disabled'),
      false,
    );
    await m.unmount();
  });

  test('a new chat checks one row: Automatic while it is on, else the account in use', async () => {
    fx.pin = ['codex'];
    const api = { id: 'k', email: 'key', kind: 'apiKey', status: 'ok', usage: { windows: [], source: 'none', at: null } };
    const three = sub('a3', 'three@x.test', { status: 'expired' });
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test'), sub('a2', 'two@x.test'), three, api] };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    const checked = () => {
      const rows = [...$$('.popover-layer .menu').at(-1)!.querySelectorAll('.menu-item')].filter((r) => !r.closest('.hp-models'));
      const on = rows.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.querySelector('.menu-title')!.textContent);
      const marked = rows.filter((r) => r.querySelector('.menu-check svg')).map((r) => r.querySelector('.menu-title')!.textContent);
      assert.deepEqual(marked, on, 'the check marks and aria-checked agree');
      return on;
    };
    const automatic = () => item('AutomaticAutomatic switching for all chats');
    const autoEvents = () => events.filter((e) => e[0] === 'autoSwitch');
    assert.equal(automatic().getAttribute('role'), 'menuitemradio');
    assert.deepEqual(checked(), ['Automatic']);
    // already chosen: picking it again changes nothing
    await click(automatic());
    assert.deepEqual(autoEvents(), []);
    assert.deepEqual(checked(), ['Automatic']);
    // a signed-out account signs in again and leaves the choice as it was
    await click($$('.menu-item').find((x) => x.textContent!.startsWith('three@x.test'))!);
    assert.deepEqual(last('chooseAccount'), ['chooseAccount', 'a3']);
    assert.deepEqual(autoEvents(), []);
    // an account replaces Automatic, and Automatic is off before the account moves
    await click(item('two@x.teststatus ok'));
    await flush();
    assert.deepEqual(events.slice(-2), [
      ['autoSwitch', 'codex', false],
      ['chooseAccount', 'a2'],
    ]);
    assert.deepEqual(checked(), ['one@x.test'], 'the fixture keeps a1 in use');
    // with Automatic off, a further pick leaves the setting alone
    await click(item('keystatus ok'));
    await flush();
    assert.deepEqual(last('chooseAccount'), ['chooseAccount', 'k']);
    assert.equal(autoEvents().length, 1);
    // Automatic replaces the account
    await click(automatic());
    assert.deepEqual(last('autoSwitch'), ['autoSwitch', 'codex', true]);
    assert.deepEqual(checked(), ['Automatic']);
    // the account in use can be chosen too
    await click(item('one@x.teststatus ok'));
    await flush();
    assert.deepEqual(last('autoSwitch'), ['autoSwitch', 'codex', false]);
    assert.deepEqual(checked(), ['one@x.test']);
    store.set({ accounts: { ...store.get().accounts, autoSwitch: true } });
    // Automatic can't move between accounts here: the account in use stays checked, and picking it changes nothing
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test'), api] };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal(item('AutomaticNo other account of this kind').getAttribute('aria-disabled'), 'true');
    assert.deepEqual(checked(), ['one@x.test']);
    const before = autoEvents().length;
    await click(item('one@x.teststatus ok'));
    await flush();
    assert.equal(autoEvents().length, before);
    // leaving for another account still lands on that account, not on Automatic
    await click(item('keystatus ok'));
    await flush();
    assert.deepEqual(last('autoSwitch'), ['autoSwitch', 'codex', false]);
    await m.unmount();
  });

  test('Claude Code checks one row too, through its own setting', async () => {
    fx.pin = ['codex', 'claude'];
    fx.accounts.claude = { active: sub('c1', 'c1@x.test'), accounts: [sub('c1', 'c1@x.test'), sub('c2', 'c2@x.test')] };
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test'), sub('a2', 'two@x.test')] };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    const pane = () => $$('.popover-layer .menu').at(-1)!;
    const on = () => [...pane().querySelectorAll('[aria-checked="true"] .menu-title')].map((t) => t.textContent);
    assert.deepEqual(on(), ['Automatic']);
    await click(item('c2@x.teststatus ok'));
    await flush();
    assert.deepEqual(events.slice(-2), [
      ['autoSwitch', 'claude', false],
      ['chooseAccount', 'c2'],
    ]);
    assert.deepEqual(on(), ['c1@x.test']);
    assert.notEqual(store.get().accounts?.autoSwitch, false, "Codex's setting stays as it was");
    await m.unmount();
  });

  test('a list without an Automatic choice never changes the setting', async () => {
    // no way to pin on this connection
    fx.pin = [];
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test'), sub('a2', 'two@x.test')] };
    let m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    assert.equal(item('AutomaticAccount switching is unavailable for this connection').getAttribute('aria-disabled'), 'true');
    await click(item('two@x.teststatus ok'));
    await flush();
    assert.deepEqual(last('chooseAccount'), ['chooseAccount', 'a2']);
    assert.equal(last('autoSwitch'), undefined);
    await m.unmount();
    // a single account: no Automatic row at all
    fx.pin = ['codex'];
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test')] };
    m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    assert.equal(
      $$('.menu-item').find((x) => !x.closest('.hp-models') && x.textContent!.startsWith('Automatic')),
      undefined,
    );
    assert.equal(item('one@x.teststatus ok').getAttribute('aria-checked'), 'true');
    await click(item('one@x.teststatus ok'));
    await flush();
    assert.equal(last('autoSwitch'), undefined);
    await m.unmount();
  });

  test('a refused Automatic change is said, in a new chat and in a chat', async () => {
    fx.pin = ['codex'];
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test'), sub('a2', 'two@x.test')] };
    fx.failAccountCalls = true;
    let m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    // the account doesn't move while Automatic stays on
    await click(item('two@x.teststatus ok'));
    await flush();
    assert.deepEqual(last('toast'), ['toast', "Couldn't change automatic switching: settings are locked", 'error']);
    assert.equal(last('chooseAccount'), undefined);
    assert.equal(item('AutomaticAutomatic switching for all chats').getAttribute('aria-checked'), 'true');
    // nor can it be turned back on
    events.length = 0;
    store.set({ accounts: { ...store.get().accounts, autoSwitch: false } });
    await flush();
    await click(item('AutomaticAutomatic switching for all chats'));
    await flush();
    assert.deepEqual(last('toast'), ['toast', "Couldn't change automatic switching: settings are locked", 'error']);
    assert.equal(item('AutomaticAutomatic switching for all chats').getAttribute('aria-checked'), 'false');
    store.set({ accounts: { ...store.get().accounts, autoSwitch: true } });
    await m.unmount();
    m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    await click(item('AutomaticMoves to another account when one runs out'));
    await flush();
    assert.deepEqual(last('toast'), ['toast', "Couldn't change the chat's account: chat is locked", 'error']);
    await m.unmount();
  });

  test('accounts in a chat that can pin: Automatic or a pinned account of the same billing type', async () => {
    fx.pin = ['codex'];
    const api = { id: 'k', email: 'key', kind: 'apikey', status: 'ok', usage: { windows: [], source: 'none', at: null } };
    fx.accounts.codex = {
      active: sub('a1', 'one@x.test'),
      accounts: [sub('a1', 'one@x.test'), sub('a2', 'two@x.test'), sub('a3', 'three@x.test', { status: 'expired' }), api],
    };
    fx.own['codex:c'] = { id: 'a2', pinned: false, serving: 'a2' };
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    const pane = () => $$('.popover-layer .menu').at(-1)!;
    assert.doesNotMatch(pane().textContent!, /key/, 'other billing types are left out');
    // unpinned: Automatic is checked and names no account (the composer's status shows where the chat runs)
    const auto = item('AutomaticMoves to another account when one runs out');
    assert.match(auto.className, /has-desc/);
    assert.ok(auto.querySelector('svg'));
    assert.doesNotMatch(auto.textContent!, /two@x\.test/);
    await click(auto);
    assert.deepEqual(last('chatAccount'), ['chatAccount', 'codex', 'c', null]);
    store.set({ accounts: { ...store.get().accounts, autoSwitch: false } });
    await flush();
    const stopped = item('AutomaticUses the account in use; automatic switching is off in Settings');
    assert.notEqual(stopped.getAttribute('aria-disabled'), 'true');
    await click(stopped);
    assert.deepEqual(last('chatAccount'), ['chatAccount', 'codex', 'c', null]);
    store.set({ accounts: { ...store.get().accounts, autoSwitch: true } });
    await flush();
    await click(item('one@x.teststatus ok'));
    assert.deepEqual(last('chatAccount'), ['chatAccount', 'codex', 'c', 'a1']);
    const three = $$('.menu-item').find((x) => x.textContent!.startsWith('three@x.test'))!;
    // signed out: dimmed, yet picking it signs it in again, so it stays a row the keyboard reaches
    assert.match(three.className, /dim/);
    assert.equal(three.getAttribute('aria-disabled'), null);
    await click(three);
    assert.deepEqual(last('chooseAccount'), ['chooseAccount', 'a3']);
    // pinned: that account is checked and Automatic is not
    fx.own['codex:c'] = { id: 'a1', pinned: true, serving: 'a1' };
    await m.render(createElement(ModelPicker, { threadId: 'c' }));
    assert.equal(item('AutomaticMoves to another account when one runs out').querySelector('.menu-check')!.innerHTML, '');
    assert.ok(item('one@x.teststatus ok').querySelector('svg'));
    // pinned to an account that can't serve it right now: the Automatic row says both, the pin stays checked
    fx.own['codex:c'] = { id: 'a1', pinned: true, serving: 'a2' };
    await m.render(createElement(ModelPicker, { threadId: 'c' }));
    assert.ok(item('AutomaticPinned to one@x.test · now on two@x.test'));
    assert.ok(item('one@x.teststatus ok').querySelector('svg'));
    await m.unmount();
  });

  test('one account in a chat that can pin: just that account, checked, with nothing to choose or wait for', async () => {
    fx.pin = ['codex'];
    store.set({ pending: [{ threadId: 'c' }] });
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test')] };
    fx.own['codex:c'] = { id: 'a1', pinned: false, serving: 'a1' };
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    const pane = () => $$('.popover-layer .menu').at(-1)!;
    assert.deepEqual(
      [...pane().querySelectorAll('.hp-head')].map((x) => x.textContent),
      ['Account', 'Models'],
    );
    assert.doesNotMatch(pane().textContent!, /Moves to another account|Wait for the current turn/);
    const one = item('one@x.teststatus ok');
    assert.equal(one.getAttribute('aria-checked'), 'true');
    assert.equal(one.getAttribute('aria-disabled'), null, 'a running turn does not grey it out');
    await click(one);
    assert.equal(last('chatAccount'), undefined, 'picking the only account pins nothing');
    // signed out: picking it still signs it in again
    fx.accounts.codex = { active: null, accounts: [sub('a1', 'one@x.test', { status: 'expired' })] };
    await m.render(createElement(ModelPicker, { threadId: 'c' }));
    await click($$('.menu-item').find((x) => x.textContent!.startsWith('one@x.test'))!);
    assert.deepEqual(last('chooseAccount'), ['chooseAccount', 'a1']);
    // pinned to its only account: Automatic stays so the pin can be undone, the pin stays checked
    store.set({ pending: [] });
    fx.accounts.codex = { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test')] };
    fx.own['codex:c'] = { id: 'a1', pinned: true, serving: 'a1' };
    await m.render(createElement(ModelPicker, { threadId: 'c' }));
    assert.equal(item('one@x.teststatus ok').getAttribute('aria-checked'), 'true');
    await click(item('AutomaticMoves to another account when one runs out'));
    assert.deepEqual(last('chatAccount'), ['chatAccount', 'codex', 'c', null]);
    // pinned to an account no longer listed: Automatic stays too
    fx.own['codex:c'] = { id: 'gone', pinned: true, serving: 'a1' };
    await m.render(createElement(ModelPicker, { threadId: 'c' }));
    assert.ok(item('AutomaticPinned to gone · now on one@x.test'));
    await click(item('AutomaticPinned to gone · now on one@x.test'));
    assert.deepEqual(last('chatAccount'), ['chatAccount', 'codex', 'c', null]);
    await m.unmount();
  });

  test('accounts in a busy chat wait for the turn; an API-key chat lists API keys', async () => {
    fx.pin = ['codex'];
    store.set({ pending: [{ threadId: 'c' }] });
    const api = { id: 'k', email: 'key', kind: 'apikey', status: 'ok', usage: { windows: [], source: 'none', at: null } };
    const api2 = { ...api, id: 'k2', email: 'key2' };
    fx.accounts.codex = { active: api, accounts: [sub('a1', 'one@x.test'), api, api2] };
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    assert.match(document.body.textContent!, /Wait for the current turn to finish to change it/);
    assert.deepEqual(
      $$('.acct-email').map((x) => x.textContent),
      ['key', 'key2'],
    );
    await click(item('AutomaticMoves to another account when one runs out'));
    await click(item('keystatus ok'));
    assert.equal(last('chatAccount'), undefined);
    // no account at all: subscriptions are assumed
    fx.accounts.codex = { active: null, accounts: [sub('a1', 'one@x.test')] };
    await m.render(createElement(ModelPicker, { threadId: 'c' }));
    assert.deepEqual(
      $$('.acct-email').map((x) => x.textContent),
      ['one@x.test'],
    );
    await m.unmount();
  });

  test('picking a model for a new chat: keeps a usable effort and Fast where offered, and picks that harness for this draft only', async () => {
    fx.sel = { ...fx.sel, effort: 'low', fast: true };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    await click(item('New'));
    assert.deepEqual(last('selection'), ['selection', 'codex', { model: 'new', effort: 'high' }, null]);
    assert.equal(last('pick'), undefined);
    assert.ok($('.effort-pop') && !$('.hp-models'), 'picking returns to the effort pane');
    await openHarnesses();
    await click(item('Old'));
    assert.deepEqual(defined(last('selection'))[2], { model: 'old', effort: 'low', fast: false });
    // a tier is kept only where the new model has it
    fx.sel = { ...fx.sel, tier: 'flex' };
    fx.models.codex = [{ ...models[0], tiers: [{ id: 'flex' }] }, models[1]];
    await m.render(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    await click(item('Old'));
    assert.deepEqual(defined(last('selection'))[2], { model: 'old', effort: 'low' });
    await openHarnesses();
    await click(item('New'));
    assert.deepEqual(defined(last('selection'))[2], { model: 'new', effort: 'high', fast: false });
    // another harness: its default effort, and this draft starts on it (the saved default stays)
    fx.sel = { ...fx.sel, tier: null, effort: null };
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Old'));
    assert.deepEqual(last('selection'), ['selection', 'claude', { model: 'old', effort: 'high', fast: false }, null]);
    assert.deepEqual(last('pick'), ['pick', 'claude']);
    assert.equal(last('prefs'), undefined);
    // a basic default that can't run now (new chats start on Codex meanwhile): a Codex model leaves it alone (#1293)
    store.set({ prefs: { ...store.get().prefs, defaultHarness: 'acp:kimi' } });
    await openHarnesses();
    await click(item('Old'));
    assert.equal(store.get().prefs.defaultHarness, 'acp:kimi');
    // another harness than the one new chats start on is this draft's pick; the saved default stays
    await openHarnesses();
    await mouse(row('Claude Code'), 'mousemove');
    await click(item('Old'));
    assert.equal(store.get().newChatHarnessPick, 'claude');
    assert.equal(store.get().prefs.defaultHarness, 'acp:kimi');
    await m.unmount();
  });

  test('in a chat: a model change clears a pending switch without a scope notification', async () => {
    store.set({
      prefs: { modelScopeHintSeen: false },
      sessions: { c: { ...EMPTY_SESSION, pendingSwitch: { harness: 'codex', model: 'old' } } },
      harnessOf: { c: 'codex' },
    });
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    await click(item('New'));
    assert.deepEqual(
      events.filter((e) => e[0] === 'session'),
      [['session', 'c', { pendingSwitch: null }]],
    );
    assert.equal(last('toast'), undefined);
    assert.ok($('.effort-pop'));
    await click($('[aria-label="Reset to default"]'));
    await fire($('.effort-pop'), new (window as any).KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal(events.filter((e) => e[0] === 'toast').length, 0);
    await m.unmount();
  });
}
