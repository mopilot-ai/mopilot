// The control matrix's ACP column (docs/control-plane/matrix.md, #1319): the in-app browser (IAB), computer use (CU)
// and the user's Chrome (BU) on a basic-tier (ACP) chat, through the tool channel main gives the harness in
// session/new: sage-mcp over the tool socket, or main's http endpoint for a harness that takes no stdio MCP server
// (Copilot CLI). Case ids (CM-K..) start every title. The Registry, the visibility rule, the tool socket, the http
// endpoint, SessionMcp and the controller plan are real; the tools' executors are fakes that record who called them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpSession, BU, CU, IAB, world } from './support/control-matrix-kit.ts';
import { decidePlan } from '../shared/controllerPlan.mjs';

export const GUARDS = ['electron/capabilities/', 'electron/harness/', 'electron/platform/', 'electron/session/', 'shared/'];

const text = (r: any) => r?.content?.[0]?.text ?? '';
const ACP_PLAN = (tools: string[], yourChrome: boolean) =>
  decidePlan({ channel: true, tools, yourChrome, vendor: { chrome: null, computer: null } });

test('CM-K19: IAB × ACP: browser_* reach an ACP chat over sage-mcp and over http, run, and are charged to the chat', async () => {
  for (const http of [false, true]) {
    const w = world();
    const acp = await acpSession(w, { chatId: 'acp-1', http });
    assert.ok((await acp.list()).includes(IAB), `listed (${http ? 'http' : 'stdio'})`);
    assert.equal(text(await acp.call(IAB, { url: 'https://example.com' })), `ran ${IAB}`);
    assert.deepEqual(w.calls.at(-1), { tool: IAB, chatId: 'acp-1', segmentId: 'acp-seg' });
  }
  // over http, a harness that takes no stdio server (Copilot CLI) sees the same tools as sage-mcp gives one that does
  const w = world();
  assert.deepEqual(await (await acpSession(w, { http: true })).list(), await (await acpSession(w)).list());
});

test('CM-K20: IAB × ACP: Stop lets go of a running browser_* call at once, and the call after it runs', async () => {
  const w = world();
  const acp = await acpSession(w, { chatId: 'acp-2' });
  w.hold(IAB);
  const running = acp.call(IAB, {});
  await new Promise((r) => setTimeout(r, 20));
  // Stop on an ACP chat: acpCancel → interrupting → the Registry aborts the chat's calls (controller.cjs)
  w.r.abortChat('acp-2', 'stopped');
  const r = await running;
  assert.equal(r.isError, true);
  assert.notEqual(text(r), `ran ${IAB}`);
  w.release(IAB);
  // tabs_context is deferred (G11): run it through the more tool
  assert.equal(text(await acp.call('browser_more_tools', { call: 'browser_tabs_context', arguments: {} })), 'ran browser_tabs_context');
});

test('CM-K21: IAB × ACP: browser_* switched off live leave the list, a call is refused with the reason, and the pane has one controller', async () => {
  const w = world();
  const acp = await acpSession(w);
  w.flags['shared.browser.parityTools'] = false;
  const names = await acp.list();
  assert.ok(!names.includes(IAB));
  assert.ok(names.includes(BU), 'the older sage_browser_* drive the pane again');
  const r = await acp.call(IAB, {});
  assert.equal(r.isError, true);
  assert.match(text(r), /unavailable: Browser control is turned off for these tools/);
  assert.equal(ACP_PLAN(names, false).iab, 'mopilot-browser');
});

test('CM-K22: CU × ACP: desktop_* reach an ACP chat (computer_* hidden while desktop_* are on), run and are charged to the chat', async () => {
  for (const http of [false, true]) {
    const w = world();
    const acp = await acpSession(w, { chatId: 'acp-cu', http });
    const names = await acp.list();
    assert.ok(names.includes(CU));
    assert.ok(!names.includes('computer_click'), 'one computer-use controller');
    assert.equal(text(await acp.call(CU, { coordinate: [1, 1] })), `ran ${CU}`);
    assert.deepEqual(w.calls.at(-1), { tool: CU, chatId: 'acp-cu', segmentId: 'acp-seg' });
    assert.equal(ACP_PLAN(names, false).cu, 'mopilot-computer');
  }
});

test('CM-K23: CU × ACP: when computer use can’t work on this Mac, desktop_* leave the list and a call says why', async () => {
  const w = world();
  const acp = await acpSession(w);
  w.state.computerUnavailable = 'MoPilot Computer Use needs Accessibility';
  const names = await acp.list();
  assert.ok(!names.some((n) => n.startsWith('desktop_') || n.startsWith('computer_')));
  const r = await acp.call(CU, {});
  assert.equal(r.isError, true);
  assert.match(text(r), /Accessibility/);
  assert.equal(ACP_PLAN(names, false).cu, null);
});

test('CM-K24: CU × ACP: Esc or Stop lets go of a running desktop_* call; another chat’s call keeps running', async () => {
  const w = world();
  const mine = await acpSession(w, { chatId: 'acp-a' });
  const other = await acpSession(w, { chatId: 'acp-b' });
  w.hold(CU);
  const a = mine.call(CU, {});
  const b = other.call(CU, {});
  await new Promise((r) => setTimeout(r, 20));
  w.r.abortChat('acp-a', 'stopped');
  assert.equal((await a).isError, true);
  w.release(CU);
  assert.equal(text(await b), `ran ${CU}`);
});

test('CM-K25: BU × ACP: with Your Chrome as the channel an ACP chat gets its sage_browser_* for the user’s Chrome, and the plan names it', async () => {
  for (const http of [false, true]) {
    const w = world();
    w.state.yourChrome = true;
    const acp = await acpSession(w, { chatId: 'acp-bu', http });
    const names = await acp.list();
    assert.ok(names.includes(BU));
    assert.equal(text(await acp.call(BU, { url: 'https://example.com' })), `ran ${BU}`);
    assert.deepEqual(w.calls.at(-1), { tool: BU, chatId: 'acp-bu', segmentId: 'acp-seg' });
    // no vendor runtime controls Chrome on ACP: MoPilot's own tools do
    assert.equal(ACP_PLAN(names, true).bu, 'your-chrome');
  }
});

test('CM-K26: BU × ACP: with the built-in channel nothing an ACP chat is shown drives the user’s Chrome', async () => {
  const w = world();
  const acp = await acpSession(w);
  const names = await acp.list();
  // browser_* are on: the older sage_browser_* are hidden (they would drive the same pane, never Chrome)
  assert.ok(!names.includes(BU));
  assert.equal(ACP_PLAN(names, false).bu, null);
  const r = await acp.call(BU, {});
  assert.equal(r.isError, true);
});

test('CM-K27: BU × ACP: the channel flipped while the ACP session runs changes what it is shown at its next list, never two Chrome controllers', async () => {
  const w = world();
  const acp = await acpSession(w);
  assert.ok(!(await acp.list()).includes(BU));
  w.state.yourChrome = true;
  const after = await acp.list();
  assert.ok(after.includes(BU));
  assert.equal(after.filter((n) => n.startsWith('chrome_')).length, 0, 'no second controller of Chrome');
  w.state.yourChrome = false;
  assert.ok(!(await acp.list()).includes(BU));
});
