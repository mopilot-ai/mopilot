// Vendor browser approval choices, safety checks and tool details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, f, Approvals, mount, flush, approvals, resolved, press, personClick, window } from './fixture';

export function registerBrowserApprovalsCases() {
  /* ------------------------------ Approvals: browser cards (Codex's Browser plugin, Claude in Chrome) ------------------------------ */

  function browserReq(meta: any = {}, params: any = {}) {
    return {
      id: 'br-1',
      method: 'mcpServer/elicitation/request',
      threadId: 'chat',
      params: {
        serverName: 'cua_repl',
        mode: 'form',
        message: 'Allow Chrome to access https://example.com?',
        requestedSchema: { type: 'object', properties: {}, additionalProperties: false },
        ...params,
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          codex_sensitive_action: true,
          connector_id: 'browser-use',
          connector_name: 'Chrome',
          persist: 'always',
          tool_name: 'access_browser_origin',
          tool_params: { origin: 'https://example.com' },
          tool_params_display: [],
          origin: 'https://example.com',
          ...meta,
        },
      },
    };
  }
  const footBtns = (host: any) => [...host.querySelectorAll('.approval-foot button')].map((b: any) => b.textContent);
  const scriptKey = (key: string) =>
    act(async () => {
      const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as any;
      Object.defineProperty(e, 'isTrusted', { value: false });
      window.dispatchEvent(e);
    });

  test('a Codex browser site card puts the host first and offers this chat, this site and all sites', async () => {
    const m = await approvals(browserReq());
    try {
      await flush();
      const card = m.host.querySelector('.approval-card.browser-use')!;
      assert.equal(card.getAttribute('data-kind'), 'origin');
      assert.equal(m.host.querySelector('.approval-kind')?.textContent, 'Browser · Chrome');
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Codex wants to use example.com');
      assert.equal(m.host.querySelector('.approval-message .browser-site')?.textContent, 'example.com');
      // an https site on its default port shows no separate origin line
      assert.equal(m.host.querySelector('.browser-origin') === null, true);
      assert.match(m.host.querySelector('[role="alert"]')!.textContent!, /^ Marked sensitive\. Allow only if you expected it\.$/);
      assert.deepEqual(footBtns(m.host), ['Decline Esc', 'Allow in this chat 1', 'Allow for this site 2', 'Allow for all sites 3']);
      assert.deepEqual(
        f.calls.filter((c: any[]) => c[0] === 'codex'),
        [['codex', 'configRequirementsRead']],
      );
      assert.equal(m.host.querySelector('.form-field') === null, true);
      await press('2');
      assert.deepEqual(resolved(), [['br-1', { action: 'accept', content: {}, _meta: { persist: 'always' } }]]);
    } finally {
      await m.close();
    }
  });

  for (const [how, key, expected] of [
    ['Enter', 'Enter', { action: 'accept', content: {}, _meta: null }],
    ['1', '1', { action: 'accept', content: {}, _meta: null }],
    ['Esc', 'Escape', { action: 'decline', content: null, _meta: null }],
  ] as const) {
    test(`a Codex browser site card answers ${how}`, async () => {
      const m = await approvals(browserReq());
      try {
        await flush();
        await press(key);
        assert.deepEqual(resolved(), [['br-1', expected]]);
      } finally {
        await m.close();
      }
    });
  }

  test('"Allow for all sites" asks once more: Esc or Cancel goes back, "Allow any website" answers with the all-sites scope', async () => {
    const m = await approvals(browserReq());
    try {
      await flush();
      await press('3');
      assert.deepEqual(resolved(), []);
      const confirm = m.host.querySelector('[role="alertdialog"]')!;
      assert.equal(confirm.querySelector('.approval-message')?.textContent, 'Allow Codex to use any website without asking?');
      assert.match(confirm.textContent!, /^Allow Codex to use any website without asking\? Including sites you're signed in to\.$/);
      assert.deepEqual(footBtns(m.host), ['Cancel Esc', 'Allow any website']);
      assert.equal(document.activeElement, m.button('Allow any website'));
      // while it asks, Enter on the window, the number keys and other keys do nothing
      await press('Enter');
      await press('1');
      await press('x');
      assert.deepEqual(resolved(), []);
      await press('Escape');
      assert.equal(m.host.querySelector('[role="alertdialog"]') === null, true);
      assert.deepEqual(resolved(), []);
      await personClick(m.button('Allow for all sites 3'));
      await personClick(m.button('Cancel Esc'));
      assert.equal(m.host.querySelector('[role="alertdialog"]') === null, true);
      await personClick(m.button('Allow for all sites 3'));
      // a script's click on the risk step does nothing
      await act(async () => {
        m.button('Allow any website').click();
      });
      assert.deepEqual(resolved(), []);
      await personClick(m.button('Allow any website'));
      assert.deepEqual(resolved(), [
        ['br-1', { action: 'accept', content: {}, _meta: { persist: 'always', browser_use_persistent_approval_scope: 'all-sites' } }],
      ]);
    } finally {
      await m.close();
    }
  });

  test('the all-sites risk step warns about signed-in sites when the request names no browser', async () => {
    const m = await approvals(browserReq({ connector_name: undefined }));
    try {
      await flush();
      await personClick(m.button('Allow for all sites 3'));
      assert.match(m.host.querySelector('[role="alertdialog"]')!.textContent!, /Including sites you're signed in to\./);
    } finally {
      await m.close();
    }
  });

  test('while the chat runs, the approval stack keeps Stop chat, which interrupts the chat', async () => {
    f.requests = [browserReq()];
    f.session = { approvals: [] };
    f.calls = [];
    f.state = { segments: {}, runtime: { chat: { activeTurnId: 'turn-1' } } };
    const m = await mount(createElement(Approvals, { threadId: 'chat', cwd: '/project' }));
    try {
      assert.equal(m.host.querySelector('.approval-queue')?.textContent, 'Stop chat');
      await m.click(m.button('Stop chat'));
      assert.deepEqual(
        f.calls.filter((c: any[]) => c[0] === 'interrupt'),
        [['interrupt', 'chat']],
      );
    } finally {
      await m.close();
    }
  });

  test("a Codex browser card ignores scripts, typing, an open menu and another card; a person's click answers", async () => {
    const m = await approvals(browserReq({ persist: undefined, connector_name: undefined, codex_sensitive_action: false }));
    try {
      await flush();
      assert.equal(m.host.querySelector('.approval-kind')?.textContent, 'Browser');
      assert.equal(m.host.querySelector('[role="alert"]') === null, true);
      // no persistent grant offered: no all-sites choice, and Codex's requirements are not read
      assert.deepEqual(footBtns(m.host), ['Decline Esc', 'Allow in this chat 1']);
      assert.deepEqual(
        f.calls.filter((c: any[]) => c[0] === 'codex'),
        [],
      );
      await scriptKey('Enter');
      await scriptKey('Escape');
      await act(async () => {
        m.button('Allow in this chat 1').click();
      });
      const input = document.createElement('input');
      document.body.append(input);
      await press('Enter', input);
      input.remove();
      const layer = document.createElement('div');
      layer.className = 'popover-layer';
      document.body.append(layer);
      await press('1');
      layer.remove();
      const other = document.createElement('div');
      other.className = 'approval-card';
      const inside = document.createElement('span');
      other.append(inside);
      document.body.append(other);
      await press('Escape', inside);
      other.remove();
      await press('2');
      assert.deepEqual(resolved(), []);
      await personClick(m.button('Decline Esc'));
      await personClick(m.button('Allow in this chat 1'));
      assert.deepEqual(resolved(), [
        ['br-1', { action: 'decline', content: null, _meta: null }],
        ['br-1', { action: 'accept', content: {}, _meta: null }],
      ]);
    } finally {
      await m.close();
    }
  });

  test('"Allow for all sites" is hidden when Codex\'s requirements turn it off or cannot be read', async () => {
    for (const requirements of [
      async () => ({ requirements: { browserUse: { allowGlobalPersistentApproval: false } } }),
      async () => {
        throw new Error("Codex isn't started");
      },
    ]) {
      f.requirements = requirements;
      const m = await approvals(browserReq());
      try {
        await flush();
        assert.deepEqual(footBtns(m.host), ['Decline Esc', 'Allow in this chat 1', 'Allow for this site 2']);
        await press('3');
        assert.deepEqual(resolved(), []);
      } finally {
        await m.close();
      }
    }
    // the card goes before the read answers: nothing is set on it
    let release!: (v: any) => void;
    f.requirements = () =>
      new Promise((r) => {
        release = r;
      });
    const m = await approvals(browserReq());
    await m.close();
    await act(async () => {
      release({ requirements: null });
      await Promise.resolve();
    });
    f.requirements = async () => ({ requirements: null });
  });

  test('each Codex browser request names what it is for, with its site, details and risk', async () => {
    const rows = (h: any) =>
      [...h.querySelectorAll('.approval-rows > div')].map((d: any) => [
        d.querySelector('dt').textContent,
        d.querySelector('dd').textContent,
      ]);
    const cases: [any, string, (host: any) => void][] = [
      [
        { tool_name: 'access_browser_origin_with_raw_cdp', riskLevel: 'high', codex_sensitive_action: false },
        'Codex wants full DevTools access on example.com',
        (h) => {
          assert.match(h.querySelector('[role="alert"]').textContent, /^ Can read and change anything on this site\.$/);
          assert.deepEqual(footBtns(h), ['Decline Esc', 'Allow in this chat 1', 'Always allow for this site 2']);
        },
      ],
      [
        { tool_name: 'upload_browser_files', persist: ['session', 'always'] },
        'Codex wants to upload files to example.com',
        (h) => assert.deepEqual(footBtns(h), ['Decline Esc', 'Allow once 1', 'Allow in this chat 2', 'Always allow for this site 3']),
      ],
      [
        { tool_name: 'download_browser_files', persist: 'session' },
        'Codex wants to download files from example.com',
        (h) => assert.deepEqual(footBtns(h), ['Decline Esc', 'Allow once 1', 'Allow in this chat 2']),
      ],
      [
        {
          tool_name: undefined,
          origin: undefined,
          tool_params: { asset_origins: ['http://localhost:8080'] },
          tool_params_display: [{ display_name: 'Download from', value: 'http://localhost:8080' }],
        },
        'Codex wants to download page assets from localhost:8080',
        (h) => {
          assert.equal(h.querySelector('.browser-origin').textContent, 'http://localhost:8080');
          assert.deepEqual(rows(h), [['Download from', 'http://localhost:8080']]);
        },
      ],
      [
        {
          tool_name: undefined,
          origin: undefined,
          tool_params: {},
          sensitive_data: 'browsing_history',
          subtitle: 'Uses pages you visited.',
        },
        'Codex wants to use your browsing history',
        (h) => {
          assert.equal(h.querySelector('.sage-access-hint').textContent, '“Uses pages you visited.”');
          assert.deepEqual(footBtns(h), ['Decline Esc', 'Allow once 1', 'Always allow 2']);
        },
      ],
      [
        { tool_name: 'webmcp:example.com:buy', tool_title: 'Invoke Buy (buy)', tool_params: { sku: 'A1' }, persist: undefined },
        'Codex wants to run a WebMCP tool on example.com',
        (h) => {
          assert.deepEqual(rows(h), [
            ['Tool', 'Invoke Buy (buy)'],
            ['Input', '{\n  "sku": "A1"\n}'],
          ]);
        },
      ],
      [
        { tool_name: 'x', origin: 'about:blank', tool_params: {} },
        'Allow Chrome to access https://example.com?',
        (h) => assert.equal(h.querySelector('.approval-rows') === null, true),
      ],
    ];
    for (const [meta, message, check] of cases) {
      const m = await approvals(browserReq(meta));
      try {
        await flush();
        assert.equal(m.host.querySelector('.approval-message')?.textContent, message);
        check(m.host);
      } finally {
        await m.close();
      }
    }
    // a site that is not a URL is named as given, or as "this site"; an action without a message says what it is
    let m = await approvals(browserReq({ origin: 'about:blank', tool_params: {} }));
    try {
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Codex wants to use about:blank');
    } finally {
      await m.close();
    }
    m = await approvals(browserReq({ origin: undefined, tool_params: {} }));
    try {
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Codex wants to use this site');
    } finally {
      await m.close();
    }
    m = await approvals(browserReq({ tool_name: 'x' }, { message: ' ' }));
    try {
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Codex wants to take a browser action');
    } finally {
      await m.close();
    }
  });

  function chromeReq(toolName: string, input: any, extra: any = {}) {
    return {
      id: 'cperm-1',
      method: 'claude/toolApproval',
      threadId: 'chat',
      params: { toolName, input, title: null, blockedPath: null, reason: null, _claude: { toolName, input, suggestions: null }, ...extra },
    };
  }

  test('a Claude in Chrome card names the action and site and offers Allow once and Deny without suggestions', async () => {
    const m = await approvals(chromeReq('mcp__claude-in-chrome__navigate', { url: 'https://example.com/login', tabId: 4 }));
    try {
      assert.equal(m.host.querySelector('.approval-kind')?.textContent, 'Claude in Chrome');
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Open a page on example.com');
      assert.equal(m.host.querySelector('.approval-message .browser-site')?.textContent, 'example.com');
      assert.deepEqual(
        [...m.host.querySelectorAll('.approval-rows > div')].map((d: any) => d.textContent),
        ['URLhttps://example.com/login'],
      );
      assert.equal(m.host.querySelector('.approval-cmd') === null, true);
      // one choice: no chevron, and no menu behind it
      assert.equal(m.host.querySelector('[aria-label="Approval options"]') === null, true);
      assert.deepEqual([...m.host.querySelectorAll('[data-marker="menu-item"]')], []);
      // no session option to pick by key
      await press('2');
      assert.deepEqual(resolved(), []);
      await press('Enter');
      assert.deepEqual(resolved(), [['cperm-1', { decision: 'accept' }]]);
    } finally {
      await m.close();
    }
  });

  test("a Claude in Chrome card offers the CLI's suggestion as one choice that says what it keeps", async () => {
    const suggestions = [
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'mcp__claude-in-chrome__computer' }] },
    ];
    const m = await approvals(
      chromeReq(
        'mcp__claude-in-chrome__computer',
        { action: 'type', text: 'hello', tabId: 4 },
        { reason: 'Typing into the search box', _claude: { suggestions } },
      ),
    );
    try {
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Type text');
      assert.ok(m.host.querySelector('[aria-label="Approval options"]'));
      assert.deepEqual(
        [...m.host.querySelectorAll('[data-marker="menu-item"]')].map((b: any) => b.textContent),
        ['Allow once', 'Always allow computer in this project'],
      );
      assert.equal(m.host.querySelector('.approval-cwd')?.textContent, 'Typing into the search box');
      await press('2');
      assert.deepEqual(resolved(), [['cperm-1', { decision: 'acceptForSession' }]]);
    } finally {
      await m.close();
    }
  });

  test("a Claude in Chrome card shows the tab's last page as that, and code as a block", async () => {
    f.requests = [chromeReq('mcp__claude-in-chrome__javascript_tool', { action: 'javascript_exec', text: 'document.title', tabId: 4 })];
    f.session = { approvals: [] };
    f.calls = [];
    f.state = {
      segments: {},
      runtime: {
        chat: {
          turns: [
            {
              items: [
                {
                  type: 'mcpToolCall',
                  server: 'claude-in-chrome',
                  tool: 'navigate',
                  arguments: { tabId: 4, url: 'https://shop.example/cart' },
                },
              ],
            },
          ],
        },
      },
    };
    const m = await mount(createElement(Approvals, { threadId: 'chat', cwd: '/project' }));
    try {
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Run JavaScript');
      assert.equal(m.host.querySelector('.approval-cmd')?.textContent, 'document.title');
      assert.deepEqual(
        [...m.host.querySelectorAll('.approval-rows dd')].map((d: any) => d.textContent),
        ['last opened shop.example in this chat'],
      );
    } finally {
      await m.close();
    }
  });

  test('any other Claude Code MCP tool keeps the generic tool card', async () => {
    const m = await approvals(chromeReq('mcp__docs__search', { q: 'x' }));
    try {
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Allow Claude Code to use docs · search?');
      assert.equal(m.host.querySelector('.approval-cmd')?.textContent, JSON.stringify({ q: 'x' }, null, 2));
    } finally {
      await m.close();
    }
  });
}
