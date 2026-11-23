// The site card's "Allow and switch to Auto" (#1523) on every harness: Codex and Claude Code switch the composer's
// permission where the model can auto-approve; a basic harness switches to the mode its quirks map onto Approve for me;
// it is offered only from Ask, and a refused mode leaves the card unanswered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { mockSource, popoverStubs, stubStore } from './support/stubs.ts';

const fx: any = {};
const reset = (o: any = {}) =>
  Object.assign(fx, {
    basic: null,
    firstTier: 'claude',
    permission: 'default',
    nativePermission: null,
    autoMode: undefined,
    mode: null,
    permissionModes: undefined,
    chosen: [],
    prefs: [],
    chatConfig: {},
    ok: true,
    ...o,
  });
reset();
stubStore(
  {
    useStore: (sel: any) =>
      sel({
        prefs: { permission: fx.permission },
        chatConfig: fx.chatConfig,
        basicHarnesses: fx.basic ? [{ id: fx.basic, permissionModes: fx.permissionModes }] : [],
      }),
    setChatConfig: (id: string, patch: any) => {
      fx.chatConfig[id] = { ...fx.chatConfig[id], ...patch };
    },
  },
  {
    'src/store/core.ts': { setPrefs: (p: any) => fx.prefs.push(p) },
    'src/store/chats.ts': { chatBasicHarness: () => fx.basic },
  },
);
mockSource('src/session/harness/select.ts', {
  composerFirstTier: () => fx.firstTier,
  useComposerFirstTier: () => fx.firstTier,
  useEffectiveSelection: () => ({ model: fx.autoMode === undefined ? {} : { autoMode: fx.autoMode } }),
});
mockSource('src/session/acpControls.ts', {
  useBasicSelection: () => ({ mode: fx.mode }),
  splitModes: (await import('../src/harness/modeRows.ts')).splitModes,
  chooseBasicMode: async (...a: any[]) => (fx.chosen.push(a.slice(1).filter((x) => typeof x === 'string')), fx.ok),
});
mockSource('src/store/session/useSession.ts', {
  useSessionField: (_id: string, pick: any) => pick({ permission: fx.nativePermission }),
});
mockSource('src/components/ui/Popover.tsx', popoverStubs());
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AutoSwitchItem } = await import('../src/components/thread/approvals/autoSwitch.tsx');

async function show() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  let allowed = 0;
  await act(() => root.render(createElement(AutoSwitchItem, { threadId: 'chat1', onAllow: () => void allowed++ })));
  const item = host.querySelector('[role=menuitem]') as any;
  const pick = async () =>
    act(async () => {
      item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
  return {
    item,
    pick,
    allowed: () => allowed,
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

test('Codex or Claude Code in Ask: the item switches the composer to Approve for me, then allows', async () => {
  reset();
  const v = await show();
  try {
    assert.equal(v.item.textContent, 'Allow and switch to AutoApprove for me reviews the rest of this chat.');
    await v.pick();
    assert.deepEqual(fx.prefs, [{ permission: 'auto-review' }]);
    assert.equal(fx.chatConfig.chat1.permission, 'auto-review');
    assert.equal(v.allowed(), 1);
  } finally {
    await v.close();
  }
});

test('no item where the model cannot auto-approve, outside Ask, or with no harness to switch', async () => {
  for (const o of [
    { autoMode: false },
    { permission: 'full-access' },
    { permission: 'read-only' },
    { chatConfig: { chat1: { permission: 'read-only' } } },
    { nativePermission: 'plan' },
    { nativePermission: 'dontAsk' },
    { nativePermission: 'bypassPermissions' },
    { firstTier: null },
  ]) {
    reset(o);
    const v = await show();
    try {
      assert.equal(v.item, null, JSON.stringify(o));
    } finally {
      await v.close();
    }
  }
});

const control = (current: string) => ({
  current,
  via: 'mode',
  options: [
    { id: 'ask', name: 'Ask', description: null },
    { id: 'auto', name: 'Auto edit', description: null },
    { id: 'yolo', name: 'Yolo', description: null },
  ],
});
const anchors = { ask: 'default', auto: 'auto-review', yolo: 'full-access' };

test('a basic harness in its Ask mode: the item picks the mode mapped onto Approve for me, then allows; a refused mode leaves the card', async () => {
  reset({ basic: 'acp:opencode', firstTier: null, mode: control('ask'), permissionModes: anchors });
  let v = await show();
  try {
    await v.pick();
    assert.deepEqual(fx.chosen, [['acp:opencode', 'auto']]);
    assert.equal(v.allowed(), 1);
  } finally {
    await v.close();
  }
  reset({ basic: 'acp:opencode', firstTier: null, mode: control('ask'), permissionModes: anchors, ok: false });
  v = await show();
  try {
    await v.pick();
    assert.equal(v.allowed(), 0);
  } finally {
    await v.close();
  }
});

test('a basic harness with no modes, no mode for Approve for me, or not in Ask offers no item', async () => {
  for (const o of [
    { mode: null },
    { mode: control('ask'), permissionModes: { ask: 'default' } },
    { mode: control('yolo'), permissionModes: anchors },
  ]) {
    reset({ basic: 'acp:opencode', firstTier: null, ...o });
    const v = await show();
    try {
      assert.equal(v.item, null, JSON.stringify(o));
    } finally {
      await v.close();
    }
  }
});
