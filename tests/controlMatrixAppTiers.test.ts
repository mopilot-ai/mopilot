// G10 (#3571): a tiered session's app tools wait behind app_more_tools (electron/capabilities/mcp/appTiers.cjs), and the
// desktop lists only request_access until a grant loads the app group (toolTiers.cjs autoLoad, socket.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, tiers, textOf, Registry, ToolSessions, answerToolRequest } from './support/tool-tiers-kit.ts';

const require = createRequire(import.meta.url);
const { APP_CORE, APP_SURFACE } = require('../electron/capabilities/mcp/appTiers.cjs');
const { CORE_SAGE } = require('../electron/capabilities/mcp/toolLoading.cjs');

test('CM-X26: the app core includes the Host’s This Mac route; the task list and wrap-up are grouped with the other app tools (G11)', () => {
  assert.deepEqual(CORE_SAGE, APP_CORE);
  assert.deepEqual([...APP_CORE], ['sage_debug_echo', 'sage_debug_poke', 'this_mac_control']);
  for (const t of APP_CORE) assert.equal(tiers.groupOf(t), null, t);
  assert.deepEqual(tiers.groupOf('update_task_list'), { surface: 'app', group: 'turn' });
  assert.deepEqual(tiers.groupOf('wrap_up'), { surface: 'app', group: 'turn' });
  assert.deepEqual(tiers.groupOf('start_session'), { surface: 'app', group: 'sessions' });
  assert.deepEqual(tiers.groupOf('run_in_terminal'), { surface: 'app', group: 'terminal' });
  assert.deepEqual(tiers.groupOf('a_tool_added_later'), { surface: 'app', group: 'other' });
  assert.deepEqual(tiers.groupOf('ios_simulator_control'), { surface: 'app', group: 'other' });
  // the more tools, a MoMo chat's own tools and the legacy browser channel are never deferred by the app surface
  for (const n of [
    'app_more_tools',
    'desktop_more_tools',
    'momo_memory_search',
    'sage_browser_click',
    'computer_click',
    'desktop_not_grouped',
  ])
    assert.equal(tiers.groupOf(n), null, n);
  const named = Object.values<any>(APP_SURFACE.groups).flatMap((g) => g.tools);
  assert.equal(new Set(named).size, named.length, 'an app tool is in two groups');
  assert.equal(tiers.moreSurface('app_more_tools'), 'app');
});

test('CM-X26: a tiered remote session can list and call This Mac control as soon as the Host offers it', async () => {
  const w = world();
  w.sessions.open('remote', { chatId: 'c1', segmentId: 's1', tiered: true });
  assert.ok(!(await w.list('remote')).includes('this_mac_control'));
  w.registry.register({ name: 'this_mac_control', policy: 'observe', handler: () => 'offered by the Host' });
  assert.ok((await w.list('remote')).includes('this_mac_control'));
  assert.equal(textOf(await w.call('remote', 'this_mac_control', { action: 'list' })), 'offered by the Host');
});

test('CM-X27: app_more_tools: groups in order, `other` sorted, and no skill named', () => {
  const visible = new Set(['update_task_list', 'zeta_tool', 'show_pane', 'alpha_tool', 'start_session']);
  const more = tiers.moreTool('app', visible);
  assert.equal(more.name, 'app_more_tools');
  assert.deepEqual(more.inputSchema.properties.load.items.enum, ['turn', 'sessions', 'panes', 'other']);
  assert.doesNotMatch(more.description, /skill/);
  assert.match(more.description, /call with arguments: run one now\.$/);
  const other = tiers.visibleGroups('app', visible).find((g: any) => g.id === 'other');
  assert.deepEqual(other.tools, ['alpha_tool', 'zeta_tool']);
  // Core tools alone do not need a more tool.
  assert.equal(tiers.moreTool('app', new Set(APP_CORE)), null);
});

test('CM-X28: autoLoad: only a request_access grant, only when the app group is not callable yet and the session sees its tools', () => {
  const visible = new Set(['desktop_request_access', 'desktop_app_screenshot', 'desktop_app_click']);
  const r = tiers.autoLoad('desktop_request_access', visible, new Set());
  assert.deepEqual(r.load, ['desktop/app']);
  assert.match(r.note, /^Loaded the app group \(desktop_app_screenshot, desktop_app_click\): listed from your next turn\./);
  assert.match(r.note, /desktop_more_tools \{"call": "desktop_app_screenshot"/);
  assert.equal(tiers.autoLoad('desktop_request_access', visible, new Set(['desktop/app'])), null);
  assert.equal(tiers.autoLoad('desktop_request_access', new Set(['desktop_request_access'])), null);
  assert.equal(tiers.autoLoad('browser_navigate', visible, null), null);
});

test('CM-X28: a tiered session: the desktop lists its more tool alone; a grant run through it makes the app tools callable now and listed next turn', async () => {
  const w = world();
  w.sessions.open('acp1', { chatId: 'c1', segmentId: 's1', tiered: true });
  const before = await w.list('acp1');
  assert.deepEqual(
    before.filter((n) => n.startsWith('desktop_')),
    ['desktop_more_tools'],
  );
  // request_access itself waits in the access group: a direct call is refused with how to load it (G11)
  const direct = await w.call('acp1', 'desktop_request_access', { apps: ['Notes'], reason: 'r' });
  assert.equal(direct.isError, true);
  assert.deepEqual(direct.structuredContent.loadWith, { tool: 'desktop_more_tools', arguments: { load: ['access'] } });
  // before a grant the app tools are refused with how to load them
  const early = await w.call('acp1', 'desktop_app_screenshot', { app: 'Notes' });
  assert.equal(early.isError, true);
  const grant = await w.call('acp1', 'desktop_more_tools', { call: 'desktop_request_access', arguments: { apps: ['Notes'], reason: 'r' } });
  assert.equal(grant.isError, false);
  assert.match(textOf(grant), /^ran desktop_request_access\nLoaded the app group \(desktop_screenshot, /);
  // callable at once, directly or through the more tool
  assert.equal((await w.call('acp1', 'desktop_app_screenshot', { app: 'Notes' })).isError, false);
  assert.equal((await w.call('acp1', 'desktop_more_tools', { call: 'desktop_app_click', arguments: { app: 'Notes' } })).isError, false);
  // the list never changes mid-turn: the same until the turn ends
  assert.deepEqual(await w.list('acp1'), before);
  // a second grant in the same turn adds no second note
  assert.equal(
    textOf(await w.call('acp1', 'desktop_more_tools', { call: 'desktop_request_access', arguments: { apps: ['Mail'], reason: 'r' } })),
    'ran desktop_request_access',
  );
  w.sessions.commitTurn('c1');
  const after = await w.list('acp1');
  for (const n of tiers.SURFACES.desktop.groups.app.tools) assert.ok(after.includes(n), n);
});

test('CM-X29: a refused grant loads nothing, and a session with a tool search keeps every tool listed and gets no note', async () => {
  const registry = new Registry();
  for (const name of ['desktop_request_access', 'desktop_app_screenshot'])
    registry.register({
      name,
      description: name,
      schema: { type: 'object', properties: {} },
      policy: 'observe',
      authorizesItself: true,
      handler: async () => {
        throw new Error('denied');
      },
    });
  const sessions = new ToolSessions();
  sessions.open('acp2', { chatId: 'c2', segmentId: 's2', tiered: true });
  const ask = (method: string, params: any = {}) =>
    answerToolRequest({ registry, sessions, session: sessions.get('acp2'), calls: new Map(), msg: { id: 1, method, params } }) as any;
  const refused = (await ask('tools/call', { name: 'desktop_more_tools', arguments: { call: 'desktop_request_access', arguments: {} } }))
    .result;
  assert.equal(refused.isError, true);
  assert.doesNotMatch(textOf(refused), /Loaded the app group/);
  sessions.commitTurn('c2');
  const names = (await ask('tools/list')).result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ['desktop_more_tools']);
  const w = world();
  w.sessions.open('claude', { chatId: 'c3', segmentId: 's3' });
  assert.ok((await w.list('claude')).includes('desktop_app_screenshot'));
});

test('CM-X29: a grant whose session ended while the user decided (a switch) loads nothing and adds no note', async () => {
  const registry = new Registry();
  const sessions = new ToolSessions();
  for (const name of ['desktop_request_access', 'desktop_app_screenshot'])
    registry.register({
      name,
      description: name,
      schema: { type: 'object', properties: {} },
      policy: 'observe',
      authorizesItself: true,
      handler: async () => {
        sessions.end('acp3');
        return 'granted';
      },
    });
  sessions.open('acp3', { chatId: 'c4', segmentId: 's4', tiered: true });
  const session = sessions.get('acp3');
  const call = (withSessions: boolean) =>
    answerToolRequest({
      registry,
      sessions: withSessions ? sessions : null,
      session,
      calls: new Map(),
      msg: {
        id: 1,
        method: 'tools/call',
        params: { name: 'desktop_more_tools', arguments: { call: 'desktop_request_access', arguments: {} } },
      },
    }) as any;
  assert.equal(textOf((await call(true)).result), 'granted');
  // a channel without ToolSessions records no groups either
  assert.equal(textOf((await call(false)).result), 'granted');
});
