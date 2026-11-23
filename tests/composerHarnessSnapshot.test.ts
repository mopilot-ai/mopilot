// The composer's harness and basic-harness controls read one snapshot of the chat's session (src/session/harness/select.ts
// useComposerFamily): a patch held for the next frame (src/store/session/useSession.ts) that ends a switch the committed
// session still shows pending must not leave the composer with neither a first-tier nor a basic harness (#2847).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { mount } from './support/composer-kit.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

let patchCb: (p: any) => void = () => {};
installNative(
  fakeNative({
    session: {
      onPatch: (cb: (p: any) => void) => (patchCb = cb),
      onCapsChanged: () => {},
      snapshot: async () => null,
      patch: async () => true,
      caps: async () => ({ kind: 'claude', tier: 'first', caps: { speed: { state: 'native' } } }),
    },
    // the selection reads the MoPilot account and the Claude key: signed out, a key never answered
    mopilot: {
      status: async () => ({ signedIn: false, signingIn: false, user: null, balanceMicros: null, shareUsageData: null, modelCaps: null }),
      onEvent: () => {},
    },
    claude: { apiKey: () => new Promise(() => {}) },
  }),
);
const sess = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { useComposerHarness } = await import('../src/session/useComposerHarness.ts');
const { composerFirstTier, useComposerFamily, useEffectiveSelection } = await import('../src/session/harness/select.ts');
const store = await import('../src/store/core.ts');
const { claudeThreadId } = await import('../src/harness/types.ts');

const CHAT = 'acp:opencode:s1';
let seen: { harness: string | null; basic: string | null; family: string } | undefined;
function Probe() {
  const { harness, basic } = useComposerHarness(CHAT);
  seen = { harness, basic, family: useComposerFamily(CHAT) };
  return null;
}

test("a switch's end held for the next frame changes the composer's harness when it is committed, not before", async () => {
  sess.startSessions();
  sess.useSessions.setState({
    sessions: { [CHAT]: { ...EMPTY_SESSION, rev: 1, pendingSwitch: { harness: 'claude' } as any } },
    loaded: {},
  });
  const m = await mount(h(Probe));
  try {
    assert.deepEqual(seen, { harness: 'claude', basic: null, family: 'claude' }, 'the switch to Claude is pending');
    // main says the switch ended; the store hears it at the next paint
    patchCb({ chatId: CHAT, rev: 2, patch: { pendingSwitch: null } });
    assert.equal(composerFirstTier(CHAT), null, 'code outside a render reads the newest copy');
    // a render before the paint (another store changed): the patch is still held
    act(() => m.renderInsideAct(h(Probe)));
    assert.deepEqual(seen, { harness: 'claude', basic: null, family: 'claude' }, 'the render reads one snapshot');
    sess.flushSessionPatches();
    await m.render(h(Probe));
    assert.deepEqual(seen, { harness: null, basic: 'opencode', family: 'acp' }, 'committed: the chat is back on its basic harness');
  } finally {
    await m.unmount();
  }
});

test("a Claude chat's own model shows once its switch away is no longer pending, not while that is still held", async () => {
  const chat = claudeThreadId('s2');
  const models = [
    { id: 'opus', efforts: [] },
    { id: 'sonnet', isDefault: true, efforts: [] },
  ];
  store.set((s: any) => ({
    claude: { ...s.claude, models },
    prefs: { ...s.prefs, claudeSelection: { model: 'sonnet', effort: null } },
    chatConfig: { ...s.chatConfig, [chat]: { model: 'opus' } },
  }));
  sess.useSessions.setState((s: any) => ({
    sessions: { ...s.sessions, [chat]: { ...EMPTY_SESSION, rev: 1, pendingSwitch: { harness: 'codex' } } },
  }));
  let model: string | null | undefined;
  function Selection() {
    model = useEffectiveSelection('claude', chat).modelId;
    return null;
  }
  const m = await mount(h(Selection));
  try {
    assert.equal(model, 'sonnet', 'about to switch away: the chat does not keep its own model');
    patchCb({ chatId: chat, rev: 2, patch: { pendingSwitch: null } });
    act(() => m.renderInsideAct(h(Selection)));
    assert.equal(model, 'sonnet', 'the held end of the switch is not read before it is committed');
    sess.flushSessionPatches();
    await m.render(h(Selection));
    assert.equal(model, 'opus');
  } finally {
    await m.unmount();
  }
});

for (const harness of ['codex', 'claude'] as const)
  test(`the composer shows its pending ${harness} model when another chat changes the default`, async () => {
    const chat = claudeThreadId(`pending-${harness}`);
    store.set((s: any) => ({
      prefs: { ...s.prefs, model: 'other-default', claudeSelection: { model: 'sonnet', effort: null } },
      runtime: { ...s.runtime, [chat]: { settings: { model: 'source-model' } } },
    }));
    sess.useSessions.setState((s: any) => ({
      sessions: { ...s.sessions, [chat]: { ...EMPTY_SESSION, rev: 1, pendingSwitch: { harness, model: 'pending-model' } } },
    }));
    let model: string | null | undefined;
    function Selection() {
      model = useEffectiveSelection(harness, chat).modelId;
      return null;
    }
    const m = await mount(h(Selection));
    try {
      assert.equal(model, 'pending-model');
      act(() => store.set((s: any) => ({ prefs: { ...s.prefs, model: 'new-default', claudeSelection: { model: 'opus', effort: null } } })));
      assert.equal(model, 'pending-model');
      act(() =>
        sess.useSessions.setState((s: any) => ({
          sessions: { ...s.sessions, [chat]: { ...s.sessions[chat], pendingSwitch: { harness, model: '' } } },
        })),
      );
      assert.equal(model, harness === 'codex' ? 'new-default' : 'opus');
      if (harness === 'codex') {
        act(() => store.set((s: any) => ({ prefs: { ...s.prefs, model: null }, config: { model: 'configured-codex' } })));
        assert.equal(model, 'configured-codex', 'a source harness model is never a Codex default');
      }
      act(() =>
        sess.useSessions.setState((s: any) => ({
          sessions: { ...s.sessions, [chat]: { ...s.sessions[chat], pendingSwitch: { harness, model: null } } },
        })),
      );
      act(() =>
        store.set((s: any) => ({ prefs: { ...s.prefs, model: 'later-model', claudeSelection: { model: 'later-model', effort: null } } })),
      );
      assert.notEqual(model, 'later-model', 'a captured native default never follows another chat preference');
    } finally {
      await m.unmount();
    }
  });
