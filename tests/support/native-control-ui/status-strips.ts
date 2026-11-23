// Native cleanup, connection notices and status-strip priorities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, f, NativeCleanup, ChromeLinkNotice, StatusStrip, mount, flush, window } from './fixture';

export function registerStatusStripsCases() {
  /* ------------------------------ NativeCleanup ------------------------------ */

  test('native cleanup renders nothing without a pending release', async () => {
    f.session = { nativeCleanup: null };
    f.calls = [];
    const m = await mount(createElement(NativeCleanup, { threadId: 'chat' }));
    try {
      assert.equal(m.host.innerHTML, '');
      assert.deepEqual(f.calls, [['useSession', 'chat']]);
    } finally {
      await m.close();
    }
  });

  test('native cleanup shows a releasing status, then a restart message when the release failed', async () => {
    f.session = { nativeCleanup: { phase: 'releasing', turnId: 'turn', error: null } };
    const m = await mount(createElement(NativeCleanup, { threadId: 'chat' }));
    try {
      const status = m.host.querySelector('[role="status"]')!;
      assert.equal(status.getAttribute('data-state'), 'releasing');
      assert.equal(status.textContent, 'Releasing browser/computer…');
      f.session = { nativeCleanup: { phase: 'failed', turnId: 'turn', error: 'timeout' } };
      await m.render(createElement(NativeCleanup, { threadId: 'chat' }));
      const failed = m.host.querySelector('[role="status"]')!;
      assert.equal(failed.getAttribute('data-state'), 'failed');
      assert.equal(
        failed.querySelector('.elsewhere-title')!.textContent,
        'Codex didn’t confirm it let go of control. Restart Codex to unblock it.',
      );
      // the way on: restart Codex, then reconnect; a failed restart says so
      f.calls = [];
      await act(async () => m.button('Restart Codex').click());
      await flush();
      assert.deepEqual(
        f.calls.filter((c: any) => c[0] !== 'useSession'),
        [['restartCodex'], ['connect']],
      );
      f.calls = [];
      f.restartFails = true;
      await act(async () => m.button('Restart Codex').click());
      await flush();
      assert.deepEqual(f.calls.filter((c: any) => c[0] !== 'useSession').at(-1), ['toastFailure', "Couldn't restart Codex", 'Error: busy']);
      f.restartFails = false;
    } finally {
      await m.close();
    }
  });

  /* ------------------------------ StatusStrip ------------------------------ */

  async function strip(session: any, { tasks = false, approval = false, confirm = false } = {}) {
    f.session = { computer: null, nativeCleanup: null, goal: null, ...session };
    f.tasks = tasks;
    const confirms: boolean[] = [];
    const m = await mount(
      createElement(StatusStrip, { threadId: 'chat', approval, confirm, setConfirm: (v: boolean) => confirms.push(v) }),
    );
    const shown =
      m.host.querySelector('[data-marker]')?.getAttribute('data-marker') ??
      m.host.querySelector('[role="status"]')?.getAttribute('data-state') ??
      null;
    return { m, shown, confirms, html: m.host.innerHTML };
  }
  const cleanup = { phase: 'releasing', turnId: 'turn', error: null };

  test('computer control outranks native cleanup', async () => {
    const s = await strip({ computer: { app: 'Safari' }, nativeCleanup: cleanup }, { approval: true, tasks: true });
    try {
      assert.equal(s.shown, 'computer');
    } finally {
      await s.m.close();
    }
  });

  test('native cleanup outranks a pending approval and background tasks', async () => {
    const s = await strip({ nativeCleanup: cleanup, goal: { objective: 'ship' } }, { approval: true, tasks: true });
    try {
      assert.equal(s.shown, 'releasing');
      assert.equal(s.m.host.textContent, 'Releasing browser/computer…');
    } finally {
      await s.m.close();
    }
  });

  test('a pending approval hides the strip, and nothing shows with nothing to show', async () => {
    for (const opts of [{ approval: true, tasks: true }, {}]) {
      const s = await strip({ goal: opts.approval ? { objective: 'ship' } : null }, opts);
      try {
        assert.equal(s.html, '');
      } finally {
        await s.m.close();
      }
    }
  });

  test('the goal is never a strip: only the Stop-all question shows, whatever the goal', async () => {
    for (const [opts, expected] of [
      [{ tasks: true, confirm: false }, null],
      [{ tasks: false, confirm: true }, null],
      [{ tasks: true, confirm: true }, 'tasks'],
    ] as const) {
      const s = await strip({ goal: { objective: 'ship' } }, opts);
      try {
        assert.equal(s.shown, expected, JSON.stringify(opts));
      } finally {
        await s.m.close();
      }
    }
  });

  const down = {
    connected: false,
    browser: null,
    installed: true,
    dropped: true,
    reconnectUrl: 'https://clau.de/chrome/reconnect',
    permissionsUrl: null,
  };

  test('Claude in Chrome disconnected outranks the Stop-all question, not a pending approval', async () => {
    // the chat's current segment runs Claude in Chrome (its controller plan); otherwise the drop is not this chat's
    const plan = { key: 'claude:s', iab: 'mopilot-browser', cu: 'mopilot-computer', bu: 'claude-in-chrome' };
    let s = await strip(
      { chromeLink: down, controllerPlan: { ...plan, bu: 'your-chrome' }, goal: { objective: 'ship' } },
      { tasks: true, confirm: true },
    );
    try {
      assert.equal(s.shown, 'tasks');
    } finally {
      await s.m.close();
    }
    s = await strip({ chromeLink: down, controllerPlan: plan, goal: { objective: 'ship' } }, { tasks: true, confirm: true });
    try {
      assert.equal(s.shown, 'disconnected');
      assert.equal(s.m.host.querySelector('.elsewhere-title')?.textContent, 'Claude in Chrome is disconnected');
    } finally {
      await s.m.close();
    }
    s = await strip({ chromeLink: down, controllerPlan: plan }, { approval: true });
    try {
      assert.equal(s.html, '');
    } finally {
      await s.m.close();
    }
    // a connected link, or one still connecting at the start (not a drop), shows nothing
    for (const chromeLink of [
      { ...down, connected: true, dropped: false },
      { ...down, dropped: false },
    ]) {
      s = await strip({ chromeLink, goal: { objective: 'ship' } });
      try {
        assert.equal(s.html, '');
      } finally {
        await s.m.close();
      }
    }
  });

  /* ------------------------------ ChromeLinkNotice ------------------------------ */

  async function linkNotice(chromeLink: any) {
    f.session = { chromeLink };
    f.calls = [];
    return mount(createElement(ChromeLinkNotice, { threadId: 'chat' }));
  }

  test('the chat chip shows only while the link is down, and names the browser it lost', async () => {
    for (const link of [null, { ...down, connected: true, dropped: false }, { ...down, dropped: false }]) {
      const m = await linkNotice(link);
      try {
        assert.equal(m.host.innerHTML, '');
      } finally {
        await m.close();
      }
    }
    const m = await linkNotice({ ...down, browser: 'Chrome on Mac' });
    try {
      assert.equal(m.host.querySelector('.elsewhere-title')?.textContent, 'Claude in Chrome lost its connection to Chrome on Mac');
      assert.deepEqual(
        [...m.host.querySelectorAll('button')].map((b: any) => b.textContent),
        ['Reconnect'],
      );
    } finally {
      await m.close();
    }
  });

  test('Reconnect reconnects this chat; when the link stays down it says why and offers the reconnect page', async () => {
    let finish!: (v: any) => void;
    f.reconnect = () => new Promise((r) => (finish = r));
    const m = await linkNotice(down);
    try {
      await m.click(m.button('Reconnect'));
      assert.deepEqual(
        f.calls.filter((c: any[]) => c[0] === 'chromeReconnect'),
        [['chromeReconnect', 'chat']],
      );
      assert.equal(m.button('Reconnecting…').disabled, true);
      await act(async () => finish([{ chatId: 'chat', link: { ...down, connected: true, dropped: false }, error: null }]));
      assert.equal(m.host.querySelector('.elsewhere-body'), null);
      // still down, with no error from the CLI
      f.reconnect = async () => [{ chatId: 'chat', link: down, error: null }];
      await m.click(m.button('Reconnect'));
      await flush();
      assert.equal(
        m.host.querySelector('.elsewhere-body')?.textContent,
        'Still disconnected. Check that Chrome is open and Claude is signed in.',
      );
      f.calls = [];
      await m.click(m.button('Open in Chrome'));
      assert.deepEqual(f.calls, [['open', 'https://clau.de/chrome/reconnect']]);
      // the CLI's own error, then a failed call
      f.reconnect = async () => [{ chatId: 'chat', link: null, error: 'socket closed' }];
      await m.click(m.button('Reconnect'));
      await flush();
      assert.equal(m.host.querySelector('.elsewhere-body')?.textContent, 'socket closed');
      f.reconnect = async () => {
        throw new Error('ipc gone');
      };
      await m.click(m.button('Reconnect'));
      await flush();
      assert.equal(m.host.querySelector('.elsewhere-body')?.textContent, 'ipc gone');
      f.reconnect = () => Promise.reject('plain');
      await m.click(m.button('Reconnect'));
      await flush();
      assert.equal(m.host.querySelector('.elsewhere-body')?.textContent, 'plain');
    } finally {
      await m.close();
    }
    // without a reconnect page, a failure offers none
    f.reconnect = async () => [];
    const bare = await linkNotice({ ...down, reconnectUrl: null });
    try {
      await bare.click(bare.button('Reconnect'));
      await flush();
      assert.ok(bare.host.querySelector('.elsewhere-body'));
      assert.equal(bare.button('Open in Chrome'), undefined);
    } finally {
      await bare.close();
    }
  });

  test('running background tasks show the Stop-all question when it is asked, and nothing otherwise', async () => {
    const quiet = await strip({}, { tasks: true, confirm: false });
    try {
      assert.equal(quiet.shown, null);
    } finally {
      await quiet.m.close();
    }
    const s = await strip({}, { tasks: true, confirm: true });
    try {
      assert.equal(s.shown, 'tasks');
      const panel = s.m.host.querySelector('[data-marker="tasks"]') as any;
      assert.equal(panel.getAttribute('data-running'), '1');
      await s.m.click(panel);
      assert.deepEqual(s.confirms, [false]);
    } finally {
      await s.m.close();
    }
  });

  /* --------------------------- background control --------------------------- */

  const notesEntry = {
    bundleId: 'com.apple.Notes',
    app: 'Notes',
    title: 'Trip',
    windowId: 5,
    thumbnail: 'data:image/jpeg;base64,AAA',
    at: 2,
    takenOver: false,
  };
  /** A click a person made (the strip ignores synthetic ones). */
  async function stripClick(m: any, el: any, trusted = true) {
    assert.ok(el);
    await act(async () => {
      const ev = new (window as any).MouseEvent('click', { bubbles: true });
      Object.defineProperty(ev, 'isTrusted', { value: trusted });
      el.dispatchEvent(ev);
      await Promise.resolve();
    });
  }

  test('background control shows under a pending approval and over the Stop-all question; computer control and cleanup outrank it', async () => {
    const appControl = { apps: [notesEntry] };
    for (const [session, opts, expected] of [
      [{ appControl, goal: { objective: 'ship' } }, { tasks: true, confirm: true }, 'background'],
      [{ appControl }, { approval: true }, null],
      [{ appControl, computer: { app: 'Safari' } }, {}, 'computer'],
      [{ appControl, nativeCleanup: cleanup }, {}, 'releasing'],
      [{ appControl: { apps: [] }, goal: { objective: 'ship' } }, { tasks: true, confirm: true }, 'tasks'],
    ] as const) {
      const s = await strip(session, opts);
      try {
        assert.equal(s.shown, expected, JSON.stringify(session));
      } finally {
        await s.m.close();
      }
    }
  });

  test("the background strip: a live thumbnail, the app and window, Take over and Stop; taken over, Done, continue; only a person's clicks count", async () => {
    f.calls = [];
    const s = await strip({ appControl: { apps: [notesEntry, { ...notesEntry, bundleId: 'com.apple.mail', app: 'Mail' }] } });
    try {
      const img = s.m.host.querySelector('img.cu-app-thumb') as any;
      assert.equal(img.getAttribute('src'), 'data:image/jpeg;base64,AAA');
      assert.equal(img.getAttribute('alt'), 'Live view of Notes');
      assert.equal(s.m.host.querySelector('.elsewhere-title')!.textContent, 'Using Notes · Trip · +1');
      await stripClick(s.m, s.m.button('Take over'), false);
      await stripClick(s.m, s.m.button('Stop'), false);
      assert.deepEqual(
        f.calls.filter((c: any) => c[0] !== 'useSession'),
        [],
      );
      await stripClick(s.m, s.m.button('Take over'));
      await stripClick(s.m, s.m.button('Stop'));
      assert.deepEqual(
        f.calls.filter((c: any) => c[0] !== 'useSession'),
        [
          ['takeOver', 'chat', 'com.apple.Notes'],
          ['stop', 'chat'],
        ],
      );
    } finally {
      await s.m.close();
    }
    // no thumbnail yet, no title, one app; then taken over
    const t = await strip({ appControl: { apps: [{ ...notesEntry, thumbnail: null, title: null, takenOver: true }] } });
    try {
      assert.equal(t.shown, 'takenOver');
      assert.equal(t.m.host.querySelector('img'), null);
      assert.ok(t.m.host.querySelector('.elsewhere-icon'));
      assert.equal(t.m.host.querySelector('.elsewhere-title')!.textContent, 'You took over Notes');
      assert.equal(t.m.button('Take over'), undefined);
      f.calls = [];
      await stripClick(t.m, t.m.button('Done, continue'), false);
      await stripClick(t.m, t.m.button('Done, continue'));
      assert.deepEqual(
        f.calls.filter((c: any) => c[0] !== 'useSession'),
        [['handBack', 'chat', 'com.apple.Notes']],
      );
    } finally {
      await t.m.close();
    }
    const u = await strip({ appControl: { apps: [{ ...notesEntry, title: null }] } });
    try {
      assert.equal(u.m.host.querySelector('.elsewhere-title')!.textContent, 'Using Notes');
    } finally {
      await u.m.close();
    }
  });

  test('the background strip renders nothing without an app', async () => {
    const { AppControlStrip } = await import('../../../src/components/thread/AppControlStrip.tsx');
    for (const appControl of [null, { apps: [] }]) {
      f.session = { appControl };
      const m = await mount(createElement(AppControlStrip, { threadId: 'chat' }));
      try {
        assert.equal(m.host.innerHTML, '');
      } finally {
        await m.close();
      }
    }
  });
}
