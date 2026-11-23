// Standard forms are wired into trusted session IPC, the preload bridge and the composer without replacing approvals.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './support/dom.ts';
import { setup } from './support/controller/fixture.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
const require = createRequire(import.meta.url);
let momoChat = false;
const components: any = {
  '../src/components/momo/useMomoChat.ts': { useMomoChat: () => momoChat },
  '../src/components/composer/Composer.tsx': { Composer: () => h('span', null, 'composer') },
  '../src/components/thread/Approvals.tsx': { Approvals: () => h('span', null, 'approval') },
  '../src/components/thread/DockedQuestions.tsx': { DockedQuestions: () => null },
  '../src/components/thread/ElsewhereNotice.tsx': { ElsewhereNotice: () => null },
  '../src/components/thread/StatusStrip.tsx': { StatusStrip: () => null },
  '../src/components/tasks/TaskPolling.tsx': { TaskPolling: () => null },
  '../src/components/thread/PrMonitorAlerts.tsx': { PrMonitorAlerts: () => null },
  '../src/components/thread/NeedsYouStrip.tsx': { NeedsYouStrip: () => null },
  '../src/components/thread/WorkingIn.tsx': { WorkingInStack: () => null },
  '../src/components/browser/ClaudeInChromeNote.tsx': { ClaudeInChromeNote: () => null },
  '../src/components/thread/HarnessDownNotice.tsx': { HarnessDownNotice: () => null, useDownHarness: () => null },
  '../src/components/ui/icons.tsx': { Lock: () => null },
  '../src/components/thread/AcpQuestions.tsx': {
    AcpQuestions: (p: any) => h('span', null, p.readOnly ? 'read-only question' : 'question'),
  },
};
for (const [file, namedExports] of Object.entries(components)) mock.module(file, { namedExports: namedExports as any });
const { ComposerArea } = await import('../src/components/thread/ComposerArea.tsx');
const roots: any[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = '';
});

test('composer entrypoint shows questions alongside normal composer or permissions and restricts read-only panes', async () => {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  roots.push(root);
  for (const [readOnly, inPane, hasApproval, composer] of [
    [false, false, false, true],
    [false, false, true, true],
    [true, false, false, false],
    [false, true, false, true],
  ]) {
    await act(async () => root.render(h(ComposerArea, { threadId: 'chat', cwd: '/work', readOnly, inPane, hasApproval, composer })));
    assert.match(el.textContent!, readOnly || inPane ? /read-only question/ : /question/);
    if (!readOnly) assert.match(el.textContent!, hasApproval ? /approval/ : /composer/);
  }
  // MoMo's chat sits in a pane but is the chat's own view (#2279): its questions are answered there
  momoChat = true;
  await act(async () =>
    root.render(h(ComposerArea, { threadId: 'momo', cwd: '/momo', readOnly: false, inPane: true, hasApproval: false, composer: true })),
  );
  assert.match(el.textContent!, /^question/);
  await act(async () =>
    root.render(h(ComposerArea, { threadId: 'momo', cwd: '/momo', readOnly: true, inPane: true, hasApproval: false, composer: false })),
  );
  assert.match(el.textContent!, /read-only question/, 'a read-only MoMo view (Ask MoMo) still is');
  momoChat = false;
  const threadId = `acp:kimi:side-chat-${crypto.randomUUID()}`;
  const side = { threadId, cwd: '/work', inPane: true, hasApproval: false, composer: true };
  await act(async () => root.render(h(ComposerArea, { ...side, readOnly: false })));
  assert.match(el.textContent!, /^question/);
  await act(async () => root.render(h(ComposerArea, { ...side, readOnly: true })));
  assert.match(el.textContent!, /read-only question/);
});

test('real session registration exposes the guarded operation and preload declares its three bounded arguments', () => {
  const { register } = require('../electron/app/ipc/sessions.cjs');
  const handlers = new Map();
  const sender = { id: 1 };
  const { c: controller } = setup();
  const controllerPlans = { snapshot: () => ({ chromeToolName: 'chrome_tabs_context_mcp' }) };
  const chromeHandoffRoute = () => 'extension';
  register(
    { handle: (name: string, handler: any) => handlers.set(name, handler), on() {} },
    {
      execWindows: new Set([sender]),
      viewedBy: new Map([[1, { visible: ['chat'], focused: 'chat' }]]),
      chromeHandoffRoute,
      live: { controller, controllerPlans, peerRuntime: { registerIpc() {} }, acpHost: { questions: { owner: () => null } } },
    },
  );
  assert.equal(typeof controller.chromeContinuationCheck, 'function');
  assert.doesNotThrow(() => controller.chromeContinuationCheck({ chatId: 'chat', item: { opts: {} } }));
  assert.throws(
    () => controller.chromeContinuationCheck({ chatId: 'chat', item: { opts: { chromeHandoff: {} } } }),
    /Invalid Chrome continuation/,
  );
  const { handoffContinuation } = require('../electron/capabilities/browser/handoffContinuation.cjs');
  const fresh = handoffContinuation({ controller, controllerPlans }, chromeHandoffRoute, 'chat', 'https://site.test/');
  const item = { opts: { chromeHandoff: fresh.precondition } };
  assert.doesNotThrow(() => controller.chromeContinuationCheck({ chatId: 'chat', item }));
  controller.ref = () => ({ kind: 'claude', id: 'replacement', key: 'replacement' });
  assert.throws(() => controller.chromeContinuationCheck({ chatId: 'chat', item }), /controller changed/);
  assert.deepEqual(handlers.get('session:answerQuestion')({ sender }, 'chat', 'absent', { action: 'cancel' }), { status: 'retired' });
  const bridge = require('../electron/bridge/session.cjs');
  assert.equal(bridge.answerQuestion.channel, 'session:answerQuestion');
});
