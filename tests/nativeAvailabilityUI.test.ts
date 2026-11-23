// UI for native availability (BU-07, BU-08, C1): the per-harness status rows on the Browser and Computer use
// settings, their setup actions, and the shared status hook (src/session/nativeAvailability.ts) that also drives
// the Claude in Chrome note. The components and the hook are real; app services are fixture stubs.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { iconStubs, mockSource, stubStore } from './support/stubs.ts';
import { registerPresentationUI } from './support/native-availability/presentation-ui.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = {
  calls: [],
  listeners: { changed: [], channel: [] },
  state: { prefs: { chromeProfileDir: 'Profile 1' }, threads: {} },
  useStore: (select: any) => select(f.state),
  threadTitle: () => '',
  navigate: (r: any) => f.calls.push(['navigate', r]),
  setPrefs: (p: any) => f.calls.push(['setPrefs', p]),
  toast: (text: string, kind: string) => f.calls.push(['toast', text, kind]),
  toastFailure: (what: string) => (e: any) => f.calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
  isEnter: () => false,
  Lock: () => null,
  MousePointerClick: () => null,
  Group: ({ title, desc, children, action }: any) =>
    createElement('section', { 'data-group': title, 'data-desc': desc }, action ?? null, children),
  Row: ({ title, desc, children }: any) =>
    createElement('div', { className: 'row', 'data-title': title }, createElement('span', { className: 'desc' }, desc ?? ''), children),
  native: {
    availability: {
      status: (refresh: boolean) => {
        f.calls.push(['status', refresh]);
        return f.statusAnswer();
      },
      onChanged: (cb: () => void) => {
        f.listeners.changed.push(cb);
        return () => f.calls.push(['offChanged']);
      },
      retry: async () => {
        f.calls.push(['retry']);
        return f.statusAnswer();
      },
      // Claude in Chrome's live links (BU-07): none unless a test sets them
      chromeLinks: (refresh: boolean) => {
        f.calls.push(['chromeLinks', refresh]);
        return f.linksAnswer ? f.linksAnswer() : Promise.resolve([]);
      },
      onChromeLinksChanged: (cb: () => void) => {
        f.listeners.links.push(cb);
        return () => f.calls.push(['offLinks']);
      },
      chromeBrowsers: () => {
        f.calls.push(['chromeBrowsers']);
        return f.browsersAnswer();
      },
      chromeReconnect: (chatId: any) => {
        f.calls.push(['chromeReconnect', chatId]);
        return f.reconnectAnswer();
      },
      chromeSelect: (id: string) => {
        f.calls.push(['chromeSelect', id]);
        return f.selectAnswer();
      },
    },
    browser: {
      onChannelChanged: (cb: () => void) => {
        f.listeners.channel.push(cb);
        return () => f.calls.push(['offChannel']);
      },
      configure: async (c: any) => {
        f.calls.push(['configure', c]);
      },
    },
    shell: {
      openExternal: (u: string) => f.calls.push(['openExternal', u]),
      openPath: (p: string) => f.calls.push(['openPath', p]),
    },
    computer: {
      status: async () => ((f.computerReads = (f.computerReads ?? 0) + 1), f.computer),
      openSettings: async (kind: string) => f.calls.push(['computerOpenSettings', kind]),
      onChanged: () => () => {},
      revoke: async (chatId: string | null, bundleId: string) => {
        f.calls.push(['revoke', chatId, bundleId]);
        f.computer = {
          ...f.computer,
          grants: { ...f.computer.grants, global: f.computer.grants.global.filter((g: any) => chatId !== null || g.bundleId !== bundleId) },
        };
        return true;
      },
      revokeAll: async () => {
        f.calls.push(['revokeAll']);
        f.computer = { ...f.computer, grants: { ...f.computer.grants, global: [] } };
        return true;
      },
    },
  },
};
// The components and the hook are real; every other app module they import is a fixture stub.
const via =
  (name: string) =>
  (...a: any[]) =>
    f[name](...a);
installNativeStub(f.native);
stubStore(Object.fromEntries(['navigate', 'setPrefs', 'toast', 'toastFailure', 'useStore', 'threadTitle'].map((n) => [n, via(n)])));
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => f.calls.push(['openExternal', u]) } });
mock.module('../src/components/pages/Settings.tsx', { namedExports: { Group: via('Group'), Row: via('Row') } });
mockSource('src/components/ui/icons.tsx', iconStubs(undefined, { Lock: via('Lock'), MousePointerClick: via('MousePointerClick') }));
// menus (MenuList) and clickable rows use the real keyboard handling
const { listKey, stepIndex, onActivate } = await import('../src/lib/focus.ts');
mock.module('../src/lib/focus.ts', { namedExports: { isEnter: via('isEnter'), listKey, stepIndex, onActivate } });
const { NativeControlStatus } = await import('../src/components/pages/settings/NativeControlStatus.tsx');
const { ComputerUseSettings } = await import('../src/components/pages/settings/ComputerUse.tsx');
const { useNativeAvailability, claudeRunsClaudeInChrome, useChromeLinks, chromeLinkSummary } = await import(
  '../src/session/nativeAvailability.ts'
);

const flush = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
async function mount(element: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return {
    host,
    rows: () =>
      [...host.querySelectorAll('.row')].map((r: any) => [
        r.getAttribute('data-title'),
        r.querySelector('.status-pill')?.textContent ?? null,
        r.querySelector('.status-pill')?.className ?? null,
        r.querySelector('.desc')?.textContent,
        [...r.querySelectorAll('button')].map((b: any) => b.textContent),
      ]),
    button: (text: string) => [...host.querySelectorAll('button')].find((b: any) => b.textContent === text) as any,
    click: async (el: any) => {
      assert.ok(el);
      await act(async () => {
        el.click();
        await Promise.resolve();
      });
      await flush();
    },
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

const surface = (state: string, label: string, detail: string | null = null, actions: any[] = []) => ({ state, label, detail, actions });
const STATUS = {
  platform: 'darwin',
  at: 1,
  harnesses: [
    {
      harness: 'codex',
      label: 'Codex',
      chrome: surface('unavailable', 'Unavailable', "The ChatGPT for Chrome extension isn't installed. Your Chrome isn't selected.", [
        { kind: 'url', label: 'Install ChatGPT for Chrome', url: 'https://store/openai' },
        { kind: 'yourChrome', label: 'Use Your Chrome' },
      ]),
      computer: surface('fallback', 'Fallback (MoPilot computer use)', "MoPilot couldn't install Codex Computer Use 26.2: EPERM", [
        { kind: 'retry', label: 'Try again' },
      ]),
    },
    {
      harness: 'claude',
      label: 'Claude Code',
      chrome: { ...surface('native', 'Native (Claude in Chrome)'), linkStatus: true },
      computer: surface('unavailable', 'Unavailable', "MoPilot's computer use is not ready.", [
        { kind: 'settings', label: 'Computer use settings', section: 'computer' },
      ]),
    },
    {
      harness: 'acp',
      label: 'Other harnesses',
      chrome: surface('mopilot', 'Your Chrome'),
      computer: surface('mopilot', 'MoPilot computer use'),
    },
  ],
};
function reset(answer: () => Promise<any> = async () => STATUS) {
  f.calls = [];
  f.listeners = { changed: [], channel: [], links: [] };
  f.statusAnswer = answer;
  f.linksAnswer = null;
  f.browsersAnswer = async () => [];
  f.reconnectAnswer = async () => [];
  f.selectAnswer = async () => [];
}

test('Browser settings: one row per harness with its Chrome path, why, and the fixes', async () => {
  reset();
  const m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
  try {
    assert.equal(m.host.querySelector('section')?.getAttribute('data-group'), 'Agent control by harness');
    assert.equal(m.host.querySelector('section')?.getAttribute('data-desc'), 'How each harness controls your Chrome on this Mac.');
    assert.deepEqual(m.rows(), [
      [
        'Codex · Chrome',
        'Unavailable',
        'status-pill native-status unavailable',
        'This feature needs attention. Open its settings to check.',
        ['Install ChatGPT for Chrome', 'Use Your Chrome'],
      ],
      ['Claude Code · Chrome', 'Native (Claude in Chrome)', 'status-pill native-status ok', '', []],
      ['Other harnesses · Chrome', 'Your Chrome', 'status-pill native-status ok', '', []],
    ]);
    // the settings page asks main to look again when it opens, and reads Claude in Chrome's live links
    assert.deepEqual(f.calls, [
      ['status', true],
      ['chromeLinks', true],
    ]);
    f.calls = [];
    await m.click(m.button('Install ChatGPT for Chrome'));
    assert.deepEqual(f.calls, [['openExternal', 'https://store/openai']]);
    f.calls = [];
    await m.click(m.button('Use Your Chrome'));
    // the setting changes once main has switched
    assert.deepEqual(f.calls, [
      ['configure', { channel: 'chrome', profileDir: 'Profile 1' }],
      ['setPrefs', { browserChannel: 'chrome' }],
      ['navigate', { name: 'settings', section: 'browser' }],
    ]);
    // a switch main refused keeps the setting and the page, and says why
    const configure = f.native.browser.configure;
    f.native.browser.configure = async (c: any) => {
      f.calls.push(['configure', c]);
      throw new Error('extension missing');
    };
    try {
      f.calls = [];
      await m.click(m.button('Use Your Chrome'));
      assert.deepEqual(f.calls, [
        ['configure', { channel: 'chrome', profileDir: 'Profile 1' }],
        ['toast', "Couldn't switch to Your Chrome: extension missing", 'error'],
      ]);
    } finally {
      f.native.browser.configure = configure;
    }
  } finally {
    await m.close();
  }
});

test('Computer use settings: the Computer path per harness, a fallback marked as such, and its fixes', async () => {
  reset();
  const m = await mount(createElement(NativeControlStatus, { surface: 'computer' }));
  try {
    assert.equal(m.host.querySelector('section')?.getAttribute('data-desc'), 'How each harness controls your computer on this Mac.');
    assert.deepEqual(
      m.rows().map((r) => r.slice(0, 3)),
      [
        ['Codex · Computer', 'Fallback (MoPilot computer use)', 'status-pill native-status fallback'],
        ['Claude Code · Computer', 'Unavailable', 'status-pill native-status unavailable'],
        ['Other harnesses · Computer', 'MoPilot computer use', 'status-pill native-status ok'],
      ],
    );
    f.calls = [];
    await m.click(m.button('Try again'));
    await m.click(m.button('Computer use settings'));
    assert.deepEqual(f.calls, [['retry'], ['navigate', { name: 'settings', section: 'computer' }]]);
    // nothing on the page sends the user to another vendor app
    assert.doesNotMatch(m.host.textContent ?? '', /Open ChatGPT|ChatGPT app|Claude desktop/);
  } finally {
    await m.close();
  }
});

test("Computer use settings: MoPilot computer use's own fixes open its permission pane or check the helper again; off macOS it says computer", async () => {
  const rows = {
    ...STATUS,
    platform: 'win32',
    harnesses: [
      {
        ...STATUS.harnesses[1],
        computer: surface('permissions', 'Needs permission', 'MoPilot Computer Use needs Screen Recording.', [
          { kind: 'computerPermission', label: 'Open System Settings', permission: 'screenRecording' },
        ]),
      },
      {
        ...STATUS.harnesses[2],
        computer: surface('unavailable', "Couldn't start", "MoPilot Computer Use couldn't start: x", [
          { kind: 'computerCheck', label: 'Try again' },
        ]),
      },
    ],
  };
  reset(async () => rows);
  const m = await mount(createElement(NativeControlStatus, { surface: 'computer' }));
  try {
    assert.equal(m.host.querySelector('section')?.getAttribute('data-desc'), 'How each harness controls your computer on this computer.');
    f.calls = [];
    f.computerReads = 0;
    await m.click(m.button('Open System Settings'));
    await m.click(m.button('Try again'));
    assert.deepEqual(f.calls, [['computerOpenSettings', 'screenRecording']]);
    assert.equal(f.computerReads, 1);
    // a pane the helper didn't open, or a request that failed, says so
    const computer = f.native.computer;
    const real = { openSettings: computer.openSettings, status: computer.status };
    try {
      computer.openSettings = async () => false;
      f.calls = [];
      await m.click(m.button('Open System Settings'));
      computer.openSettings = async () => {
        throw new Error('helper gone');
      };
      await m.click(m.button('Open System Settings'));
      computer.status = async () => {
        throw new Error('helper gone');
      };
      await m.click(m.button('Try again'));
      assert.deepEqual(f.calls, [
        ['toast', "Couldn't open System Settings: the computer use helper did not open it", 'error'],
        ['toast', "Couldn't open System Settings: helper gone", 'error'],
        ['toast', "Couldn't check computer use again: helper gone", 'error'],
      ]);
    } finally {
      Object.assign(computer, real);
    }
  } finally {
    await m.close();
  }
});

test('the status renders nothing until main answers, and reloads on a change, a channel switch and focus', async () => {
  let resolve!: (v: any) => void;
  reset(() => new Promise((r) => (resolve = r)));
  const m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
  try {
    assert.equal(m.host.querySelector('section'), null);
    await act(async () => {
      resolve(STATUS);
      await Promise.resolve();
    });
    await flush();
    assert.ok(m.host.querySelector('section'));
    f.calls = [];
    f.statusAnswer = async () => ({ ...STATUS, harnesses: STATUS.harnesses.slice(2) });
    await act(async () => {
      f.listeners.changed[0]();
      f.listeners.channel[0]();
      window.dispatchEvent(new window.Event('focus'));
    });
    await flush();
    assert.deepEqual(f.calls, [
      ['status', false],
      ['status', false],
      ['status', false],
    ]);
    assert.deepEqual(
      m.rows().map((r) => r[0]),
      ['Other harnesses · Chrome'],
    );
  } finally {
    await m.close();
  }
  // unmounting stops listening
  assert.deepEqual(f.calls.slice(-3).sort(), [['offChanged'], ['offChannel'], ['offLinks']].sort());
});

test('the hook ignores a failed answer and one that arrives after unmount', async () => {
  reset(async () => {
    throw new Error('ipc gone');
  });
  const seen: any[] = [];
  const Probe = () => {
    seen.push(useNativeAvailability());
    return null;
  };
  const m = await mount(createElement(Probe));
  assert.deepEqual(seen.filter(Boolean), []);
  await m.close();
  let resolve!: (v: any) => void;
  reset(() => new Promise((r) => (resolve = r)));
  const late = await mount(createElement(Probe));
  await late.close();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    await act(async () => {
      resolve(STATUS);
      await Promise.resolve();
    });
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(seen.filter(Boolean), []);
});

test("claudeRunsClaudeInChrome reads Claude Code's Chrome surface from the shared status", () => {
  assert.equal(claudeRunsClaudeInChrome(STATUS as any), true);
  assert.equal(claudeRunsClaudeInChrome({ ...STATUS, harnesses: STATUS.harnesses.slice(0, 1) } as any), false);
  assert.equal(claudeRunsClaudeInChrome(null), false);
  const fallback = { ...STATUS, harnesses: [{ ...STATUS.harnesses[1], chrome: surface('fallback', 'Fallback (Your Chrome)') }] };
  assert.equal(claudeRunsClaudeInChrome(fallback as any), false);
});

/* ---------------------------------------- the status on the Computer use page */

const computerStatus = (enabled: boolean) => ({
  enabled,
  permissions: { accessibility: true, screenRecording: true, inputMonitoring: true },
  helper: { running: true, version: '1.0', error: null },
  grants: { global: [], chats: [] },
  deny: { builtIn: [], user: [] },
});

test('Computer use settings show the harness status whether MoPilot computer use is on or not', async () => {
  for (const enabled of [false, true]) {
    reset();
    f.computer = computerStatus(enabled);
    const m = await mount(createElement(ComputerUseSettings));
    try {
      assert.equal(m.host.querySelector('section[data-group="Agent control by harness"]') !== null, true, `enabled ${enabled}`);
      assert.equal(m.host.textContent?.includes('Computer use is unavailable.'), !enabled);
      assert.deepEqual(
        m
          .rows()
          .filter((r) => / · Computer$/.test(r[0]))
          .map((r) => r[0]),
        ['Codex · Computer', 'Claude Code · Computer', 'Other harnesses · Computer'],
      );
    } finally {
      await m.close();
    }
  }
});

test('Computer use settings list the always-allowed apps with Remove each and Remove all', async () => {
  reset();
  f.computer = {
    ...computerStatus(true),
    grants: {
      global: [
        { bundleId: 'com.apple.TextEdit', name: 'TextEdit', level: 'full', at: 1 },
        { bundleId: 'com.apple.Safari', name: 'Safari', level: 'view', at: 2 },
        { bundleId: 'com.apple.Terminal', name: 'Terminal', level: 'click', at: 3 },
      ],
      chats: [],
    },
  };
  const m = await mount(createElement(ComputerUseSettings));
  try {
    const group = () => m.host.querySelector('section[data-group="Always allowed"]') as any;
    assert.equal(group().getAttribute('data-desc'), 'Every chat can use these without asking.');
    const listed = () =>
      [...group().querySelectorAll('.row')].map((r: any) => [
        r.getAttribute('data-title'),
        r.querySelector('.desc').textContent,
        [...r.querySelectorAll('button')].map((b: any) => b.getAttribute('aria-label')),
      ]);
    assert.deepEqual(listed(), [
      ['TextEdit', 'Full control', ['Remove TextEdit']],
      ['Safari', 'View only', ['Remove Safari']],
      ['Terminal', 'Click', ['Remove Terminal']],
    ]);
    // Remove one: the list reloads without it
    await m.click(group().querySelector('button[aria-label="Remove Safari"]'));
    assert.deepEqual(
      f.calls.filter((c: any[]) => c[0] === 'revoke'),
      [['revoke', null, 'com.apple.Safari']],
    );
    assert.deepEqual(
      listed().map((r) => r[0]),
      ['TextEdit', 'Terminal'],
    );
    // Remove all
    await m.click(m.button('Remove all'));
    assert.deepEqual(
      f.calls.filter((c: any[]) => c[0] === 'revokeAll'),
      [['revokeAll']],
    );
    assert.deepEqual(
      listed().map((r) => r[0]),
      ['No apps yet'],
    );
    assert.equal(m.button('Remove all'), undefined, 'nothing left to remove');
  } finally {
    await m.close();
  }
});

/* ---------------------------------------- Claude in Chrome's live link (BU-07) */

const linkOf = (connected: boolean, browser: string | null = null) => ({
  connected,
  browser,
  installed: true,
  dropped: false,
  reconnectUrl: 'https://r',
  permissionsUrl: 'https://p',
});
const claudeRow = (m: any) => m.rows().find((r: any) => r[0] === 'Claude Code · Chrome');
const pick = async (select: any, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await flush();
};

test('the summary of the live links: connected where, and down in how many chats', () => {
  assert.equal(chromeLinkSummary(null), null);
  assert.equal(chromeLinkSummary([{ key: 'k', chatId: 'c', link: null }]), null);
  assert.deepEqual(chromeLinkSummary([{ key: 'k', chatId: 'c', link: linkOf(true, 'Chrome') }]), {
    connected: 1,
    down: 0,
    browser: 'Chrome',
    text: 'Connected to Chrome in 1 chat.',
  });
  assert.deepEqual(
    chromeLinkSummary([
      { key: 'a', chatId: 'a', link: linkOf(true) },
      { key: 'b', chatId: 'b', link: linkOf(true) },
      { key: 'c', chatId: 'c', link: linkOf(false) },
    ]),
    {
      connected: 2,
      down: 1,
      browser: null,
      text: 'Connected in 2 chats. Disconnected in 1 chat.',
    },
  );
  assert.equal(
    chromeLinkSummary([
      { key: 'a', chatId: 'a', link: linkOf(false) },
      { key: 'b', chatId: 'b', link: linkOf(false) },
    ])!.text,
    'Disconnected in 2 chats.',
  );
});

test('the Claude Code row: connected, the browser picker for two paired browsers, and a switch', async () => {
  reset();
  f.linksAnswer = async () => [{ key: 'k', chatId: 'c', link: linkOf(true, 'Chrome') }];
  f.browsersAnswer = async () => [
    { id: 'b1', name: 'Chrome', current: true },
    { id: 'b2', name: 'Arc', current: false },
  ];
  f.selectAnswer = async () => [{ chatId: 'c', link: linkOf(true, 'Arc'), error: null }];
  const m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
  try {
    assert.deepEqual(claudeRow(m).slice(1, 5), [
      'Native (Claude in Chrome)',
      'status-pill native-status ok',
      'Connected to Chrome in 1 chat.',
      [],
    ]);
    const select = m.host.querySelector('select[aria-label="Select browser"]') as any;
    assert.deepEqual(
      [...select.querySelectorAll('option')].map((o: any) => [o.value, o.textContent]),
      [
        ['b1', 'Chrome'],
        ['b2', 'Arc'],
      ],
    );
    assert.equal(select.value, 'b1');
    f.calls = [];
    await pick(select, 'b2');
    assert.deepEqual(f.calls, [['chromeSelect', 'b2']]);
    // a switch that failed in a chat says so
    f.selectAnswer = async () => [{ chatId: 'c', link: linkOf(true, 'Chrome'), error: 'not paired' }];
    f.calls = [];
    await pick(select, 'b2');
    assert.deepEqual(f.calls, [
      ['chromeSelect', 'b2'],
      ['toast', "Couldn't switch browsers: not paired", 'error'],
    ]);
    // a chat mid-turn switches when its turn ends (CM-Y03b)
    f.selectAnswer = async () => [{ chatId: 'c', link: linkOf(true, 'Chrome'), error: null, deferred: true }];
    f.calls = [];
    await pick(select, 'b2');
    assert.deepEqual(f.calls.at(-1), ['toast', 'A chat that is working switches when the turn ends.', 'info']);
    f.selectAnswer = async () => [
      { chatId: 'c', link: linkOf(true, 'Chrome'), error: null, deferred: true },
      { chatId: 'd', link: linkOf(true, 'Chrome'), error: null, deferred: true },
    ];
    f.calls = [];
    await pick(select, 'b2');
    assert.deepEqual(f.calls.at(-1), ['toast', '2 chats that are working switch when the turn ends.', 'info']);
    // main says a link changed: read again
    f.linksAnswer = async () => [{ key: 'k', chatId: 'c', link: linkOf(true) }];
    f.browsersAnswer = async () => [
      { id: 'b1', name: 'Chrome', current: false },
      { id: 'b2', name: 'Arc', current: false },
    ];
    f.calls = [];
    await act(async () => f.listeners.links[0]());
    await flush();
    assert.deepEqual(f.calls[0], ['chromeLinks', false]);
    assert.equal(claudeRow(m)[3], 'Connected in 1 chat.');
    const again = m.host.querySelector('select[aria-label="Select browser"]') as any;
    assert.deepEqual(
      [...again.querySelectorAll('option')].map((o: any) => o.value),
      ['', 'b1', 'b2'],
    );
  } finally {
    await m.close();
  }
});

test('the Claude Code row: Reconnect for chats whose link is down, and what a failure says', async () => {
  reset();
  f.linksAnswer = async () => [
    { key: 'k', chatId: 'c', link: linkOf(false) },
    { key: 'n', chatId: 'n', link: null },
  ];
  let finish!: (v: any) => void;
  f.reconnectAnswer = () => new Promise((r) => (finish = r));
  const m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
  try {
    assert.deepEqual(claudeRow(m).slice(3), ['Disconnected in 1 chat.', ['Reconnect']]);
    assert.equal(m.host.querySelector('select'), null);
    assert.equal(
      f.calls.some((c: any) => c[0] === 'chromeBrowsers'),
      false,
    );
    f.calls = [];
    await m.click(m.button('Reconnect'));
    assert.equal(m.button('Reconnecting…').disabled, true);
    await act(async () => finish([{ chatId: 'c', link: linkOf(true), error: null }]));
    await flush();
    assert.deepEqual(f.calls, [['chromeReconnect', null]]);
    f.reconnectAnswer = async () => [{ chatId: 'c', link: linkOf(false), error: 'socket closed' }];
    f.calls = [];
    await m.click(m.button('Reconnect'));
    assert.deepEqual(f.calls, [
      ['chromeReconnect', null],
      ['toast', "Couldn't reconnect Claude in Chrome: socket closed", 'error'],
    ]);
    f.reconnectAnswer = async () => {
      throw new Error('ipc gone');
    };
    f.calls = [];
    await m.click(m.button('Reconnect'));
    assert.deepEqual(f.calls, [
      ['chromeReconnect', null],
      ['toast', "Couldn't reconnect Claude in Chrome: ipc gone", 'error'],
    ]);
    f.reconnectAnswer = () => Promise.reject(null);
    f.calls = [];
    await m.click(m.button('Reconnect'));
    assert.deepEqual(f.calls.at(-1), ['toast', "Couldn't reconnect Claude in Chrome: null", 'error']);
  } finally {
    await m.close();
  }
});

test('the Claude Code row: shown only on the native path; one paired browser shows no picker; a late or failed list is ignored', async () => {
  // Claude in Chrome not native: the link is not shown even when one is read
  reset(async () => ({
    ...STATUS,
    harnesses: [{ ...STATUS.harnesses[1], chrome: surface('fallback', 'Fallback (Your Chrome)', 'Needs a login.') }],
  }));
  f.linksAnswer = async () => [{ key: 'k', chatId: 'c', link: linkOf(false) }];
  let m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
  try {
    assert.deepEqual(claudeRow(m).slice(3), ['This feature needs attention. Open its settings to check.', []]);
  } finally {
    await m.close();
  }
  reset();
  f.linksAnswer = async () => [{ key: 'k', chatId: 'c', link: linkOf(true) }];
  f.browsersAnswer = async () => [{ id: 'b1', name: 'Chrome', current: true }];
  m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
  try {
    assert.equal(m.host.querySelector('select'), null);
  } finally {
    await m.close();
  }
  reset();
  f.linksAnswer = async () => [{ key: 'k', chatId: 'c', link: linkOf(true) }];
  f.browsersAnswer = async () => {
    throw new Error('not connected');
  };
  m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
  try {
    assert.equal(m.host.querySelector('select'), null);
  } finally {
    await m.close();
  }
  reset();
  f.linksAnswer = async () => [{ key: 'k', chatId: 'c', link: linkOf(true) }];
  let late!: (v: any) => void;
  f.browsersAnswer = () => new Promise((r) => (late = r));
  m = await mount(createElement(NativeControlStatus, { surface: 'chrome' }));
  await m.close();
  await act(async () => late([{ id: 'b1', name: 'a', current: true }]));
});

test('the live-link hook: nothing while off; a failed or late answer is ignored', async () => {
  reset();
  const seen: any[] = [];
  const Probe = ({ on }: { on: boolean }) => {
    seen.push(useChromeLinks(on));
    return null;
  };
  let m = await mount(createElement(Probe, { on: false }));
  await m.close();
  assert.deepEqual(f.calls, []);
  f.linksAnswer = async () => {
    throw new Error('ipc gone');
  };
  m = await mount(createElement(Probe, { on: true }));
  await m.close();
  let resolve!: (v: any) => void;
  f.linksAnswer = () => new Promise((r) => (resolve = r));
  m = await mount(createElement(Probe, { on: true }));
  await m.close();
  await act(async () => resolve([{ key: 'k', chatId: 'c', link: null }]));
  assert.deepEqual(seen.filter(Boolean), []);
});

registerPresentationUI({ f, reset, STATUS, surface, mount, NativeControlStatus, ComputerUseSettings, computerStatus });
