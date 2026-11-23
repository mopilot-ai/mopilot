// Site-permission contract unit cases for plugin-rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserTabs,
  pluginSiteConsent,
  CodexBrowserUse,
  CodexSiteBlocks,
  browseBlock,
  patternCovers,
  createBrowserTools,
  S,
  CHAT,
  ctx,
  flush,
  grantsFor,
  fs,
  os,
  path,
} from './fixture.ts';

export function registerPluginRules() {
  test('CM-P08: Codex Browser Use blocks apply to browser_* in every chat (a Claude chat included, #1319 G13)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p08-'));
    try {
      fs.mkdirSync(path.join(home, 'browser'));
      fs.writeFileSync(path.join(home, 'browser', 'config.toml'), '[origins]\ndenied = ["https://blocked.test"]\n');
      const policy = { requirements: { browserUse: { origins: { 'https://*.corp.test': { access: 'deny' } } } }, config: null };
      const blocks = new CodexSiteBlocks({
        browserUse: new CodexBrowserUse({ home: () => home, policy: async () => policy }),
        store: null,
      });
      const { g } = grantsFor('iab', { external: (url: string) => blocks.reason(url) });
      assert.equal(g.peek('https://blocked.test/', 'read', ctx), 'blocked');
      await assert.rejects(
        g.require('https://blocked.test/', 'read', ctx),
        (e: any) => e.code === 'blocked' && /blocked this site in Codex Browser Use/.test(e.message),
      );
      await assert.rejects(g.act('https://blocked.test/', ctx), (e: any) => e.code === 'blocked');
      assert.equal(g.allowInChat(CHAT, 'https://blocked.test', 'read'), false);
      assert.equal(g.consented(CHAT, 'https://blocked.test', 'chat'), false);
      assert.match(g.blockNote('https://blocked.test/?token=abc', ctx), /token=REDACTED/);
      assert.match(g.blockNote('http://169.254.169.254/x', ctx), /^Cloud metadata/i);
      assert.match(g.blockNote('https://fine.test/', ctx), /https:\/\/fine\.test\/$/);
      // the managed policy arrives in the background, then applies
      await flush();
      assert.equal(g.peek('https://wiki.corp.test/', 'read', ctx), 'blocked');
      // the browser_* tools refuse with the reason
      const tabs: any = {
        resolve: async () => tab,
        run: BrowserTabs.prototype.run,
        ready: async () => ({}),
        awaitUser: async (_t: any, p: any) => p,
      };
      const tab: any = { id: 't1', url: 'https://blocked.test/', queue: Promise.resolve(), kind: 'tab' };
      const tools = createBrowserTools({ tabs, grants: g });
      const read = tools.find((t: any) => t.name === 'browser_get_page_text');
      await assert.rejects(read.handler({}, ctx), (e: any) => e.code === 'blocked' && /Codex Browser Use/.test(e.message));
      // an outside rule that fails blocks nothing
      const { g: shaky } = grantsFor('iab', {
        external: () => {
          throw new Error('unreadable');
        },
      });
      assert.equal(shaky.peek('https://a.test/', 'read', ctx), 'ask');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    // the rules as the plugin reads them
    assert.equal(patternCovers('*', 'https://a.test/'), true);
    assert.equal(patternCovers('https://*.a.test', 'https://x.a.test/'), true);
    assert.equal(patternCovers('https://*.a.test', 'http://x.a.test/'), false);
    assert.equal(patternCovers('http://localhost:3000', 'http://localhost:3000/'), true);
    assert.equal(patternCovers('http://localhost:3000', 'http://localhost:4000/'), false);
    assert.equal(patternCovers('bad', 'https://a.test/'), false);
    assert.equal(patternCovers('https://a.test/path', 'https://a.test/'), false);
    assert.equal(patternCovers(null, 'https://a.test/'), false);
    assert.equal(patternCovers('https://a.test', 'file:///x'), false);
    assert.equal(patternCovers('https://a.test', 'not a url'), false);
    assert.equal(browseBlock({}, {}, 'file:///x'), null);
    assert.match(browseBlock({}, { requirements: { allowBrowserAndComputerUse: false } }, 'https://a.test/'), /turns off browser use/);
    const deny = { access: 'deny' };
    assert.match(browseBlock({}, { config: { browser_use: { default_origin_policy: deny } } }, 'https://a.test/'), /config\.toml/);
    // a matching allow wins over the default deny; another site still gets the default
    const managed = {
      requirements: { browserUse: { defaultOriginPolicy: deny, origins: { 'https://ok.test': { access: 'allow' }, x: 'bad' } } },
    };
    assert.equal(browseBlock({}, managed, 'https://ok.test/'), null);
    assert.match(browseBlock({}, managed, 'https://other.test/'), /organization/);
    assert.match(browseBlock({ origins: { denied: ['https://*.bad.test'] } }, {}, 'https://x.bad.test/'), /blocked this site/);
    // each reason says where it is set: config.toml as the user's home names it
    assert.match(
      browseBlock({}, { config: { browser_use: { default_origin_policy: deny } } }, 'https://a.test/', { configFile: '/h/config.toml' }),
      /in \/h\/config\.toml \(browser_use\).*Change it there/,
    );
    // the same site spelled with a trailing dot, or a pattern spelling out the default port, is still blocked
    assert.match(browseBlock({ origins: { denied: ['https://*.bad.test'] } }, {}, 'https://x.bad.test./'), /blocked this site/);
    assert.match(browseBlock({ origins: { denied: ['https://bad.test'] } }, {}, 'https://bad.test./x'), /blocked this site/);
    assert.match(browseBlock({ origins: { denied: ['bad.test'] } }, {}, 'https://bad.test:443/'), /blocked this site/);
    assert.equal(browseBlock({ origins: { denied: ['https://bad.test', 'nonsense here'] } }, {}, 'https://good.test/'), null);
    assert.equal(patternCovers('https://*.a.test:443', 'https://x.a.test/'), true);
    assert.equal(patternCovers('http://a.test:80', 'http://a.test./'), true);
    assert.equal(patternCovers('https://a.test.', 'https://a.test/'), true);
    assert.equal(patternCovers('https://a.test:8443', 'https://a.test/'), false);
    // a default policy that says nothing about access, and a matching rule that says neither
    assert.equal(
      browseBlock(
        {},
        { requirements: { browserUse: { defaultOriginPolicy: { uploads: 'deny' }, origins: { 'https://a.test': {} } } } },
        'https://a.test/',
      ),
      null,
    );
    assert.equal(browseBlock({ origins: { denied: ['https://bad.test'] } }, {}, 'https://good.test/'), null);
  });

  test('CM-P08b: Codex Browser Use rules are read from the file each time it changes and the policy again once a minute', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p08b-'));
    try {
      let reads = 0;
      const browserUse = new CodexBrowserUse({ home: () => home, policy: async () => (reads++, { requirements: null, config: null }) });
      const blocks = new CodexSiteBlocks({ browserUse, store: null });
      assert.equal(blocks.reason('https://a.test/', 1000), null);
      await flush();
      blocks.reason('https://a.test/', 2000);
      assert.equal(reads, 1, 'reused within a minute');
      blocks.reason('https://a.test/', 70_000);
      await flush();
      assert.equal(reads, 2);
      // a rule saved from Settings applies to the next command
      await browserUse.setRule('browse', 'https://a.test', 'deny');
      assert.match(blocks.reason('https://a.test/', 70_001)!, /blocked this site/);
      await browserUse.setRule('browse', 'https://a.test', 'allow');
      assert.equal(blocks.reason('https://a.test/', 70_002), null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('CM-P08c: a policy read that decides nothing keeps the policy last read, and the next command reads again (#1531)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p08c-'));
    try {
      const deny = { requirements: { allowBrowserAndComputerUse: false }, config: null };
      const answers: any[] = [deny, new Error('Timed out'), { requirementsKnown: false }, { requirements: null, config: null }];
      let reads = 0;
      const blocks = new CodexSiteBlocks({
        browserUse: new CodexBrowserUse({
          home: () => home,
          policy: async () => {
            const a = answers[reads++];
            if (a instanceof Error) throw a;
            return a;
          },
        }),
        store: null,
      });
      blocks.reason('https://a.test/', 0);
      await flush();
      assert.match(blocks.reason('https://a.test/', 1000)!, /./, 'the managed policy blocks it');
      // a minute later Codex times out: the policy it reported stays, and the next command asks again
      assert.match(blocks.reason('https://a.test/', 61_000)!, /./);
      await flush();
      assert.equal(reads, 2);
      assert.match(blocks.reason('https://a.test/', 61_001)!, /./);
      await flush();
      assert.equal(reads, 3, 'read again at once: Codex was not running');
      assert.match(blocks.reason('https://a.test/', 61_002)!, /./);
      await flush();
      // a read that answered replaces it, and is kept for a minute
      assert.equal(reads, 4);
      assert.equal(blocks.reason('https://a.test/', 61_003), null);
      await flush();
      assert.equal(reads, 4);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('CM-P09: a plugin consent is a grant only for its own browser (the in-app one) and only for site access', () => {
    const { g } = grantsFor('iab');
    let inApp = true;
    const consent = pluginSiteConsent({ grants: () => g, chatOf: () => CHAT, inApp: () => inApp });
    const req = (id: number, meta: any) => ({
      id,
      method: 'mcpServer/elicitation/request',
      params: { threadId: S, _meta: { connector_id: 'browser-use', tool_name: 'access_browser_origin', ...meta } },
    });
    const accept = { action: 'accept', _meta: null };
    // the plugin's Chrome backend names the user's browser: nothing in MoPilot's tables
    consent.observe(req(1, { origin: 'https://a.test', connector_name: 'Chrome' }));
    assert.equal(consent.answered(1, accept), false);
    // raw DevTools access isn't a site grant
    consent.observe(req(2, { origin: 'https://b.test', tool_name: 'access_browser_origin_with_raw_cdp' }));
    assert.equal(consent.answered(2, accept), false);
    // a thread without the iab backend: its plugin isn't in the in-app browser
    inApp = false;
    consent.observe(req(3, { origin: 'https://c.test' }));
    assert.equal(consent.answered(3, accept), false);
    // the in-app browser's own consent: kept for the chat
    inApp = true;
    consent.observe(req(4, { origin: 'https://d.test', connector_name: 'Browser use' }));
    assert.equal(consent.answered(4, accept), true);
    assert.equal(g.peek('https://d.test/', 'write', ctx), 'ok');
    assert.equal(g.peek('https://a.test/', 'read', ctx), 'ask');
    // no grants yet
    const early = pluginSiteConsent({ grants: () => null, chatOf: () => CHAT, inApp: () => true });
    early.observe(req(5, { origin: 'https://e.test' }));
    assert.equal(early.answered(5, accept), false);
  });
}
