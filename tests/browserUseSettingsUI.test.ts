// UI for Codex Browser Use settings and the unified Sites table (BU-06, src/components/pages/settings/
// BrowserUse.tsx, src/lib/browserSites.ts): Codex's preferences with managed values read only, the per-site
// rules of Codex Browser Use and MoPilot's two browser tables (the built-in browser's and Your Chrome's) in one
// table, adding and removing sites, and the link
// to Claude in Chrome's own site permissions. The component and its libraries are real; app services are
// fixture stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  ADD_CHOICES,
  addTarget,
  CLAUDE_CHROME_PERMISSIONS,
  f,
  flush,
  mount,
  policyRows,
  reset,
  siteOrigin,
  siteRows,
  view,
  window,
} from './support/browser-use-settings-kit.ts';

test('the Sites lib: one row per site of either route, policies read only, and typed sites as origins', () => {
  assert.deepEqual(siteRows(null, null), []);
  assert.deepEqual(
    siteRows(view() as any, {
      iab: [
        { origin: 'https://a.test', level: 'write' },
        { origin: 'https://0.test', level: 'read' },
      ],
      chrome: [{ origin: 'https://a.test', level: 'read' }],
    }),
    [
      {
        origin: 'https://0.test',
        codex: { browse: null, downloads: null, uploads: null, debug: null },
        mopilot: { iab: 'read', chrome: null },
      },
      {
        origin: 'https://a.test',
        codex: { browse: 'allow', downloads: null, uploads: 'deny', debug: null },
        mopilot: { iab: 'write', chrome: 'read' },
      },
    ],
  );
  assert.deepEqual(policyRows(null), []);
  assert.deepEqual(
    policyRows({
      policies: [
        { pattern: '*', source: 'managed', browse: 'deny', downloads: null, uploads: null, debug: null },
        { pattern: 'https://x.test', source: 'config', browse: null, downloads: 'allow', uploads: null, debug: null },
      ],
    } as any),
    [
      { label: 'All sites (default)', source: 'Managed', codex: { browse: 'deny', downloads: null, uploads: null, debug: null } },
      { label: 'https://x.test', source: 'config.toml', codex: { browse: null, downloads: 'allow', uploads: null, debug: null } },
    ],
  );
  assert.equal(siteOrigin(' example.com/path '), 'https://example.com');
  assert.equal(siteOrigin('http://a.test:3000'), 'http://a.test:3000');
  assert.equal(siteOrigin('ftp://a.test'), null);
  assert.equal(siteOrigin('http://'), null);
  assert.equal(siteOrigin('  '), null);
  assert.deepEqual(
    ADD_CHOICES.map((c: any) => addTarget(c.value)),
    [
      { codex: 'allow' },
      { codex: 'deny' },
      { mopilot: 'read', browser: 'iab' },
      { mopilot: 'write', browser: 'iab' },
      { mopilot: 'read', browser: 'chrome' },
      { mopilot: 'write', browser: 'chrome' },
    ],
  );
});

test('Codex preferences: each with its choices, saved through main', async () => {
  reset();
  const m = await mount();
  try {
    assert.deepEqual(f.calls.slice(0, 3), [['state'], ['sites', 'iab'], ['sites', 'chrome']]);
    const group = m.q('section[data-group="Codex Browser Use"]');
    assert.equal(group.getAttribute('data-desc'), "When Codex's Browser plugin asks first.");
    assert.deepEqual(
      m.rows().map((r) => r[0]),
      ['Site access', 'Downloads and uploads', 'Browsing history', 'Full CDP access'],
    );
    assert.equal(m.rows()[3][1], 'Reads and changes cookies, storage and network traffic.');
    const prefs = [...m.host.querySelectorAll('select.pref')] as any[];
    assert.deepEqual(
      prefs.slice(0, 4).map((s) => [s.value, [...s.options].map((o: any) => o.textContent)]),
      [
        ['always_ask', ['Always ask', 'Auto-approve']],
        ['never_ask', ['Downloads: Always ask', 'Downloads: Auto-approve']],
        ['always_ask', ['Uploads: Always ask', 'Uploads: Auto-approve']],
        ['always_ask', ['Always ask', 'Auto-approve', 'Never allow']],
      ],
    );
    f.calls = [];
    await m.pick(prefs[0], 'never_ask');
    await m.pick(prefs[3], 'disabled');
    // full CDP asks once more before it turns on; declined, nothing is saved
    const asked: string[] = [];
    let answer = false;
    (window as any).confirm = (q: string) => (asked.push(q), answer);
    await m.click(m.q('input.toggle'));
    answer = true;
    await m.click(m.q('input.toggle'));
    assert.equal(asked.length, 2);
    assert.equal(asked[0], 'Allow Codex full DevTools access on sites you allow?');
    assert.deepEqual(f.calls, [
      ['setPreference', 'approvalMode', 'never_ask'],
      ['setPreference', 'historyMode', 'disabled'],
      ['setPreference', 'fullCdp', true],
    ]);
    // a refused change says why
    f.changeAnswer = async () => {
      throw new Error('Your organization requires Codex to ask each time.');
    };
    f.calls = [];
    await m.pick(prefs[1], 'always_ask');
    assert.deepEqual(f.calls.at(-1), [
      'toast',
      "Couldn't save the Codex browser setting: Your organization requires Codex to ask each time.",
      'error',
    ]);
    f.changeAnswer = () => Promise.reject('plain');
    await m.pick(prefs[2], 'never_ask');
    assert.deepEqual(f.calls.at(-1), ['toast', "Couldn't save the Codex browser setting: plain", 'error']);
  } finally {
    await m.close();
  }
});

test('turning full CDP access off asks nothing', async () => {
  reset(view({ prefs: { ...view().prefs, fullCdp: { value: true, options: [true, false], locked: null } } }));
  const asked: string[] = [];
  (window as any).confirm = (q: string) => (asked.push(q), true);
  const m = await mount();
  try {
    f.calls = [];
    await m.click(m.q('input.toggle'));
    assert.deepEqual(f.calls, [['setPreference', 'fullCdp', false]]);
    assert.deepEqual(asked, []);
  } finally {
    await m.close();
  }
});

test('Codex preferences fixed by policy show read only, with why', async () => {
  const locked = 'Your organization requires Codex to ask each time.';
  reset(
    view({
      requirementsKnown: false,
      prefs: {
        approvalMode: { value: 'always_ask', options: ['always_ask'], locked },
        historyMode: {
          value: 'disabled',
          options: ['always_ask', 'disabled'],
          locked: 'Your organization turned off browsing history access.',
        },
        downloadMode: { value: 'always_ask', options: ['always_ask'], locked },
        uploadMode: { value: 'always_ask', options: ['always_ask'], locked },
        fullCdp: { value: false, options: [true, false], locked: 'Your organization turned off full CDP access.' },
      },
    }),
  );
  const m = await mount();
  try {
    assert.match(m.q('section[data-group="Codex Browser Use"]').getAttribute('data-desc'), /its organization policy may be out of date\.$/);
    assert.deepEqual(
      [...m.host.querySelectorAll('.row .status-pill')].map((p: any) => [p.textContent, p.getAttribute('title')]),
      [
        ['Always ask (managed)', locked],
        ['Downloads: Always ask (managed)', locked],
        ['Uploads: Always ask (managed)', locked],
        ['Never allow (managed)', 'Your organization turned off browsing history access.'],
      ],
    );
    assert.deepEqual(
      m
        .rows()
        .slice(2)
        .map((r) => r[1]),
      ['Your organization turned off browsing history access.', 'Your organization turned off full CDP access.'],
    );
    assert.equal(m.q('input.toggle').disabled, true);
  } finally {
    await m.close();
  }
});

test('a file that cannot be read, or browser use turned off, replaces the preferences and locks Codex columns', async () => {
  for (const [state, title, desc] of [
    [
      { file: 'browser/config.toml', error: "browser/config.toml isn't valid TOML" },
      "Couldn't read browser/config.toml",
      "browser/config.toml isn't valid TOML",
    ],
    [
      view({ disabled: 'Your organization turned off browser use for Codex.' }),
      'Browser use is off for Codex',
      'Your organization turned off browser use for Codex.',
    ],
  ] as const) {
    reset(state);
    const m = await mount();
    try {
      assert.deepEqual(m.rows(), [[title, desc]]);
      const codexSelects = [...m.host.querySelectorAll('select.sites-select')].filter((s: any) =>
        s.getAttribute('aria-label').startsWith('Codex'),
      );
      assert.ok(codexSelects.every((s: any) => s.disabled));
      // only MoPilot's own browser tables can be added to
      assert.deepEqual(
        [...m.q('.sites-add select').options].map((o: any) => o.value),
        ['iab:read', 'iab:write', 'chrome:read', 'chrome:write'],
      );
    } finally {
      await m.close();
    }
  }
  // a state call that fails reads as an unreadable file
  reset();
  f.stateAnswer = async () => {
    throw new Error('ipc gone');
  };
  const m = await mount();
  try {
    assert.deepEqual(m.rows(), [["Couldn't read browser/config.toml", 'ipc gone']]);
  } finally {
    await m.close();
  }
});

test('the Sites table: a row per site with a column per route, policies first, and edits per cell', async () => {
  reset(view({ policies: [{ pattern: '*', source: 'managed', browse: 'deny', downloads: null, uploads: null, debug: 'allow' }] }));
  f.chromeGrants = [{ origin: 'https://c.test', level: 'write' }];
  const m = await mount();
  try {
    assert.deepEqual(
      [...m.q('.sites-head').querySelectorAll('[role="columnheader"]')].map((h: any) => h.textContent),
      ['Site', 'Codex · Browse', 'Codex · Downloads', 'Codex · Uploads', 'Codex · Debug (CDP)', 'Built-in browser', 'Your Chrome', ''],
    );
    assert.match(m.q('section[data-group="Sites"]').getAttribute('data-desc'), /keep separate permissions/);
    assert.deepEqual(m.sites(), [
      // a Codex block is a block for MoPilot's browser tools too, in every chat (#1319 G13)
      ['All sites (default) Managed', 'Block', '—', '—', 'Allow', 'Blocked (Codex)', 'Blocked (Codex)', ''],
      ['https://a.test', 'allow', 'ask', 'deny', 'ask', 'ask', 'ask', 'Remove'],
      ['https://b.test', 'ask', 'ask', 'ask', 'ask', 'read', 'ask', 'Remove'],
      ['https://c.test', 'ask', 'ask', 'ask', 'ask', 'ask', 'write', 'Remove'],
    ]);
    f.calls = [];
    await m.pick(m.q('select[aria-label="Codex Browse for https://a.test"]'), 'deny');
    await m.pick(m.q('select[aria-label="Codex Debug (CDP) for https://b.test"]'), 'allow');
    await m.pick(m.q('select[aria-label="Codex Uploads for https://a.test"]'), '');
    await m.pick(m.q('select[aria-label="Built-in browser for https://b.test"]'), 'write');
    await m.pick(m.q('select[aria-label="Built-in browser for https://a.test"]'), 'read');
    await m.pick(m.q('select[aria-label="Built-in browser for https://b.test"]'), '');
    assert.deepEqual(f.chromeGrants, [{ origin: 'https://c.test', level: 'write' }]);
    await m.pick(m.q('select[aria-label="Your Chrome for https://c.test"]'), 'read');
    assert.deepEqual(f.calls, [
      ['setRule', 'browse', 'https://a.test', 'deny'],
      ['setRule', 'debug', 'https://b.test', 'allow'],
      ['setRule', 'uploads', 'https://a.test', null],
      ['setSite', 'https://b.test', 'write', 'iab'],
      ['setSite', 'https://a.test', 'read', 'iab'],
      ['setSite', 'https://b.test', null, 'iab'],
      ['setSite', 'https://c.test', 'read', 'chrome'],
    ]);
    assert.deepEqual(f.chromeGrants, [{ origin: 'https://c.test', level: 'read' }]);
    assert.deepEqual(f.grants, [{ origin: 'https://a.test', level: 'read' }]);
    // a MoPilot grant that can't be saved says so
    f.setSiteFails = true;
    f.calls = [];
    await m.pick(m.q('select[aria-label="Built-in browser for https://a.test"]'), 'write');
    assert.deepEqual(f.calls.at(-1), ['toast', "Couldn't save the site permission. Please try again.", 'error']);
  } finally {
    await m.close();
  }
});

test('a site Codex blocks shows blocked in both browsers, in place of their permission (#1319 G13)', async () => {
  reset(
    view({
      sites: [{ origin: 'https://a.test', browse: 'deny', downloads: null, uploads: null, debug: null }],
      policies: [{ pattern: 'https://ok.test', source: 'config', browse: 'allow', downloads: null, uploads: null, debug: null }],
    }),
  );
  f.grants = [{ origin: 'https://a.test', level: 'write' }];
  const m = await mount();
  try {
    // the group's line says the two browsers keep separate permissions; the rows show the block in both
    assert.match(m.q('section[data-group="Sites"]').getAttribute('data-desc'), /keep separate permissions\.$/);
    assert.deepEqual(m.sites(), [
      ['https://ok.test config.toml', 'Allow', '—', '—', '—', '—', '—', ''],
      ['https://a.test', 'deny', 'ask', 'ask', 'ask', 'Blocked (Codex)', 'Blocked (Codex)', 'Remove'],
    ]);
    assert.equal(m.q('select[aria-label="Built-in browser for https://a.test"]'), null);
  } finally {
    await m.close();
  }
});

test('Remove forgets a site on every route that has it', async () => {
  reset();
  f.grants = [
    { origin: 'https://a.test', level: 'write' },
    { origin: 'https://b.test', level: 'read' },
  ];
  f.chromeGrants = [{ origin: 'https://a.test', level: 'read' }];
  const m = await mount();
  try {
    f.calls = [];
    await m.click(m.q('button[aria-label="Remove https://a.test"]'));
    await m.click(m.q('button[aria-label="Remove https://b.test"]'));
    assert.deepEqual(f.calls, [
      ['forget', 'https://a.test'],
      ['setSite', 'https://a.test', null, 'iab'],
      ['setSite', 'https://a.test', null, 'chrome'],
      ['setSite', 'https://b.test', null, 'iab'],
    ]);
  } finally {
    await m.close();
  }
  // a site only Codex has
  reset();
  f.grants = [];
  const c = await mount();
  try {
    f.calls = [];
    await c.click(c.q('button[aria-label="Remove https://a.test"]'));
    assert.deepEqual(f.calls, [['forget', 'https://a.test']]);
  } finally {
    await c.close();
  }
});

test('adding a site: a Codex rule or a MoPilot grant, checked as an address first', async () => {
  reset(view({ sites: [] }));
  f.grants = [];
  const m = await mount();
  try {
    assert.equal(m.q('.sites-empty').textContent, 'No saved sites yet.');
    const input = m.q('input[aria-label="Site to add"]');
    const submit = () => act(async () => m.q('.sites-add').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(m.button('Add').disabled, true);
    const type = async (v: string) => {
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, v);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    };
    await type('ftp://nope');
    f.calls = [];
    await submit();
    await flush();
    assert.deepEqual(f.calls, [['toast', 'Enter a site address, such as example.com', 'error']]);
    await type('example.com');
    f.calls = [];
    await submit();
    await flush();
    assert.deepEqual(f.calls, [['setRule', 'browse', 'https://example.com', 'allow']]);
    assert.equal(input.value, '');
    for (const [choice, call] of [
      ['plugin:deny', ['setRule', 'browse', 'https://x.test', 'deny']],
      ['iab:write', ['setSite', 'https://x.test', 'write', 'iab']],
      ['chrome:read', ['setSite', 'https://x.test', 'read', 'chrome']],
    ] as const) {
      await m.pick(m.q('.sites-add select'), choice);
      await type('x.test');
      f.calls = [];
      await submit();
      await flush();
      assert.deepEqual(f.calls[0], call);
    }
  } finally {
    await m.close();
  }
  // a Codex choice that no longer applies (Codex unreadable) falls back to the first one left
  reset(view({ sites: [] }));
  f.grants = [];
  let s: any = view({ sites: [] });
  f.stateAnswer = async () => s;
  const c = await mount();
  try {
    await c.pick(c.q('.sites-add select'), 'plugin:deny');
    s = { file: 'browser/config.toml', error: 'gone' };
    f.changeAnswer = async () => s;
    // any Codex change brings the new state
    await c.pick(c.q('select.pref'), 'never_ask');
    assert.equal(c.q('.sites-add select').value, 'iab:read');
    const input = c.q('input[aria-label="Site to add"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'y.test');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    f.calls = [];
    await act(async () => c.q('.sites-add').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.deepEqual(f.calls[0], ['setSite', 'https://y.test', 'read', 'iab']);
  } finally {
    await c.close();
  }
});

test("Claude in Chrome: the table links to the extension's own site permissions", async () => {
  reset();
  const m = await mount();
  try {
    f.calls = [];
    await m.click(m.button('Manage in Chrome'));
    assert.deepEqual(f.calls, [['openLink', CLAUDE_CHROME_PERMISSIONS]]);
  } finally {
    await m.close();
  }
  reset();
  f.links = [
    { key: 'k', chatId: 'c', link: null },
    { key: 'l', chatId: 'd', link: { connected: true, permissionsUrl: 'https://clau.de/chrome/permissions?x' } },
  ];
  const live = await mount();
  try {
    f.calls = [];
    await live.click(live.button('Manage in Chrome'));
    assert.deepEqual(f.calls, [['openLink', 'https://clau.de/chrome/permissions?x']]);
  } finally {
    await live.close();
  }
});

test('answers that arrive after the page closed are ignored', async () => {
  reset();
  let state!: (v: any) => void;
  let fail!: (e: any) => void;
  let sites!: (v: any) => void;
  f.stateAnswer = () => new Promise((r) => (state = r));
  f.native.browser.sites = () => new Promise((r) => (sites = r));
  const m = await mount();
  await m.close();
  await act(async () => {
    state(view());
    sites([]);
  });
  f.stateAnswer = () => new Promise((_, rej) => (fail = rej));
  const n = await mount();
  await n.close();
  await act(async () => fail(new Error('late')));
});

test('failed site additions retain their address for retry on either browser route', async () => {
  for (const route of ['plugin:allow', 'iab:read']) {
    reset();
    const m = await mount();
    try {
      const input = m.q('input[aria-label="Site to add"]');
      await m.pick(m.q('.sites-add select'), route);
      await act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'retry.test');
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      f.changeAnswer = () => Promise.reject(new Error('disk full'));
      f.setSiteFails = true;
      await act(async () => m.q('.sites-add').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
      await flush();
      assert.equal(input.value, 'retry.test');
      f.changeAnswer = async () => view();
      f.setSiteFails = false;
      await act(async () => m.q('.sites-add').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
      await flush();
      assert.equal(input.value, '');
    } finally {
      await m.close();
    }
  }
});

test('a completed site save does not clear text typed while it was pending', async () => {
  reset();
  const m = await mount();
  let release!: (value: any) => void;
  f.changeAnswer = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const type = (text: string) =>
    act(() => {
      const input = m.q('input[aria-label="Site to add"]');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  try {
    await type('first.test');
    await act(async () => m.q('.sites-add').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await type('next.test');
    await act(async () => release(view()));
    await flush();
    assert.equal(m.q('input[aria-label="Site to add"]').value, 'next.test');
  } finally {
    await m.close();
  }
});

test('site-list load failures are visible and a successful edit recovers the table', async () => {
  reset(view({ sites: [] }));
  f.grants = [];
  f.native.browser.sites = async () => {
    throw new Error('offline');
  };
  const m = await mount();
  try {
    assert.match(m.q('[role="alert"]').textContent, /Couldn.t load MoPilot site permissions: offline/);
    assert.equal(m.q('.sites-empty'), null);
    await m.pick(m.q('.sites-add select'), 'iab:read');
    await act(() => {
      const input = m.q('input[aria-label="Site to add"]');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'recover.test');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => m.q('.sites-add').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.equal(m.q('[role="alert"]'), null);
    assert.ok(m.sites().some((row) => row[0] === 'https://recover.test'));
  } finally {
    await m.close();
  }
});

test('site-list failures arriving after the page closes are handled quietly', async () => {
  reset();
  let reject!: (reason: any) => void;
  f.native.browser.sites = () =>
    new Promise((_, fail) => {
      reject = fail;
    });
  const m = await mount();
  await m.close();
  await act(async () => reject(new Error('late load failure')));
});

test('a successful site edit takes precedence over late initial site-list answers', async () => {
  for (const failed of [false, true]) {
    reset();
    let resolve!: (value: any) => void;
    let reject!: (reason: any) => void;
    f.native.browser.sites = () =>
      new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
    const m = await mount();
    try {
      await m.pick(m.q('.sites-add select'), 'iab:read');
      await act(() => {
        const input = m.q('input[aria-label="Site to add"]');
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'new.test');
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await act(async () => m.q('.sites-add').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
      await flush();
      assert.ok(m.sites().some((row) => row[0] === 'https://new.test'));
      await act(async () => {
        if (failed) reject(new Error('outdated read failed'));
        else resolve([{ origin: 'https://stale.test', level: 'read' }]);
      });
      await flush();
      assert.ok(m.sites().some((row) => row[0] === 'https://new.test'));
      assert.equal(m.q('[role="alert"]'), null);
    } finally {
      await m.close();
    }
  }
});
