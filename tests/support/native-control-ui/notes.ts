// Claude in Chrome migration-note visibility, actions and stale replies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, f, ClaudeInChromeNote, mount, deferred, flush } from './fixture';
import type { Deferred } from '../async-scenarios.ts';

export function registerNotesCases() {
  /* ------------------------------ ClaudeInChromeNote ------------------------------ */

  /** The status main reports, with Claude Code's Chrome surface in `claudeChrome` state. */
  const availabilityChanged = () =>
    act(async () => {
      for (const cb of f.availListeners) cb();
      await Promise.resolve();
      await Promise.resolve();
    });

  /**
   * claudeChrome: Claude Code's Chrome state in the shared status; null while main hasn't answered. route: what
   * serves Claude's Chrome instead, MoPilot's own extension (main's chromeTools, the default where the build
   * ships it), Your Chrome as the browser channel, or nothing.
   */
  function noteFixture(
    claudeChrome: string | null,
    answer: boolean | ((id: any) => Promise<boolean>) = true,
    route: 'own' | 'yourChrome' | 'none' = 'own',
  ) {
    f.availability = claudeChrome;
    f.availListeners = [];
    f.chromeTools = route !== 'none';
    f.copyText = null;
    f.state = {
      prefs: { chromeProfileDir: '/profiles/work', browserChannel: route === 'yourChrome' ? 'chrome' : 'builtin' },
      claude: { status: { state: 'subscription' } },
    };
    f.calls = [];
    f.notePromise = typeof answer === 'function' ? answer : async () => answer;
  }
  const title = (m: { host: any }) => m.host.querySelector('.elsewhere-title')?.textContent;
  const noteCalls = () => f.calls.filter((c: any[]) => c[0] === 'note');

  test('note is hidden without asking main while Claude Code runs Claude in Chrome natively on a subscription', async () => {
    noteFixture('native');
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    try {
      await flush();
      assert.equal(m.host.querySelector('[role="note"]') === null, true);
      assert.deepEqual(noteCalls(), []);
    } finally {
      await m.close();
    }
  });

  test('note waits for the shared status before asking main', async () => {
    noteFixture(null);
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    try {
      await flush();
      assert.equal(m.host.querySelector('[role="note"]') === null, true);
      assert.deepEqual(noteCalls(), []);
    } finally {
      await m.close();
    }
  });

  // fallback: MoPilot's extension takes Claude in Chrome's place; unavailable: Claude's row can't use it (its tools
  // off, or a restart needed), so the note says nothing serves Claude
  for (const [state, text, action] of [
    ['fallback', "Claude in Chrome is off. Claude uses your Chrome through MoPilot's extension.", 'Set up'],
    ['unavailable', "Claude in Chrome is off, and MoPilot's extension isn't available here.", 'Use Your Chrome'],
  ]) {
    test(`note asks main and shows when it answers true (Claude Code's Chrome ${state})`, async () => {
      noteFixture(state, true);
      const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
      try {
        await flush();
        assert.deepEqual(noteCalls(), [['note', 't1']]);
        assert.ok(m.host.querySelector('[role="note"]'));
        assert.equal(title(m), text);
        assert.ok(m.button(action));
      } finally {
        await m.close();
      }
    });
  }

  test('note stays hidden when main answers false', async () => {
    noteFixture('fallback', false);
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    try {
      await flush();
      assert.deepEqual(noteCalls(), [['note', 't1']]);
      assert.equal(m.host.querySelector('[role="note"]') === null, true);
    } finally {
      await m.close();
    }
  });

  // #1631: Set up switched every Claude chat to Your Chrome, which hides the chrome_* tools MoPilot's own
  // extension serves it through; in a profile without the Playwright Extension, Claude (and Codex after a switch) lost Chrome
  test("Set up where MoPilot's extension serves Claude opens Browser settings and changes no browser channel", async () => {
    noteFixture('fallback', true, 'own');
    const m = await mount(createElement(ClaudeInChromeNote, {}));
    try {
      await flush();
      f.calls = [];
      await m.click(m.button('Set up'));
      assert.deepEqual(f.calls, [['dismiss'], ['navigate', { name: 'settings', section: 'browser' }]]);
      assert.equal(m.host.querySelector('[role="note"]') === null, true);
    } finally {
      await m.close();
    }
  });

  test('while Your Chrome is the channel the note names it, and Set up only opens Browser settings', async () => {
    noteFixture('fallback', true, 'yourChrome');
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    try {
      await flush();
      assert.equal(title(m), 'Claude in Chrome is off. Claude uses your Chrome through Your Chrome (the Playwright Extension).');
      f.calls = [];
      await m.click(m.button('Set up'));
      assert.deepEqual(f.calls, [['dismiss'], ['navigate', { name: 'settings', section: 'browser' }]]);
    } finally {
      await m.close();
    }
  });

  test('with nothing serving Claude the note says so, and Use Your Chrome switches once main has, then opens Browser settings', async () => {
    noteFixture('unavailable', true, 'none');
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    try {
      await flush();
      assert.equal(title(m), "Claude in Chrome is off, and MoPilot's extension isn't available here.");
      f.calls = [];
      await m.click(m.button('Use Your Chrome'));
      assert.deepEqual(f.calls, [
        ['configure', { channel: 'chrome', profileDir: '/profiles/work' }],
        ['setPrefs', { browserChannel: 'chrome' }],
        ['dismiss'],
        ['navigate', { name: 'settings', section: 'browser' }],
      ]);
      assert.equal(m.host.querySelector('[role="note"]') === null, true);
    } finally {
      await m.close();
    }
  });

  test('a switch to Your Chrome that main refuses keeps the note and the channel, and says why', async () => {
    noteFixture('unavailable', true, 'none');
    const real = f.native.browser.configure;
    f.native.browser.configure = async (c: any) => {
      f.calls.push(['configure', c]);
      throw new Error('no relay');
    };
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    try {
      await flush();
      f.calls = [];
      await m.click(m.button('Use Your Chrome'));
      await flush();
      assert.deepEqual(f.calls, [
        ['configure', { channel: 'chrome', profileDir: '/profiles/work' }],
        ['toastFailure', "Couldn't switch to Your Chrome", 'Error: no relay'],
      ]);
      assert.ok(m.host.querySelector('[role="note"]'));
    } finally {
      f.native.browser.configure = real;
      await m.close();
    }
  });

  test('closing the note dismisses it without changing the browser', async () => {
    noteFixture('fallback', true);
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    try {
      await flush();
      f.calls = [];
      await m.click(m.host.querySelector('[aria-label="Dismiss"]'));
      assert.deepEqual(f.calls, [['dismiss']]);
      assert.equal(m.host.querySelector('[role="note"]') === null, true);
    } finally {
      await m.close();
    }
  });

  test('copy without a bracketed action keeps the whole text and a default Set up button', async () => {
    noteFixture('fallback', true);
    f.copyText = 'Your Chrome replaces Claude in Chrome';
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    try {
      await flush();
      assert.equal(title(m), 'Your Chrome replaces Claude in Chrome');
      assert.deepEqual(
        [...m.host.querySelectorAll('button')].map((b: any) => b.textContent),
        ['Set up', ''],
      );
    } finally {
      f.copyText = null;
      await m.close();
    }
  });

  test('a stale answer for a previous chat does not show the note for the current one', async () => {
    const pending: Record<string, Deferred<boolean>> = { a: deferred<boolean>(), b: deferred<boolean>() };
    noteFixture('fallback', (id) => pending[id].promise);
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 'a' }));
    try {
      await m.render(createElement(ClaudeInChromeNote, { threadId: 'b' }));
      await act(async () => {
        pending.b.resolve(false);
        await Promise.resolve();
      });
      await act(async () => {
        pending.a.resolve(true);
        await Promise.resolve();
      });
      assert.deepEqual(noteCalls(), [
        ['note', 'a'],
        ['note', 'b'],
      ]);
      assert.equal(m.host.querySelector('[role="note"]') === null, true);
    } finally {
      await m.close();
    }
  });

  test('an answer arriving after unmount is ignored', async () => {
    const d = deferred();
    noteFixture('fallback', () => d.promise);
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    await m.close();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await act(async () => {
        d.resolve(true);
        await Promise.resolve();
      });
    } finally {
      console.error = original;
    }
    assert.deepEqual(errors, []);
    assert.equal(document.querySelector('[role="note"]') === null, true);
  });

  test('the note hides when native Chrome turns on and comes back when it turns off', async () => {
    noteFixture('fallback', true);
    const m = await mount(createElement(ClaudeInChromeNote, { threadId: 't1' }));
    try {
      await flush();
      assert.ok(m.host.querySelector('[role="note"]'));
      f.availability = 'native';
      await availabilityChanged();
      assert.equal(m.host.querySelector('[role="note"]') === null, true);
      assert.deepEqual(noteCalls(), [['note', 't1']]);
      // an API key login, or the extension removed, takes Claude in Chrome away from Claude Code again
      f.availability = 'fallback';
      await availabilityChanged();
      await flush();
      assert.deepEqual(noteCalls(), [
        ['note', 't1'],
        ['note', 't1'],
      ]);
      assert.ok(m.host.querySelector('[role="note"]'));
    } finally {
      await m.close();
    }
  });
}
