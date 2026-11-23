// CM-P29 to CM-P32: Codex Browser Use blocks are in MoPilot's one site no-go list for every harness (#1319 G13,
// #1562): a site the user, a config.toml policy or the organization blocked for Codex is refused in a Codex, Claude
// Code or ACP chat, after a mid-chat switch, in both browsers; a failed or missing read never drops a block; the
// refusal says where the block is set and what the user can do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tick as flush } from './support/async-scenarios.ts';

export const GUARDS = ['electron/app/', 'electron/capabilities/', 'shared/', 'src/'];

const require = createRequire(import.meta.url);
const { siteTables } = require('../electron/app/browserSiteTables.cjs');
const { CodexBrowserUse } = require('../electron/capabilities/browser/codexBrowserUse.cjs');
const { CodexSiteBlocks, shownPath } = require('../electron/capabilities/browser/codexSiteBlocks.cjs');
const { explainRefusal } = require('../electron/capabilities/browser/refusals.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');
const { blockedOf, choiceLabel, latestBlocked } = await import('../src/lib/blockedChoices.ts');
const { blockedByCodex, policyRows, siteRows } = await import('../src/lib/browserSites.ts');

const ctx = { chatId: 'c1', segmentId: 's1' };

/** A CODEX_HOME with these files (relative path -> text), removed by the caller. */
function codexHome(files: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p29-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  }
  return home;
}

/** Main's two site tables over a chat whose harness `kind` names; `blocks` is what main's live.codexSiteBlocks holds. */
function tables(blocks: any, kind: { value: string }) {
  const asked: string[] = [];
  const hasThread: string[] = [];
  const live: any = {
    sessions: new Map([['c1', { permission: 'default', activeTurn: { id: 't' } }]]),
    controller: { ref: () => ({ kind: kind.value, id: kind.value === 'codex' ? 'thread-1' : 'session-1' }), adapterOf: () => ({}) },
    // the old gate read whether the chat's thread was a Codex one: nothing may ask that now
    codexTools: { hasThread: (id: string) => (hasThread.push(id), kind.value === 'codex') },
    codexSiteBlocks: blocks,
    computerUse: {
      broker: {
        ask: async (_chat: string, _kind: string, p: any) => (asked.push(p.origin), { decision: 'allow', scope: 'chat', level: 'write' }),
      },
    },
  };
  return { ...siteTables({ live, dir: '/tmp/none', prefs: () => ({}), isFlagEnabled: () => false }), asked, hasThread };
}

const DENIED = '[origins]\ndenied = ["https://blocked.test"]\n';

test('CM-P29: a site Codex Browser Use blocks is refused in every chat, whatever its harness, after a switch, in both browsers (#1319 G13)', async () => {
  const home = codexHome({ 'browser/config.toml': DENIED });
  try {
    const managed = { requirements: { browserUse: { origins: { 'https://*.corp.test': { access: 'deny' } } } }, config: null };
    const blocks = new CodexSiteBlocks({ browserUse: new CodexBrowserUse({ home: () => home, policy: async () => managed }), store: null });
    const kind = { value: 'claude' };
    const t = tables(blocks, kind);
    blocks.reason('https://warm.test/');
    await flush();
    for (const harness of ['claude', 'codex', 'acp', 'claude']) {
      // a chat that started on Claude Code, moved to Codex, then to an ACP harness and back: the block holds in each segment
      kind.value = harness;
      for (const g of [t.browserGrants, t.chromeGrants]) {
        assert.equal(g.peek('https://blocked.test/', 'read', ctx), 'blocked', `${harness} ${g.browser}: the user's own block`);
        assert.equal(g.peek('https://wiki.corp.test/x', 'read', ctx), 'blocked', `${harness} ${g.browser}: the managed policy`);
        await assert.rejects(
          g.require('https://blocked.test/', 'read', ctx),
          (e: any) => e.code === 'blocked' && /in every chat/.test(e.message),
        );
        await assert.rejects(g.act('https://wiki.corp.test/', ctx), (e: any) => e.code === 'blocked' && /organization/.test(e.message));
        // the ways forward can't allow it either, nor can another card's consent
        assert.equal(g.allowInChat('c1', 'https://blocked.test', 'read'), false);
        assert.equal(g.consented('c1', 'https://blocked.test', 'chat'), false);
        assert.match(g.blockNote('https://blocked.test/?token=abc', ctx), /blocked this site in Codex Browser Use.*token=REDACTED/s);
        // an ordinary site still asks as before
        assert.equal(g.peek('https://fine.test/', 'read', ctx), 'ask');
      }
    }
    assert.deepEqual(t.asked, [], 'no site card for a blocked site');
    assert.deepEqual(t.hasThread, [], "the chat's harness is not consulted");
    // a chat with Full access is still refused: the block is a no-go, not a permission
    t.browserGrants.anchor = () => 'full';
    await assert.rejects(t.browserGrants.require('https://blocked.test/', 'write', ctx), { code: 'blocked' });
    // before main has the blocks (startup), nothing is refused for them
    const early = tables(null, kind);
    assert.equal(early.browserGrants.peek('https://blocked.test/', 'read', ctx), 'ask');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CM-P30: a policy read that fails, Codex not running or a restart never drops a block; an unreadable file keeps the rules last read (#1562)', async () => {
  const home = codexHome({ 'browser/config.toml': DENIED });
  const store = path.join(home, 'mopilot', 'codex-browser-policy.json');
  try {
    const deny = {
      requirements: {
        allowBrowserAndComputerUse: true,
        browserUse: { origins: { 'https://*.corp.test': { access: 'deny' } } },
        other: 'x',
      },
      config: { browser_use: { origins: { 'https://cfg.test': { access: 'deny' } } }, mcp_servers: { secret: { env: { TOKEN: 't' } } } },
    };
    const answers: any[] = [deny, new Error('Timed out'), { requirementsKnown: false }];
    let reads = 0;
    const policy = async () => {
      const a = answers[Math.min(reads++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    };
    const blocks = new CodexSiteBlocks({ browserUse: new CodexBrowserUse({ home: () => home, policy }), store });
    blocks.reason('https://a.test/', 0);
    await flush();
    assert.match(blocks.reason('https://x.corp.test/', 1)!, /organization/);
    assert.doesNotMatch(blocks.reason('https://x.corp.test/', 1)!, /last ran/, 'Codex answered: its policy is current');
    assert.match(blocks.reason('https://cfg.test/', 2)!, /config\.toml/);
    // kept on disk with the browser fields only: never the rest of Codex's config
    const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
    assert.deepEqual(Object.keys(saved.requirements).sort(), ['allowBrowserAndComputerUse', 'browserUse']);
    assert.deepEqual(Object.keys(saved.config), ['browser_use']);
    assert.doesNotMatch(fs.readFileSync(store, 'utf8'), /TOKEN|secret/);
    // a minute later the read times out, then Codex isn't running: the managed policy stays, and the next command reads again
    assert.match(blocks.reason('https://x.corp.test/', 61_000)!, /organization/);
    await flush();
    assert.match(blocks.reason('https://x.corp.test/', 61_001)!, /organization/);
    await flush();
    assert.equal(reads, 3);
    // without a Codex report, config.toml's own browser_use is read from the file as it is now
    assert.equal(blocks.reason('https://cfg.test/', 61_002), null, 'no config.toml in this home: no config policy');
    fs.writeFileSync(path.join(home, 'config.toml'), '[browser_use.origins."https://cfg.test"]\naccess = "deny"\n');
    assert.match(blocks.reason('https://cfg.test/', 61_003)!, /config\.toml \(browser_use\)/);
    // a config.toml that doesn't parse keeps what it said last
    fs.writeFileSync(path.join(home, 'config.toml'), 'not = [toml, and longer than before');
    assert.match(blocks.reason('https://cfg.test/', 61_004)!, /config\.toml/);
    // the same for the user's blocked sites: a half-edited file keeps them; a removed file clears them
    fs.writeFileSync(path.join(home, 'browser', 'config.toml'), '[origins\ndenied = [');
    assert.match(blocks.reason('https://blocked.test/', 61_005)!, /You blocked this site/);
    fs.rmSync(path.join(home, 'browser', 'config.toml'));
    assert.equal(blocks.reason('https://blocked.test/', 61_006), null);
    // a restart with Codex not running: the managed policy read before is there from the first command
    const restarted = new CodexSiteBlocks({
      browserUse: new CodexBrowserUse({ home: () => home, policy: async () => ({ requirementsKnown: false }) }),
      store,
    });
    assert.match(restarted.reason('https://x.corp.test/', 0)!, /organization.*reported when it last ran/);
    // with config.toml unreadable since startup, its browser_use comes from the policy last read
    assert.match(restarted.reason('https://cfg.test/', 1)!, /config\.toml/);
    // a policy that answers replaces it, also on disk
    const lifted = new CodexSiteBlocks({
      browserUse: new CodexBrowserUse({ home: () => home, policy: async () => ({ requirements: null, config: null }) }),
      store,
    });
    lifted.reason('https://x.corp.test/', 0);
    await flush();
    assert.equal(lifted.reason('https://x.corp.test/', 1), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(store, 'utf8')), { version: 1, requirements: null, config: null });
    // an unreadable saved policy starts from none, and a save that fails keeps the answer in memory
    fs.writeFileSync(store, '{not json');
    const broken = new CodexSiteBlocks({
      browserUse: new CodexBrowserUse({ home: () => home, policy: async () => deny }),
      store: path.join(store, 'not-a-dir', 'p.json'),
    });
    broken.reason('https://a.test/', 0);
    await flush();
    assert.match(broken.reason('https://x.corp.test/', 1)!, /organization/);
    const fresh = new CodexSiteBlocks({ browserUse: new CodexBrowserUse({ home: () => home, policy: async () => ({}) }), store });
    assert.equal(fresh.reason('https://x.corp.test/', 0), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CM-P30b: a policy read that a newer read replaced is dropped, and the policy is read again once a minute', async () => {
  const home = codexHome();
  try {
    let reads = 0;
    const resolvers: Array<(v: any) => void> = [];
    const blocks = new CodexSiteBlocks({
      browserUse: new CodexBrowserUse({ home: () => home, policy: () => (reads++, new Promise((r) => resolvers.push(r))) }),
      store: null,
    });
    blocks.reason('https://a.test/', 0);
    blocks.reason('https://a.test/', 1000);
    assert.equal(reads, 1, 'reused within a minute');
    blocks.reason('https://a.test/', 61_000);
    assert.equal(reads, 2);
    // the newer read answers first; the older one, answering later, is dropped
    resolvers[1]({ requirements: null, config: null });
    await flush();
    resolvers[0]({ requirements: { allowBrowserAndComputerUse: false }, config: null });
    await flush();
    assert.equal(blocks.reason('https://a.test/', 61_001), null);
    // while Codex answers, a browser_use block in config.toml applies too, even when Codex's report has none (found in the dev app)
    fs.writeFileSync(path.join(home, 'config.toml'), '[browser_use.origins."https://cfg.test"]\naccess = "deny"\n');
    assert.match(blocks.reason('https://cfg.test/', 61_001)!, /config\.toml \(browser_use\)/);
    // the file is parsed again only when it changed
    fs.mkdirSync(path.join(home, 'browser'));
    fs.writeFileSync(path.join(home, 'browser', 'config.toml'), DENIED);
    assert.match(blocks.reason('https://blocked.test/', 61_002)!, /blocked/);
    const parsed = blocks.rules();
    assert.equal(blocks.rules(), parsed, 'unchanged: not parsed again');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CM-P30d: a refusal names config.toml where the user knows it: from ~ under their home folder', () => {
  assert.equal(shownPath('/Users/me/.codex/config.toml', '/Users/me'), '~/.codex/config.toml');
  assert.equal(shownPath('/Users/me', '/Users/me'), '~');
  assert.equal(shownPath('/Users/meg/.codex/config.toml', '/Users/me'), '/Users/meg/.codex/config.toml');
  assert.equal(shownPath('/opt/codex/config.toml'), '/opt/codex/config.toml');
});

test('CM-P30c: a file that can no longer be looked at keeps the rules last read; one never read blocks nothing', () => {
  const home = codexHome({ 'browser/config.toml': DENIED });
  try {
    let denied = false;
    const fsDenied: any = {
      ...fs,
      statSync: (p: string, o?: any) => {
        if (denied) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return fs.statSync(p, o);
      },
    };
    const browserUse = new CodexBrowserUse({ home: () => home, policy: async () => ({ requirementsKnown: false }) });
    const blocks = new CodexSiteBlocks({ browserUse, store: null, fs: fsDenied });
    assert.match(blocks.reason('https://blocked.test/', 0)!, /You blocked this site/);
    denied = true;
    assert.match(blocks.reason('https://blocked.test/', 1)!, /You blocked this site/);
    // CODEX_HOME moved to a folder whose file doesn't parse: the old folder's rules are not this one's
    denied = false;
    const other = codexHome({ 'browser/config.toml': '[origins\ndenied = [' });
    const moved = { home: home as string };
    const movable = new CodexSiteBlocks({
      browserUse: new CodexBrowserUse({ home: () => moved.home, policy: async () => ({ requirementsKnown: false }) }),
      store: null,
    });
    assert.match(movable.reason('https://blocked.test/', 0)!, /You blocked this site/);
    moved.home = other;
    assert.equal(movable.reason('https://blocked.test/', 1), null);
    fs.rmSync(other, { recursive: true, force: true });
    denied = true;
    const never = new CodexSiteBlocks({ browserUse, store: null, fs: fsDenied });
    assert.deepEqual(never.rules(), {});
    assert.equal(never.reason('https://blocked.test/', 0), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CM-P31: the refusal says where the block is set and what the user can do, on every tool family; the strip offers Browser settings only for their own block', () => {
  const blocked = (message: string, browser: 'iab' | 'chrome' | null = null) =>
    explainRefusal(new ToolError(`${message} https://blocked.test/`, 'blocked'), browser);
  const own = blocked(
    'You blocked this site in Codex Browser Use, which MoPilot applies in every chat. Remove the block in Settings → Browser → Sites to allow it.',
  );
  assert.equal(own.reason, 'codex_site_blocked');
  assert.match(own.next, /Settings → Browser → Sites/);
  const org = blocked(
    "Your organization's Codex Browser Use policy blocks this site, which MoPilot applies in every chat. Only your administrator can change it.",
    'chrome',
  );
  assert.equal(org.reason, 'codex_policy_blocked');
  assert.match(org.next, /where it is set/);
  assert.equal(
    blocked('A Codex Browser Use policy in ~/.codex/config.toml (browser_use) blocks this site.').reason,
    'codex_policy_blocked',
  );
  assert.equal(
    blocked("Your organization's Codex policy turns off browser use, which MoPilot applies in every chat.").reason,
    'codex_policy_blocked',
  );
  // a blocked risk class is still the plain block
  assert.equal(blocked('Cloud metadata endpoints are blocked.').reason, 'site_blocked');
  // the chat's strip: the tools are named alike on every harness (Codex dynamic tools, ACP MCP calls), and Claude Code's
  // in-app browser tools come by short name from its mopilot_browser server (no strip showed for them: found in the dev app)
  for (const [tool, server] of [
    ['mcp__sage__browser_navigate', undefined],
    ['browser_navigate', undefined],
    ['sage.browser_navigate', undefined],
    ['navigate', 'mopilot_browser'],
    ['mcp__mopilot_browser__navigate', undefined],
  ] as [string, string | undefined][]) {
    const item = (e: any) => ({
      id: 'i1',
      tool,
      server,
      arguments: { url: 'https://blocked.test/' },
      status: 'failed',
      error: { message: e.message },
    });
    const b = blockedOf(item(own));
    assert.ok(b, tool);
    // the turn ends on it: the strip shows it
    assert.equal(latestBlocked([item(own)])?.reason, 'codex_site_blocked', tool);
    assert.equal(b!.reason, 'codex_site_blocked');
    assert.equal(b!.text, 'blocked.test is blocked in your Codex Browser Use settings.');
    assert.deepEqual(b!.choices, ['siteSettings']);
    assert.equal(choiceLabel('siteSettings', b!), 'Browser settings');
    const p = blockedOf(item(org))!;
    assert.equal(p.text, 'blocked.test is blocked by a Codex Browser Use policy. Ask whoever manages Codex, or do this step yourself.');
    assert.deepEqual(p.choices, []);
  }
  // with no site named, the settings are still on offer
  const nameless = explainRefusal(new ToolError('You blocked this site in Codex Browser Use.', 'blocked'));
  const b = blockedOf({ id: 'i2', tool: 'browser_click', arguments: {}, status: 'failed', error: { message: nameless.message } })!;
  assert.equal(b.text, 'This site is blocked in your Codex Browser Use settings.');
  assert.deepEqual(b.choices, ['siteSettings']);
});

test('CM-P32: Settings → Browser → Sites shows a Codex block as blocked in both browsers too: one fact on every surface', () => {
  const state: any = {
    sites: [
      { origin: 'https://blocked.test', browse: 'deny', downloads: null, uploads: null, debug: null },
      { origin: 'https://upload-only.test', browse: null, downloads: null, uploads: 'deny', debug: null },
    ],
    policies: [
      { pattern: '*', source: 'managed', browse: 'deny', downloads: null, uploads: null, debug: null },
      { pattern: 'https://ok.test', source: 'config', browse: 'allow', downloads: null, uploads: null, debug: null },
    ],
  };
  const rows = siteRows(state, { iab: [{ origin: 'https://blocked.test', level: 'write' }] });
  assert.deepEqual(
    rows.map((r) => [r.origin, blockedByCodex(r)]),
    [
      ['https://blocked.test', true],
      ['https://upload-only.test', false],
    ],
  );
  assert.deepEqual(
    policyRows(state).map((p) => blockedByCodex(p)),
    [true, false],
  );
});

test('CM-P32b: Settings shows every block the browser tools apply: config.toml from the file, and the managed policy last read while Codex is not running', async () => {
  const home = codexHome({ 'config.toml': '[browser_use.origins."https://cfg.test"]\naccess = "deny"\n' });
  const store = path.join(home, 'policy.json');
  fs.writeFileSync(
    store,
    JSON.stringify({
      version: 1,
      requirements: { allowBrowserAndComputerUse: false, browserUse: { origins: { 'https://*.corp.test': { access: 'deny' } } } },
      config: null,
    }),
  );
  try {
    let answer: any = { requirementsKnown: false };
    const browserUse = new CodexBrowserUse({ home: () => home, policy: async () => answer });
    const blocks = new CodexSiteBlocks({ browserUse, store });
    const cfg = { pattern: 'https://cfg.test', source: 'config', browse: 'deny', downloads: null, uploads: null, debug: null };
    const corp = { pattern: 'https://*.corp.test', source: 'managed', browse: 'deny', downloads: null, uploads: null, debug: null };
    // Codex isn't running: the managed policy last read, browser use off by it, and config.toml's policy from the file
    const off = blocks.shown(await browserUse.state());
    assert.deepEqual(off.policies, [corp, cfg]);
    assert.match(off.disabled, /turned off browser use/);
    // Codex answers, its report naming the same config.toml policy: shown once, and only what Codex says is managed
    answer = { requirements: null, config: { browser_use: { origins: { 'https://cfg.test': { access: 'deny' } } } } };
    const on = blocks.shown(await browserUse.state());
    assert.deepEqual(on.policies, [cfg]);
    // Codex reports the pattern another way than the file: both show, as both are read
    answer = { requirements: null, config: { browser_use: { origins: { 'https://cfg.test': { access: 'allow' } } } } };
    assert.deepEqual(blocks.shown(await browserUse.state()).policies, [{ ...cfg, browse: 'allow' }, cfg]);
    assert.equal(on.disabled, null);
    // a view that is an error (an unreadable file) passes through
    assert.deepEqual(blocks.shown({ error: 'x', file: 'browser/config.toml' }), { error: 'x', file: 'browser/config.toml' });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
