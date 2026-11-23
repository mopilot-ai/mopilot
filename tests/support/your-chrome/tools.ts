// Chrome tool permissions, sensitive inputs, selector compatibility and defaults.
import { test, assert, require, chromeTools, OriginGrants, Registry } from './fixture.ts';

export function registerToolRefusals() {
  test('Chrome typing refuses a password field before approval or the write', async () => {
    const calls: string[] = [];
    const inst = {
      url: 'https://task.test/',
      call: async (name: string) => {
        calls.push(name);
        return {
          content: [
            {
              type: 'text',
              text:
                name === 'browser_evaluate'
                  ? JSON.stringify({ mopilot_intent: true, secret: true, editable: true, tag: 'input', name: 'Password' }, null, 2)
                  : 'Page URL: https://task.test/',
            },
          ],
        };
      },
    };
    const [tool] = chromeTools({
      channel: { instance: async () => inst },
      grants: { require: async () => {}, act: async () => assert.fail('password typing must not request approval') },
      schemas: [{ name: 'browser_type' }],
    });
    await assert.rejects(tool.handler({ target: 'pw', text: 'secret' }, { chatId: 'chat' }), (e: any) => e.code === 'password_field');
    assert.deepEqual(calls, ['browser_snapshot', 'browser_evaluate']);
  });

  test('a dialog answer tolerates an instance with no prior modal-state record', async () => {
    const calls: string[] = [];
    const [tool] = chromeTools({
      channel: { instance: async () => ({ url: 'https://task.test/', call: async (name: string) => (calls.push(name), { content: [] }) }) },
      grants: { require: async () => {}, act: async () => {} },
      schemas: [{ name: 'browser_handle_dialog' }],
    });
    assert.deepEqual(await tool.handler({ accept: false }, { chatId: 'chat' }), { content: [] });
    assert.deepEqual(calls, ['browser_handle_dialog']);
  });
}

export function registerToolPermissions() {
  test('chromeTools: namespaced, and behind the same site permissions', async () => {
    let page = 'about:blank';
    const calls: any[] = [];
    const inst = {
      get url() {
        return page;
      },
      call: async (name: string, args: any) => {
        calls.push([name, args]);
        if (name === 'browser_navigate') page = args.url === 'https://a.test/jump' ? 'https://evil.test/' : args.url;
        if (name === 'browser_click') return { content: [{ type: 'text', text: 'clicked' }] };
        if (name === 'browser_hover') return { content: [{ type: 'text', text: '### Error\nboom' }], isError: true };
        return { content: [null, { type: 'text', text: `### Page\n- Page URL: ${page}` }] };
      },
    };
    const channel = { instance: async () => inst };
    const grants = new OriginGrants({
      ask: async (q: any) => {
        const level = ({ 'https://a.test': 'read', 'https://w.test': 'write' } as any)[q.origin];
        return level ? { decision: 'allow', scope: 'always', level } : { decision: 'deny' };
      },
    });
    const schemas = [
      {
        name: 'browser_navigate',
        description: 'Navigate',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
      { name: 'browser_snapshot', inputSchema: { type: 'object', properties: {} } },
      { name: 'browser_click', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } },
      { name: 'browser_hover', inputSchema: { type: 'object', properties: {} } },
      { name: 'browser_evaluate', inputSchema: { type: 'object', properties: {} } },
    ];
    const r = new Registry();
    for (const t of chromeTools({ channel, grants, schemas })) r.register(t);
    assert.deepEqual(
      r.list().map((t: any) => [t.name, t.policy]),
      [
        ['sage_browser_navigate', 'observe'],
        ['sage_browser_snapshot', 'observe'],
        ['sage_browser_click', 'act'],
        ['sage_browser_hover', 'act'],
      ],
    );
    const call = (tool: string, args: any = {}) => r.invoke('c1', 's1', tool, args);

    assert.equal((await call('sage_browser_navigate', { url: 'file:///etc/hosts' })).error.code, 'blocked');
    assert.equal((await call('sage_browser_navigate', { url: 'ftp://files.test/' })).error.code, 'bad_url');
    assert.equal(calls.length, 0, 'refused before Chrome is touched');
    const nav = await call('sage_browser_navigate', { url: 'https://a.test/' });
    assert.equal(nav.ok, true);
    assert.match(nav.content[0].text, /Page URL: https:\/\/a.test\//);
    assert.equal((await call('sage_browser_click', { ref: 'e1' })).error.code, 'read_only');
    assert.ok(!calls.some(([n]) => n === 'browser_click'));

    // a jump to a site the user denies: nothing from it comes back, and the tab is blanked
    const jumped = await call('sage_browser_navigate', { url: 'https://a.test/jump' });
    assert.equal(jumped.error.code, 'denied');
    assert.deepEqual(calls.at(-1), ['browser_navigate', { url: 'about:blank' }]);

    await call('sage_browser_navigate', { url: 'https://w.test/' });
    assert.equal((await call('sage_browser_click', { ref: 'e1' })).ok, true);
    assert.equal((await call('sage_browser_hover')).error.code, 'failed');
  });

  test("chromeTools: a refusal carries the built-in browser's reason and next step; other failures stay plain", async () => {
    const inst = {
      url: 'about:blank',
      call: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    };
    const grants = new OriginGrants({ ask: async () => ({ decision: 'deny' }) });
    const tools: any = Object.fromEntries(
      chromeTools({
        channel: { instance: async () => inst },
        grants,
        schemas: [{ name: 'browser_navigate' }, { name: 'browser_snapshot' }],
      }).map((t: any) => [t.name, t]),
    );
    const ctx = { chatId: 'c', segmentId: 's' };
    const refused: any = await tools.sage_browser_navigate.handler({ url: 'https://nope.test/' }, ctx).catch((e: any) => e);
    assert.equal(refused.refusal, true);
    // a refusal in Your Chrome names its browser, so the ways-forward strip acts on Chrome's own site table
    assert.match(refused.message, /<refusal reason="[a-z_]+" retryable="(true|false)" browser="chrome">/);
    const plain: any = await tools.sage_browser_snapshot.handler({}, ctx).catch((e: any) => e);
    assert.equal(plain.refusal, undefined);
    assert.doesNotMatch(plain.message, /<refusal/);
  });

  test('chromeTools: a write needs a known page first', async () => {
    const inst = { url: null, call: async () => ({ content: [] }) };
    const r = new Registry();
    const g = new OriginGrants({ ask: async () => ({ decision: 'allow', scope: 'always', level: 'write' }) });
    for (const t of chromeTools({
      channel: { instance: async () => inst },
      grants: g,
      schemas: [{ name: 'browser_type', inputSchema: { type: 'object' } }],
    }))
      r.register(t);
    assert.equal((await r.invoke('c', 's', 'sage_browser_type', {})).error.code, 'bad_args');
  });
}

export function registerSelectorCompatibility() {
  test('Chrome adapters support legacy refs and report unsupported selectors or missing tools', async () => {
    const { chromeCoreTools } = require('../../../electron/capabilities/browser/control.cjs');
    const { panelBrowserTools } = require('../../../electron/capabilities/browser/tools.cjs');
    const core = panelBrowserTools({ panel: {}, grants: {} });
    const got: any[] = [];
    const chrome = ['click', 'type'].map((name) => ({
      name: `sage_browser_${name}`,
      schema: { properties: { ref: {} } },
      handler: async (args: any) => got.push(args),
    }));
    const defs = chromeCoreTools(core, chrome);
    await defs[2].handler({ ref: 'e2' }, {});
    await defs[3].handler({ ref: 'e2', text: 'Ada' }, {});
    assert.deepEqual(got, [
      { ref: 'e2', element: 'e2' },
      { ref: 'e2', element: 'e2', text: 'Ada', submit: false },
    ]);
    await assert.rejects(defs[2].handler({ selector: '#button' }, {}), /fresh snapshot/);
    await assert.rejects(defs[0].handler({ url: 'https://task.test/' }, {}), /unavailable/);
    const noSchema = chromeCoreTools(core, [{ name: 'sage_browser_click', handler: async () => 'clicked' }]);
    assert.equal(await noSchema[2].handler({ ref: 'e1' }, {}), 'clicked');
  });
}

export function registerApprovalOwnership() {
  test('Chrome writes require a fresh snapshot after handoff and reject manual page changes before or during approval', async () => {
    for (const scenario of ['handoff', 'changed-before', 'changed-during', 'snapshot-error', 'check-error', 'disabled-during', 'success']) {
      let current = 'https://task.test/';
      const calls: string[] = [];
      const inst: any = {
        url: current,
        needsSnapshot: scenario === 'handoff',
        call: async (name: string) => {
          calls.push(name);
          if (name === 'browser_snapshot' && scenario === 'changed-before') current = 'https://other.test/';
          if (name === 'browser_snapshot' && scenario === 'snapshot-error') return { isError: true };
          // the second snapshot is the check after the permission (the page's intent is read between them)
          if (name === 'browser_snapshot' && calls.filter((n) => n === 'browser_snapshot').length === 2 && scenario === 'check-error')
            return { isError: true };
          inst.url = current;
          return { content: [{ type: 'text', text: `Page URL: ${current}` }] };
        },
      };
      let enabled = true;
      const grants = {
        require: async () => {
          if (scenario === 'changed-during') current = 'https://other.test/';
          if (scenario === 'disabled-during') enabled = false;
        },
        act: async () => {},
      };
      const defs = chromeTools({
        channel: { instance: async () => inst },
        grants,
        enabled: () => enabled,
        schemas: [{ name: 'browser_click' }, { name: 'browser_snapshot' }],
      });
      const click = defs[0].handler({}, { chatId: 'chat' });
      if (scenario === 'success') await click;
      else await assert.rejects(click, /snapshot|page changed|browser changed/i);
      assert.equal(calls.includes('browser_click'), scenario === 'success');
      if (scenario === 'handoff') {
        await defs[1].handler({}, { chatId: 'chat' });
        assert.equal(inst.needsSnapshot, false);
      }
    }
  });

  test('chromeTools: a high-risk site asks for each action, and a click on an element named like a sensitive action asks anywhere', async () => {
    let page = 'https://www.chase.com/accounts';
    const calls: any[] = [];
    const inst: any = {
      url: page,
      needsSnapshot: false,
      call: async (name: string, args: any) => {
        calls.push(name);
        inst.url = page;
        return { content: [{ type: 'text', text: `Page URL: ${page}` }] };
      },
    };
    const confirms: any[] = [];
    let ok = true;
    const g = new OriginGrants({
      ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
      confirmAction: async (req: any) => (confirms.push(req), ok),
    });
    const defs = chromeTools({
      channel: { instance: async () => inst },
      grants: g,
      schemas: [{ name: 'browser_click' }, { name: 'browser_type' }],
    });
    const c = { chatId: 'c', segmentId: 's' };
    await defs[0].handler({ element: 'Statements', ref: 'e1' }, c);
    const asked = confirms.pop();
    assert.equal(asked.origin, 'https://www.chase.com');
    assert.equal(asked.tool, 'click');
    assert.equal(asked.summary, 'click "Statements"');
    assert.equal(asked.sensitive, null);
    assert.equal(asked.risk.category, 'banking');
    assert.ok(calls.includes('browser_click'));
    // typing on the high-risk site asks too; a "no" keeps Chrome untouched
    ok = false;
    calls.length = 0;
    await assert.rejects(defs[1].handler({ text: 'x' }, c), { code: 'denied' });
    assert.equal(confirms.pop().summary, 'type');
    assert.ok(!calls.includes('browser_type'));
    // an ordinary site: a click on "Place order" asks, typing doesn't
    page = 'https://shop.test/cart';
    inst.url = page;
    ok = true;
    await defs[0].handler({ element: 'Place order', ref: 'e9' }, c);
    assert.deepEqual(confirms.pop().sensitive, { kind: 'purchase', verb: 'make a purchase', detail: 'Place order' });
    await defs[1].handler({ text: 'hello' }, c);
    assert.equal(confirms.length, 0);
  });
}

export function registerToolDefaults() {
  test('Chrome tools honor defaults, blank pages, empty results and permission failures', async () => {
    const instance: any = { url: 'about:blank', call: async () => ({ content: [{ type: 'text', text: 'Page URL: about:blank' }] }) };
    const defs = chromeTools({
      channel: { instance: async () => instance },
      grants: { require: async () => {} },
      schemas: [
        { name: 'browser_snapshot', description: 'Read' },
        { name: 'browser_click', inputSchema: { type: 'string' } },
      ],
    });
    await defs[1].handler(undefined, {});
    for (const page of ['chrome://newtab/', 'chrome://new-tab-page/']) {
      instance.url = page;
      instance.call = async () => ({ content: [{ type: 'text', text: `Page URL: ${page}` }] });
      await defs[1].handler({}, {});
    }
    instance.call = async () => ({});
    assert.deepEqual(await defs[0].handler({}, {}), { content: [] });
    instance.call = async () => ({ isError: true });
    await assert.rejects(defs[0].handler({}, {}), /Playwright MCP error/);
    instance.call = async () => ({
      content: [
        { type: 'image', data: 'AA==' },
        { type: 'text', text: 'Page URL: https://denied.test/' },
      ],
    });
    const denied = chromeTools({
      channel: { instance: async () => instance },
      grants: {
        require: async () => {
          throw new Error('denied');
        },
      },
      schemas: [{ name: 'browser_snapshot' }],
    });
    await assert.rejects(denied[0].handler({}, {}), /denied/);
  });
}
