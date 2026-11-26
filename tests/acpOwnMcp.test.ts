// The user's own MCP servers in MoPilot's basic-harness chats (#1575): opencode's settings read only, the layer that
// turns some off for MoPilot's process (electron/harness/quirks/opencodeMcp.cjs), and the choice reaching the
// harness's process without cutting off a turn (electron/harness/acp/ownMcp.cjs, against electron/harness/acp.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, KEY, CWD, until, recentIgnored, clearIgnored } from './support/acp-host/fixture.ts';

const require = createRequire(import.meta.url);
const { jsoncText, settingsFiles, opencodeServers, opencodeLayer } = require('../electron/harness/quirks/opencodeMcp.cjs');
const { OwnMcp, choiceOf, offNames } = require('../electron/harness/acp/ownMcp.cjs');
const opencode = require('../electron/harness/quirks/opencode.cjs');

test('JSONC reads as JSON: comments and trailing commas go, strings keep every character', () => {
  const text = `{
    // a line comment
    "mcp": { /* a block */ "rea": { "command": ["npx", "a//b", "c/*d*/", "e\\"//f"], "enabled": true, }, },
  }`;
  assert.deepEqual(JSON.parse(jsoncText(text)), { mcp: { rea: { command: ['npx', 'a//b', 'c/*d*/', 'e"//f'], enabled: true } } });
  // an unclosed block comment ends the text
  assert.deepEqual(JSON.parse(jsoncText('{"a": 1} /* open')), { a: 1 });
});

test("opencode's settings files: its config folder (XDG or ~/.config), then $OPENCODE_CONFIG", () => {
  assert.deepEqual(settingsFiles({ HOME: '/h' }), [
    '/h/.config/opencode/config.json',
    '/h/.config/opencode/opencode.json',
    '/h/.config/opencode/opencode.jsonc',
  ]);
  assert.deepEqual(settingsFiles({ HOME: '/h', XDG_CONFIG_HOME: '/x', OPENCODE_CONFIG: '/p/c.json' }).slice(2), [
    '/x/opencode/opencode.jsonc',
    '/p/c.json',
  ]);
  assert.equal(settingsFiles({}).length, 3);
});

test("opencode's own servers: each once, a later file's enabled wins; a missing or broken file is skipped, never written", () => {
  clearIgnored();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmcp-'));
  const dir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{"mcp": {"zeta": {"type": "remote", "url": "u"}, "rea": {"type": "local"}}}');
  fs.writeFileSync(path.join(dir, 'opencode.jsonc'), '{ // later\n "mcp": {"zeta": {"enabled": false}, "docs": {"type": "local",},}, }');
  const custom = path.join(home, 'custom.json');
  fs.writeFileSync(custom, '{ not json');
  const before = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.deepEqual(opencodeServers({ HOME: home, OPENCODE_CONFIG: custom }), [
    { name: 'docs', enabled: true, config: null },
    { name: 'rea', enabled: true, config: null },
    // a later file that only turns it off keeps where it runs (for the gateway's check, #2999 C4)
    { name: 'zeta', enabled: false, config: { url: 'u' } },
  ]);
  assert.deepEqual(
    fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')),
    before,
  );
  assert.ok(recentIgnored().some((e: any) => e.context === "read opencode's settings"));
  // settings with no mcp, or one that isn't an object, list nothing
  for (const body of ['{}', '{"mcp": []}', '{"mcp": "x"}', 'null'])
    assert.deepEqual(
      opencodeServers({ HOME: '/nowhere' }, () => body),
      [],
    );
  assert.deepEqual(opencodeServers({ HOME: '/nowhere' }), []);
});

test("the layer turns servers off over MoPilot's own config; with none off it is that config alone", () => {
  const config = { share: 'disabled', agent: { x: 1 } };
  assert.deepEqual(JSON.parse(opencodeLayer(config, ['rea', 'a.b']).OPENCODE_CONFIG_CONTENT), {
    ...config,
    mcp: { rea: { enabled: false }, 'a.b': { enabled: false } },
  });
  assert.deepEqual(JSON.parse(opencodeLayer(config, []).OPENCODE_CONFIG_CONTENT), config);
  // the opencode quirk keeps its own agents and sharing off in the layer it hands over
  const layer = JSON.parse(opencode.mcp.off(['rea']).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(layer, { ...JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT), mcp: { rea: { enabled: false } } });
  assert.deepEqual(opencode.mcp.servers({ HOME: '/nowhere' }), []);
});

test('a choice from prefs: loading by default, names once and sorted, junk dropped', () => {
  assert.deepEqual(choiceOf(undefined, 'opencode'), { load: true, off: [] });
  assert.deepEqual(choiceOf({ acpMcp: { opencode: { off: ['rea', 'docs', 'rea', 3, ''] } } }, 'opencode'), {
    load: true,
    off: ['docs', 'rea'],
  });
  assert.deepEqual(choiceOf({ acpMcp: { opencode: { load: false, off: 'rea' } } }, 'opencode'), { load: false, off: [] });
  const servers = [{ name: 'docs' }, { name: 'rea' }];
  assert.deepEqual(offNames({ load: true, off: ['rea', 'gone'] }, servers), ['rea']);
  assert.deepEqual(offNames({ load: false, off: [] }, servers), ['docs', 'rea']);
});

/** A basic harness that lists two servers and says which ones its layer turns off. */
const QUIRK = {
  label: 'Fake',
  args: ['acp'],
  mcp: {
    servers: () => [
      { name: 'docs', enabled: true },
      { name: 'rea', enabled: true },
    ],
    off: (names: string[]) => ({ LAYER: names.join(',') }),
  },
};
const text = (t: string) => ({ cwd: CWD, blocks: [{ type: 'text', text: t }] });

function world(prompt?: () => Promise<any>) {
  let prefs: any = {};
  const own = new OwnMcp({ quirksOf: (id: string) => (id === 'fake' ? QUIRK : null), prefs: () => prefs, env: () => ({ BASE: '1' }) });
  const t = setup({
    quirks: (id: string) => (id === 'fake' ? QUIRK : null),
    mcpEnv: (h: string, env: any) => own.envFor(h, env),
    handlers: prompt ? { 'session/prompt': prompt } : {},
  });
  own.attach(t.host);
  const turnEnds = () => t.events.filter((e: any) => e.kind === 'turnEnd').length;
  return { own, t, turnEnds, set: (p: any) => ((prefs = p), own.changed()) };
}

test('an idle harness restarts with the new choice; its chats reopen on their next message', async () => {
  const w = world();
  await w.t.host.send(KEY, text('hi'));
  await until(() => w.turnEnds() === 1);
  assert.equal(w.t.sp.calls[0].options.env.LAYER, undefined, 'nothing off by default');
  assert.equal(w.t.sp.calls[0].options.env.BASE, '1');
  assert.deepEqual(w.own.status('fake'), {
    harness: 'fake',
    label: 'Fake',
    supported: true,
    load: true,
    servers: [
      { name: 'docs', enabled: true, off: false, managed: false },
      { name: 'rea', enabled: true, off: false, managed: false },
    ],
    pending: false,
  });
  // the same choice again changes nothing
  w.set({});
  assert.deepEqual(w.t.sp.procs[0].kills, []);
  w.set({ acpMcp: { fake: { off: ['rea'] } } });
  // Retirement ends stdin now; AcpAgent's separate grace timer signals only if the process does not exit.
  await until(() => w.t.sp.procs[0].stdin.ended);
  assert.equal(w.t.host.agents.has('fake'), false, 'the old process is no longer reusable');
  assert.equal(w.t.host.chats.has(KEY), false, "the chat's session was let go");
  assert.equal(w.own.status('fake').servers[1].off, true);
  await w.t.host.send(KEY, text('again'));
  await until(() => w.turnEnds() === 2);
  assert.equal(w.t.sp.calls.length, 2);
  assert.equal(w.t.sp.calls[1].options.env.LAYER, 'rea');
  // all of them off
  w.set({ acpMcp: { fake: { load: false } } });
  await w.t.host.send(KEY, text('third'));
  await until(() => w.turnEnds() === 3);
  assert.equal(w.t.sp.calls[2].options.env.LAYER, 'docs,rea');
  assert.equal(w.own.status('fake').load, false);
});

test('a harness at work restarts once its turn ends; a change taken back meanwhile restarts nothing', async () => {
  let release: ((v: any) => void) | null = null;
  const w = world(() => new Promise((r) => (release = r)));
  await w.t.host.send(KEY, text('long task'));
  await until(() => release);
  const agent = w.t.host.agents.get('fake');
  const chat = w.t.host.chats.get(KEY);
  w.set({ acpMcp: { fake: { off: ['docs'] } } });
  assert.equal(w.t.sp.procs[0].stdin.ended, false, 'the running process is not retired');
  assert.deepEqual(w.t.sp.procs[0].kills, [], 'the running turn is not cut off');
  assert.equal(w.own.status('fake').pending, true);
  // taken back before the turn ends
  w.set({});
  assert.equal(w.own.status('fake').pending, false);
  release!({ stopReason: 'end_turn' });
  release = null;
  await until(() => w.turnEnds() === 1);
  assert.equal(w.t.sp.procs[0].stdin.ended, false, 'taking the change back preserves the process');
  assert.equal(w.t.host.agents.get('fake'), agent);
  assert.equal(w.t.host.chats.get(KEY), chat);
  assert.deepEqual(w.t.sp.procs[0].kills, []);
  // changed again while the next turn runs: it applies when that turn ends
  await w.t.host.send(KEY, text('next'));
  await until(() => release);
  w.set({ acpMcp: { fake: { off: ['docs'] } } });
  release!({ stopReason: 'end_turn' });
  await until(() => w.turnEnds() === 2);
  await until(() => w.t.sp.procs[0].stdin.ended);
  assert.equal(w.t.host.agents.has('fake'), false);
  assert.equal(w.t.host.chats.has(KEY), false);
  assert.equal(w.own.status('fake').pending, false);
});

test('a harness with no process, one that never started, and one that cannot turn them off', () => {
  const own = new OwnMcp({ quirksOf: (id: string) => (id === 'fake' ? QUIRK : { label: 'Plain' }), prefs: () => ({}), env: () => ({}) });
  const killed: string[] = [];
  const closed: string[] = [];
  const host: any = {
    on: () => {},
    agents: new Map(),
    codingAgents: new Map(),
    chats: new Map(),
    starting: new Map(),
    close: (k: string) => void closed.push(k),
  };
  own.attach(host);
  // a process gone since it started: forgotten, nothing restarted
  assert.deepEqual(own.envFor('fake', {}), {});
  own.changed();
  assert.equal(own.started.size, 0);
  // a start still opening a session, a send under way: busy
  host.agents.set('fake', Promise.resolve({ kill: () => void killed.push('fake') }));
  host.chats.set('acp:fake:a', { harness: 'fake', sessionId: null });
  own.apply('fake');
  assert.equal(own.pending.has('fake'), true);
  host.chats.set('acp:fake:a', { harness: 'fake', sessionId: 's' });
  host.starting.set('acp:fake:a', {});
  own.apply('fake');
  assert.equal(own.pending.has('fake'), true);
  host.starting.clear();
  host.chats.set('acp:other:b', { harness: 'other', prompting: {} });
  // a working MoMo chat on the harness runs on its own process (#2278): the restart neither waits for it nor closes it
  host.chats.set('acp:fake:momo', { harness: 'fake', isolated: true, prompting: {} });
  own.apply('fake');
  assert.deepEqual(closed, ['acp:fake:a']);
  assert.equal(host.agents.has('fake'), false);
  // a process that failed to start: nothing to stop
  const failed = Promise.reject(new Error('no'));
  host.agents.set('fake', failed);
  own.apply('fake');
  own.apply('fake');
  // a harness without the capability
  assert.deepEqual(own.envFor('plain', {}), {});
  assert.deepEqual(own.status('plain'), { harness: 'plain', label: 'Plain', supported: false, load: true, servers: [], pending: false });
  assert.equal(new OwnMcp({ quirksOf: () => null, prefs: () => ({}), env: () => ({}) }).status('x').label, 'x');
});

test('a restart waiting on a session still opening goes when it opens, or when its status is read; a failing list starts as it is', () => {
  let prefs: any = { acpMcp: {} };
  const QUIRKS: any = {
    fake: QUIRK,
    broken: {
      label: 'Broken',
      mcp: {
        servers: () => {
          throw new Error('unreadable');
        },
        off: () => ({ X: '1' }),
      },
    },
  };
  const own = new OwnMcp({ quirksOf: (id: string) => QUIRKS[id] ?? null, prefs: () => prefs, env: () => ({}) });
  let listener: (e: any) => void = () => {};
  const killed: string[] = [];
  const host: any = {
    on: (_: string, fn: any) => (listener = fn),
    agents: new Map([['fake', Promise.resolve({ kill: () => void killed.push('fake') })]]),
    codingAgents: new Map(),
    chats: new Map([['acp:fake:a', { harness: 'fake', sessionId: null }]]),
    starting: new Map(),
    close: (k: string) => void host.chats.delete(k),
  };
  own.attach(host);
  own.envFor('fake', {});
  prefs = { acpMcp: { fake: { off: ['rea'] } } };
  own.changed();
  assert.equal(own.pending.has('fake'), true, 'its session is still opening');
  // another pref changes: nothing read again
  own.changed();
  assert.equal(own.pending.has('fake'), true);
  // the session opens: nothing works any more, so it goes
  host.chats.get('acp:fake:a').sessionId = 's';
  listener({ kind: 'session', key: 'acp:fake:a' });
  assert.equal(own.pending.has('fake'), false);
  assert.equal(host.agents.has('fake'), false);
  // waiting on a start that failed (its chat gone): reading the status lets it go
  host.agents.set('fake', Promise.resolve({ kill: () => {} }));
  own.pending.add('fake');
  assert.equal(own.status('fake', true).pending, true, 'a rail read leaves pending work to its owner');
  assert.equal(host.agents.has('fake'), true);
  assert.equal(own.status('fake').pending, false);
  // an event of a harness with nothing waiting does nothing
  listener({ kind: 'turnEnd', key: 'acp:other:b' });
  clearIgnored();
  assert.deepEqual(own.envFor('broken', {}), {});
  assert.deepEqual(own.status('broken').servers, []);
  assert.ok(recentIgnored().some((e: any) => e.context === "list a harness's own MCP servers"));
});
