// Deferred MCP executions retain their action, ownership and outcome across the panel, phone and desktop projections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
import { mcpWords } from './fixtures/fake-acp-mcp.mjs';
import { world } from './support/tool-tiers-kit';
import { toolInvocation } from '../shared/toolInvocation.mjs';
import { itemSteps, stepControl, toolCard, isBlockItem } from '../src/components/thread/items/stepModel';
import { turnProposals, sessionCallLine } from '../src/lib/sessionToolCall';
import { scheduledTaskCall } from '../src/lib/scheduledTaskCall';
import { ownToolLine } from '../src/lib/ownToolLines';
import { windowCallLine } from '../src/lib/windowToolCall';
import { blockedOf } from '../src/lib/blockedChoices';
import { suggestNextStep } from '../src/lib/nextStep';
import { workingEvents } from '../src/lib/workingIn';
import {
  controlStep,
  ownDesktopTool,
  ownBrowserTool,
  ownChromeTool,
  isMoPilotControl,
  controlHandoff,
  controlSource,
} from '../src/lib/agentNarration';
import { liveStep } from '../mobile/src/presentation/stepRows';
const require = createRequire(import.meta.url);
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { toolLine } = require('../electron/capabilities/browser/chromePanelToolLines.cjs');
const { stepDetails } = require('../electron/capabilities/contract/chromePanelStep.cjs');

test('the real tiered ACP executor presents the navigation it is awaiting, then failure and successful retry', async () => {
  const w = world();
  w.sessions.open('s', { chatId: 'chat', segmentId: 'segment', tiered: true });
  const records: any[] = [{ t: 'user', turnId: 't', user: { id: 'u', content: [{ type: 'text', text: 'Go' }] }, at: 1 }];
  let release!: (value: any) => void;
  const calls: any[] = [];
  const server = {
    tools: await w.list('s'),
    call: async (_method: string, call: any) => {
      calls.push(call);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const rows = () => rowsOf(buildAcpTurns(records, 'acp:opencode:native', '/work', { live: true }), { running: true }).rows;
  const run = () =>
    mcpWords('MCPTOOL chrome_navigate {"tabId":7,"url":"https://example.com"}', new Map([['sage_0123456789ab', server]]), {
      sessionId: 's',
      log: () => {},
      update: (update: any) => records.push({ t: 'update', turnId: 't', update, at: 2 }),
    });
  const first = run();
  assert.deepEqual(calls[0], {
    name: 'browser_more_tools',
    arguments: { call: 'chrome_navigate', arguments: { tabId: 7, url: 'https://example.com' } },
  });
  assert.equal(rows().at(-1).text, 'Opening example.com');
  assert.equal(rows().at(-1).state, 'running');
  const id = rows().at(-1).id;
  release({ isError: true, content: [{ type: 'text', text: 'fixture refused' }] });
  await first;
  assert.equal(rows().at(-1).text, 'Couldn’t open example.com');
  assert.equal(rows().at(-1).state, 'failed');
  assert.equal(rows().at(-1).id, id);
  const retry = run();
  release({ content: [{ type: 'text', text: 'opened' }] });
  await retry;
  assert.equal(rows().at(-1).text, 'Opened example.com');
  assert.notEqual(rows().at(-1).id, id);
});

const wrap = (tool: string, args: unknown = {}, more = 'browser_more_tools') => ({
  type: 'mcpToolCall' as const,
  id: 'call',
  server: 'sage_0123456789ab',
  tool: more,
  status: 'inProgress',
  arguments: { call: tool, arguments: args },
});

test('every harness naming form projects all three states without changing native metadata or input', () => {
  const native = wrap('chrome_navigate', { url: 'https://example.com' });
  const forms = [
    native,
    { ...native, type: 'dynamicToolCall', server: undefined },
    { ...native, tool: 'mcp__sage_0123456789ab__browser_more_tools', server: undefined },
    { ...native, tool: 'sage_0123456789ab_browser_more_tools', server: '' },
    { ...native, tool: 'sage_0123456789ab/browser_more_tools', server: '' },
    { ...native, tool: 'sage.browser_more_tools', server: undefined },
    { ...native, tool: 'browser_more_tools', server: null },
    { ...native, type: 'dynamicToolCall', server: undefined, namespace: 'sage_0123456789ab' },
    { ...native, namespace: null },
  ];
  for (const form of forms) {
    const before = structuredClone(form);
    for (const [status, state, label] of [
      ['inProgress', 'running', 'Opening example.com'],
      ['completed', 'done', 'Opened example.com'],
      ['failed', 'failed', 'Couldn’t open example.com'],
    ]) {
      const result = { isError: status === 'failed', content: [{ type: 'text', text: 'result' }] };
      const input = { ...form, status, result };
      const shown = toolInvocation(input);
      assert.equal(shown.id, 'call');
      assert.equal(shown.status, status);
      assert.equal(shown.result, result);
      assert.equal(toolLine(input, state), label);
      assert.equal(liveStep(input, 'fallback').text, label);
      assert.equal(controlStep(input)?.doing, 'Opening example.com');
      assert.equal(ownChromeTool(input)?.name, 'navigate');
      const steps = itemSteps(input as any);
      assert.equal(steps[0].kind, 'tool');
      assert.ok(steps[0].kind === 'tool');
      assert.equal(steps[0].item.tool, 'chrome_navigate');
      assert.equal(stepControl(steps[0])?.done, 'Opened example.com');
    }
    assert.deepEqual(form, before);
  }
});

test('desktop, in-app browser and app wrappers share the presentation projection and preserve action arguments', () => {
  const desktop = wrap('desktop_app_click', { app: 'Notes', label: 'Save' }, 'desktop_more_tools');
  assert.deepEqual(ownDesktopTool(desktop), { name: 'app_click' });
  assert.equal(controlStep(desktop)?.app, 'Notes');
  assert.equal(isMoPilotControl(desktop), true);
  assert.equal(toolLine(desktop, 'running'), 'Clicking');
  assert.equal(ownBrowserTool(desktop), null);
  const browser = wrap('browser_navigate', { url: 'https://example.com' });
  assert.deepEqual(ownBrowserTool(browser), { name: 'navigate' });
  assert.equal(ownDesktopTool(browser), null);
  assert.equal(controlStep(browser)?.doing, 'Opening example.com');
  assert.equal(isMoPilotControl(browser), true);
  assert.equal(controlHandoff(browser), null);
  assert.equal(controlSource(wrap('browser_script', { code: 'return 1' }))?.code, 'return 1');
  assert.equal(controlHandoff(wrap('chrome_read_page')), null);
  assert.equal(ownBrowserTool(wrap('chrome_read_page')), null);
  const app = wrap('wrap_up', {}, 'app_more_tools');
  assert.equal(toolLine(app, 'running'), 'Wrapping up');
  const appStep = itemSteps(app as any)[0];
  assert.ok(appStep.kind === 'tool');
  assert.equal(appStep.item.tool, 'wrap_up');
  for (const args of [{ call: 'chrome_read_page' }, { call: 'chrome_read_page', arguments: null }]) {
    assert.deepEqual(toolInvocation({ ...browser, arguments: args }).arguments, {});
  }
});

test('a deferred Chrome screenshot keeps its surface and bytes for the shared saved preview', () => {
  const item = {
    ...wrap('chrome_computer', { tabId: 7, action: 'screenshot' }),
    status: 'completed',
    result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AAA=' }] },
  };
  const detail = stepDetails(item);
  assert.equal(detail.surface, 'chrome');
  assert.equal(detail.thumbnail, 'data:image/png;base64,AAA=');
  assert.match(detail.detail, /"action": "screenshot"/);
  assert.doesNotMatch(detail.detail, /"call"/);
  assert.equal(toolLine(item), 'Took a screenshot');
  assert.equal(controlStep(item)?.done, 'Took a screenshot');
  assert.equal(stepDetails({ ...wrap('browser_navigate'), result: item.result }).surface, undefined);
});

test('actual deferred app actions retain standalone cards, waiting offers and their argument-dependent lines', () => {
  const result = (body: object) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
  const started = {
    ...wrap('start_session', {}, 'app_more_tools'),
    status: 'completed',
    result: result({ status: 'started', chat_id: 'child', title: 'Repair' }),
  };
  assert.equal(toolCard(started)?.kind, 'session');
  assert.equal(isBlockItem(started as any), true);
  const offered = wrap('start_session', { initiation: 'offer', title: 'Repair' }, 'app_more_tools');
  assert.equal(sessionCallLine(offered)?.kind, 'offer');
  assert.deepEqual(turnProposals([offered]), [{ kind: 'proposed', taskId: null, title: 'Repair', offer: true }]);
  const scheduled = {
    ...wrap('run_scheduled_task', { id: 'task' }, 'app_more_tools'),
    status: 'completed',
    result: result({ chatId: 'child' }),
  };
  assert.deepEqual(scheduledTaskCall(scheduled), { action: 'ran', taskId: 'task', chatId: 'child' });
  assert.equal(toolCard(scheduled)?.kind, 'scheduled');
  assert.equal(windowCallLine(wrap('show_pane', { pane: 'file' }, 'app_more_tools'))?.text, 'Opening file');
  assert.equal(ownToolLine(wrap('list_chats', {}, 'app_more_tools'))?.text, 'Listing chats');
});

test('recovery choices, follow-ups and refused app identities read the same nested arguments as narration', () => {
  const blocked = {
    ...wrap('chrome_navigate', { url: 'https://example.com/path' }),
    status: 'failed',
    result: { content: [{ type: 'text', text: '<refusal reason="site_permission_denied">No.</refusal>' }] },
  };
  assert.deepEqual(blockedOf(blocked), blockedOf(toolInvocation(blocked)));
  assert.equal(blockedOf(blocked)?.origin, 'https://example.com');
  assert.ok(blockedOf(blocked)?.choices.includes('allowSite'));
  const doc = wrap('desktop_app_key', { app: 'Notes', combo: 'cmd+n' }, 'desktop_more_tools');
  assert.equal(suggestNextStep([doc]), 'Close the new Notes document without saving');
  const browser = wrap('browser_navigate', { url: 'https://example.com' });
  assert.equal(suggestNextStep([browser]), 'Summarize what you found on example.com');
  const app = wrap('desktop_app_click', { app: 'ai.mopilot.code' }, 'desktop_more_tools');
  const turn: any = { id: 't', status: 'inProgress', items: [app] };
  const refused = [{ name: 'MoPilot', app: 'ai.mopilot.code', reason: 'self' as const }];
  assert.deepEqual(workingEvents(turn, undefined, refused), workingEvents({ ...turn, items: [toolInvocation(app)] }, undefined, refused));
  assert.equal((workingEvents(turn, undefined, refused)[1] as any).refused, true);
});

test('Chrome preview provenance rejects foreign and malformed server identities', () => {
  for (const server of ['maps', 'sage_maps', 'sage_0123456789ab_extra']) {
    const input = { tool: 'chrome_computer', server, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AAA=' }] } };
    assert.equal(stepDetails(input).surface, undefined);
    assert.equal(stepDetails(input).thumbnail, undefined);
  }
});

test('discovery, foreign namespaces and malformed execution inputs retain the original call rather than invent an action', () => {
  const valid = wrap('chrome_navigate');
  const cases: any[] = [
    null,
    undefined,
    [],
    3,
    {},
    { tool: 3 },
    { ...valid, server: 3 },
    { ...valid, server: 'maps' },
    { ...valid, server: 'maps', tool: 'mcp__sage_0123456789ab__browser_more_tools' },
    { ...valid, tool: 'maps/browser_more_tools' },
    { ...valid, server: 'sage_abcdef012345', tool: 'sage_0123456789ab_browser_more_tools' },
    { ...valid, type: 'dynamicToolCall', server: undefined, namespace: 'maps' },
    { ...valid, namespace: 3 },
    { ...valid, namespace: 'sage_abcdef012345' },
    { ...valid, tool: 'mcp__maps__browser_more_tools' },
    { ...valid, server: '', tool: 'maps/browser_more_tools' },
    { ...valid, tool: 'browser_other' },
    ...[
      undefined,
      null,
      [],
      {},
      { load: 'chrome' },
      { call: 3 },
      { call: '' },
      { call: 'chrome-read' },
      { call: 'browser_more_tools' },
      { call: 'desktop_more_tools' },
      { call: 'desktop_type' },
      { call: 'chrome_navigate', arguments: [] },
      { call: 'chrome_navigate', arguments: 3 },
    ].map((arguments_) => ({ ...valid, arguments: arguments_ })),
  ];
  for (const input of cases) assert.equal(toolInvocation(input), input, JSON.stringify(input));
  const discovery = { ...valid, arguments: { load: ['chrome'] } };
  assert.match(toolLine(discovery, 'running'), /Using more_tools/);
  assert.equal(controlSource(discovery), null);
});
