// Android's back button does what the visible "‹ Back" control does (it used to close the app from every screen); iOS registers nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { mount as mountKit, runtimeFor, sheet, CARD } from './support/phone/review-kit';
// variable paths: a static import would pull React Native's types into the Node project
const backLinkPath = '../mobile/src/components/BackLink';
const barPath = '../mobile/src/components/ChatHeader';
const { BackLink } = await import(backLinkPath);
const { ScreenHeader } = await import(barPath);
const reviewPath = '../mobile/src/screens/Review';
const planPath = '../mobile/src/components/PlanSheet';
const { Review } = await import(reviewPath);
const { PlanSheet } = await import(planPath);
const cardsPath = '../mobile/src/components/PairingCards';
const appPath = '../mobile/src/MobileApp';
const { PairingCards } = await import(cardsPath);
const { MobileApp } = await import(appPath);

const listeners = () => ((globalThis as any).__phoneBackListeners ??= []) as Array<() => boolean>;
const pressBack = () => listeners().at(-1)?.();

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const withPlatform = async (platform: string, run: () => Promise<void>) => {
  (globalThis as any).__phonePlatform = platform;
  try {
    await run();
  } finally {
    delete (globalThis as any).__phonePlatform;
    listeners().length = 0;
  }
};

test('on Android the back button runs the back link, and stops once the screen is gone', async () => {
  await withPlatform('android', async () => {
    const calls: string[] = [];
    const screen = await mount(createElement(BackLink, { onPress: () => calls.push('back') }));
    assert.equal(listeners().length, 1);
    assert.equal(pressBack(), true, 'the press is handled, so the app does not close');
    assert.deepEqual(calls, ['back']);
    await screen.unmount();
    assert.equal(listeners().length, 0);
    assert.equal(pressBack(), undefined, 'with no screen mounted the system closes the app as before');
  });
});

test("a chat screen's header answers the back button too", async () => {
  await withPlatform('android', async () => {
    const calls: string[] = [];
    const screen = await mount(createElement(ScreenHeader, { title: 'Changes', back: () => calls.push('chats') }));
    assert.equal(pressBack(), true);
    assert.deepEqual(calls, ['chats']);
    await screen.unmount();
  });
});

test('a screen that builds a new callback each render keeps one listener and the newest callback', async () => {
  await withPlatform('android', async () => {
    const calls: string[] = [];
    const screen = await mount(createElement(BackLink, { onPress: () => calls.push('old') }));
    await act(async () => screen.root.render(createElement(BackLink, { onPress: () => calls.push('new') })));
    assert.equal(listeners().length, 1);
    pressBack();
    assert.deepEqual(calls, ['new']);
    await screen.unmount();
  });
});

test('the newest screen gets the press first, so a nested screen goes back to the one below it', async () => {
  await withPlatform('android', async () => {
    const calls: string[] = [];
    const below = await mount(createElement(BackLink, { onPress: () => calls.push('below') }));
    const above = await mount(createElement(BackLink, { onPress: () => calls.push('above') }));
    pressBack();
    await above.unmount();
    pressBack();
    assert.deepEqual(calls, ['above', 'below']);
    await below.unmount();
  });
});

test('iOS registers no listener', async () => {
  await withPlatform('ios', async () => {
    const screen = await mount(createElement(BackLink, { onPress: () => {} }));
    assert.equal(listeners().length, 0);
    await screen.unmount();
  });
});

test('a diff goes back to the changes list, and only the list goes back to the chat', async () => {
  await withPlatform('android', async () => {
    const { runtime } = scripted((m) => {
      if (m === 'diff.list') return { files: [{ path: 'src/a.ts', status: 'modified', binary: false, added: 1, removed: 1 }], total: 1 };
      if (m === 'diff.read') return { binary: false, rows: [{ k: 'add', t: 'const a = 2;' }], next: null, total: 1 };
      return undefined;
    });
    let backs = 0;
    const screen = await mount(createElement(Review, { runtime, chatId: 'c', back: () => backs++ }));
    await flush();
    await click('View diff');
    assert.match(document.body.textContent!, /const a = 2;/);
    let handled: boolean | undefined;
    await act(async () => void (handled = pressBack()));
    assert.equal(handled, true);
    await flush();
    assert.doesNotMatch(document.body.textContent!, /const a = 2;/, 'back to the list');
    assert.equal(backs, 0, 'the chat is still behind it');
    await act(async () => void (handled = pressBack()));
    assert.equal(handled, true);
    assert.equal(backs, 1);
    await screen.unmount();
  });
});

test('the quick review sheet closes on back instead of leaving the app', async () => {
  await withPlatform('android', async () => {
    let closed = 0;
    await mountKit(sheet(runtimeFor({ cards: [CARD] }).runtime, { close: () => closed++ }));
    assert.equal(pressBack(), true);
    assert.equal(closed, 1);
  });
});

test('the plan sheet answers back only while it is open', async () => {
  await withPlatform('android', async () => {
    const calls: string[] = [];
    const card = {
      id: 'p',
      rev: 1,
      title: 'Approve this plan?',
      kind: 'plan',
      plan: { text: '1. Do it' },
      choices: [{ key: 'once', label: 'Approve plan' }],
    };
    const render = (open: boolean) => createElement(PlanSheet, { card, answer: async () => true, open, close: () => calls.push('closed') });
    const screen = await mount(render(false));
    assert.equal(listeners().length, 0, 'closed: the chat behind it owns back');
    await act(async () => screen.root.render(render(true)));
    assert.equal(pressBack(), true);
    assert.deepEqual(calls, ['closed']);
    await act(async () => screen.root.render(render(false)));
    assert.equal(listeners().length, 0);
    await screen.unmount();
  });
});

const idle = { pairs: [], presence: {}, outbox: [], safetyNumber: '123599', pendingPair: false, pairCleanup: false, pairingCommit: false };

test('on the safety-number screen back is Cancel pairing, and a finishing or unfinished pairing has no such control', async () => {
  await withPlatform('android', async () => {
    const calls: string[] = [];
    const cards = (state: object) =>
      createElement(PairingCards, { state: { ...idle, ...state }, busy: false, cancel: () => calls.push('cancel') });
    const confirming = await mount(cards({ pendingPair: true }));
    assert.equal(pressBack(), true);
    assert.deepEqual(calls, ['cancel']);
    await confirming.unmount();
    for (const state of [{}, { pendingPair: true, pairingCommit: true }, { pendingPair: true, pairCleanup: true }]) {
      const other = await mount(cards(state));
      assert.equal(listeners().length, 0, JSON.stringify(state));
      await other.unmount();
    }
  });
});

test('back on the Settings tab goes to the Chats tab, a Settings page goes back to Settings, and Chats leaves the app', async () => {
  await withPlatform('android', async () => {
    const online = {
      phase: 'online',
      generation: 1,
      user: { id: 'u', name: 'Dana' },
      pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
      selectedPair: 'p',
      error: null,
    };
    const s = scripted(
      (m) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'Fix login', state: 'idle', project: null }] } : undefined),
      online,
    );
    s.runtime.start = async () => {};
    const screen = await mount(createElement(MobileApp, { runtime: s.runtime }));
    await flush();
    const text = () => document.body.textContent!;
    assert.equal(listeners().length, 0, 'Chats is the top: back leaves the app');
    await click('Settings');
    assert.match(text(), /Sign out/);
    await click('Privacy');
    assert.match(text(), /end-to-end encrypted/);
    await act(async () => void pressBack());
    assert.match(text(), /Sign out/, 'the page went back to Settings');
    await act(async () => void pressBack());
    await flush();
    assert.doesNotMatch(text(), /Sign out/);
    assert.match(text(), /Fix login/, 'Settings went back to Chats');
    assert.equal(listeners().length, 0);
    await screen.unmount();
  });
});
