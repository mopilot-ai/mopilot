// Harness picker badges UI cases using shared DOM, harness mocks, and picker state.
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
  events,
  store,
  createElement,
  HarnessIcon,
  BasicHarnessIcon,
  BasicBadge,
  UsageMeters,
  signInHarness,
  SwitchChip,
  ThreadHarnessBadge,
  last,
  fx,
} from './fixture.ts';

export function registerPublicIdentity() {
  test('the public picker entrypoint preserves shared badge and switch component identities', async () => {
    const badges = await import('../../../src/components/harnessPicker/badges.tsx');
    const indicators = await import('../../../src/components/harnessPicker/SwitchChip.tsx');
    assert.equal(HarnessIcon, badges.HarnessIcon);
    assert.equal(BasicHarnessIcon, badges.BasicHarnessIcon);
    assert.equal(BasicBadge, badges.BasicBadge);
    assert.equal(UsageMeters, badges.UsageMeters);
    assert.equal(signInHarness, badges.signInHarness);
    assert.equal(ThreadHarnessBadge, badges.ThreadHarnessBadge);
    assert.equal(SwitchChip, indicators.SwitchChip);
  });
}

export function registerBadges() {
  test('glyphs: harness icons, a basic harness logo (else its initial), and the chat badge for either', async () => {
    const m = await mount(
      createElement(
        'div',
        null,
        createElement(HarnessIcon, { h: 'claude' }),
        createElement(BasicHarnessIcon, { id: 'kimi' }),
        createElement(BasicHarnessIcon, { id: 'newagent' }),
      ),
    );
    assert.equal($('.icon-claude').dataset.size, '16');
    const logo = $('.harness-icon.logo');
    assert.deepEqual([logo.getAttribute('aria-label'), logo.getAttribute('width')], ['Kimi', '16']);
    const basic = $('.harness-icon.basic');
    assert.deepEqual(
      [basic.textContent, basic.getAttribute('aria-label'), basic.style.width, basic.style.fontSize],
      ['N', 'Newagent', '16px', '10px'],
    );
    store.set({ basicOf: { b: 'qwen' }, harnessOf: { c: 'claude' } });
    await m.render(
      createElement(
        'div',
        null,
        createElement(ThreadHarnessBadge, { threadId: 'b' }),
        createElement(ThreadHarnessBadge, { threadId: 'c' }),
      ),
    );
    const [b, c] = $$('.thread-harness');
    assert.deepEqual([b.title, b.querySelector('svg')!.getAttribute('aria-label'), c.title], ['Qwen', 'Qwen', 'Claude Code']);
    assert.equal(c.querySelector('i')!.dataset.size, '12');
    assert.equal(signInHarness('codex', 'chat'), 'started');
    assert.deepEqual(events.at(-1), ['signIn:codex', 'chat']);
    await m.unmount();
  });

  test('the Basic badge explains itself and links to the harness settings', async () => {
    const m = await mount(createElement(BasicBadge, { id: 'kimi' }));
    await mouse($('.tooltip-anchor'), 'mouseover');
    await flush(210, 1);
    assert.match($('.basic-hover').textContent!, /^Kimi is basic\. See what's different$/);
    // an in-app action: a button styled as a link, so the keyboard reaches it and it goes nowhere a URL names
    const link = $('.basic-hover button.text-link');
    await fire(link, new (window as any).MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(last('navigate'), ['navigate', { name: 'settings', section: 'other-harnesses' }]);
    await m.unmount();
  });

  test('usage meters show what is left of each window, with reset times', async () => {
    const m = await mount(createElement(UsageMeters, { usage: null }));
    assert.equal(m.host.innerHTML, '');
    await m.render(createElement(UsageMeters, { usage: { windows: [] } as any }));
    assert.equal(m.host.innerHTML, '');
    await m.render(
      createElement(UsageMeters, {
        compact: true,
        usage: {
          windows: [
            { label: '5h', usedPercent: 90, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
            { label: 'wk', usedPercent: 120, resetsText: 'Monday' } as any,
            { label: 'xx', usedPercent: 1 } as any,
          ],
        },
      } as any),
    );
    assert.equal($('.hp-meters').className, 'hp-meters compact');
    const meters = $$('.hp-meter');
    assert.equal(meters.length, 2);
    assert.match(meters[0].title, /^Resets /);
    assert.deepEqual([meters[0].textContent, meters[0].querySelector('i')!.className], ['5h10%', 'low']);
    assert.deepEqual([meters[1].title, meters[1].textContent], ['Resets Monday', 'wk0%']);
    // a window past its reset started over after the reading: what is left now is not known, never full (#1582)
    await m.render(
      createElement(UsageMeters, {
        usage: { windows: [{ label: '5h', usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) - 60 }] },
      } as any),
    );
    assert.deepEqual([$('.hp-meter').textContent, $('.hp-meter').getAttribute('title')], ['5h—', 'Reset since last read']);
    assert.equal($('.hp-meter i'), null, 'no bar is drawn');
    await m.render(createElement(UsageMeters, { usage: { windows: [{ label: '5h', usedPercent: 50 } as any] } } as any));
    assert.deepEqual(
      [$('.hp-meters').className, $('.hp-meter').getAttribute('title'), $('.hp-meter i').className],
      ['hp-meters ', null, ''],
    );
    await m.unmount();
  });

  test('the switch chip: a pending switch can be cancelled; a carried summary can be dropped', async () => {
    const m = await mount(createElement(SwitchChip, { threadId: 't' }));
    assert.equal(m.host.innerHTML, '');
    store.set({ handoffCarry: { t: { fromTitle: 'Old chat' }, other: { fromTitle: 'X' } } });
    await flush();
    assert.equal($('.switch-chip span').textContent, 'Your first message carries a summary of Old chat');
    await click($('[aria-label="Don\'t carry the summary"]'));
    assert.deepEqual(Object.keys(store.get().handoffCarry), ['other']);
    // an issue a new chat started from is named as one, and can be dropped the same way
    store.set({ handoffCarry: { ...store.get().handoffCarry, t: { fromTitle: '#34 Crash on save', issue: true } } });
    await flush();
    assert.equal($('.switch-chip span').textContent, 'Your first message carries issue #34 Crash on save');
    await click($('[aria-label="Don\'t carry the issue"]'));
    assert.deepEqual(Object.keys(store.get().handoffCarry), ['other']);
    store.set({ sessions: { t: { ...EMPTY_SESSION, pendingSwitch: { harness: 'claude', modelLabel: 'Opus' } } } });
    await flush();
    assert.equal($('.switch-chip span').textContent, 'Next message continues on Claude Code · Opus');
    // the account it runs on there: picked with the switch, else the chat's pin there, else the one in use
    fx.accounts.claude = {
      active: { id: 'c1', email: 'me@x' },
      accounts: [
        { id: 'c1', email: 'me@x' },
        { id: 'c2', email: 'work@x' },
      ],
    };
    await m.render(createElement(SwitchChip, { threadId: 't' }));
    assert.equal($('.switch-chip span').textContent, 'Next message continues on Claude Code · Opus · me@x');
    fx.own['claude:t'] = { id: 'c2', pinned: true, serving: 'c1' };
    await m.render(createElement(SwitchChip, { threadId: 't' }));
    assert.equal($('.switch-chip span').textContent, 'Next message continues on Claude Code · Opus · Pinned to work@x · now on me@x');
    store.set({
      sessions: {
        t: { ...EMPTY_SESSION, pendingSwitch: { harness: 'claude', modelLabel: 'Opus', account: null, automaticAccount: true } },
      },
    });
    await flush();
    assert.equal($('.switch-chip span').textContent, 'Next message continues on Claude Code · Opus · Automatic');
    store.set({ sessions: { t: { ...EMPTY_SESSION, pendingSwitch: { harness: 'claude', modelLabel: 'Opus', account: 'c2' } } } });
    await flush();
    assert.equal($('.switch-chip span').textContent, 'Next message continues on Claude Code · Opus · work@x');
    await click($('[aria-label="Cancel switch"]'));
    assert.deepEqual(last('session'), ['session', 't', { pendingSwitch: null }]);
    assert.equal(m.host.innerHTML, '');
    await m.unmount();
  });

  test('a MoMo chat’s switch chip says where its next message goes, with no Undo or options: its brain chip changes it', async () => {
    store.set({
      momoChats: { t: 'main' },
      sessions: { t: { ...EMPTY_SESSION, pendingSwitch: { harness: 'acp:opencode', modelLabel: '', mode: 'auto' } } },
    });
    const m = await mount(createElement(SwitchChip, { threadId: 't' }));
    try {
      assert.equal($('.switch-chip span').textContent, 'Next message continues on opencode');
      assert.equal($('[aria-label="Cancel switch"]'), null);
      assert.equal($('.switch-chip button'), null);
    } finally {
      store.set({ momoChats: {} });
      await m.unmount();
    }
  });

  test('an ACP switch chip names its own harness, uses its icon and carries no first-tier account', async () => {
    store.set({ sessions: { t: { ...EMPTY_SESSION, pendingSwitch: { harness: 'acp:opencode', modelLabel: '' } } } });
    const m = await mount(createElement(SwitchChip, { threadId: 't' }));
    assert.equal($('.switch-chip span').textContent, 'Next message continues on opencode');
    assert.ok($('.switch-chip .harness-icon'));
    store.set({ sessions: { t: { ...EMPTY_SESSION, pendingSwitch: { harness: 'acp:other', modelLabel: 'Chosen' } } } });
    await flush();
    assert.match($('.switch-chip > span:not(.harness-icon)').textContent!, /acp:other · Chosen/);
    await m.unmount();
  });
}
