// A panel page is selected at its own queued native dispatch, with actual controller queues and the shared final adapter input guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';
import { world } from './support/chrome-membership-kit.mjs';
const require = createRequire(import.meta.url);
const { preparePanelTab, selectPanelTab } = require('../electron/capabilities/browser/chromePanelTab.cjs');
const { installHandoffContinuationGuard } = require('../electron/capabilities/browser/handoffContinuation.cjs');
const { assertInputCurrent } = require('../electron/session/contract/inputGuard.cjs');
for (const kind of ['codex', 'claude', 'acp:kimi']) {
  test(`${kind}: queued messages select their own existing tabs only on dispatch and retire their adapter guard on loss`, async (t) => {
    const h = setup();
    const w = world();
    t.after(() => {
      w.tabs.dispose();
      fs.rmSync(h.chats.dir, { recursive: true, force: true });
    });
    h.chats.records.set('chat', { id: 'chat', segments: [{ kind, nativeId: 'native' }] });
    const live: any = {
      controller: h.c,
      sessions: h.state,
      controllerPlans: {
        snapshot: () => ({ key: h.c.ref('chat').key, plan: { bu: 'mopilot-chrome' }, chromeToolName: 'chrome_tabs_context_mcp' }),
      },
      chromeRelay: { kind: 'extension', tabs: w.tabs, relay: w.relay },
    };
    installHandoffContinuationGuard(live, () => 'extension');
    const first = w.chrome.addTab({ url: 'https://example.org/first' });
    const one = await preparePanelTab(live, 'chat', 'First', await w.sessions.admissions.offer(first.id));
    const initial = w.tabs.chats.get('chat').selected;
    h.state.patch('chat', { turn: 'running', activeTurn: { id: 'old-turn', human: true } });
    const second = w.chrome.addTab({ url: 'https://example.org/second' });
    const two = await preparePanelTab(live, 'chat', 'Second', await w.sessions.admissions.offer(second.id));
    assert.equal(w.tabs.chats.get('chat').selected, initial, 'admission cannot retarget the preceding turn');
    const queued = h.c.send('chat', { text: two.text, opts: { human: true, chromePanelTab: two.target } }, 1);
    assert.equal(queued.action, 'queued');
    assert.equal(h.execs.length, 0);
    h.c.end('chat', { drain: false });
    const delivered = await h.c.sendNow('chat', queued.id, 1, true);
    assert.equal(delivered.status, 'sent');
    assert.equal(w.tabs.chats.get('chat').selected, two.target.hostId);
    assert.equal(h.execs.length, 1);
    assertInputCurrent(h.execs[0].item);
    w.move(second.id, -1);
    assert.throws(() => assertInputCurrent(h.execs[0].item), /no longer available/);
    selectPanelTab(live, 'chat', { opts: {} });
    for (const target of [null, {}, { ...one.target, membership: 'retired' }])
      assert.throws(() => selectPanelTab(live, 'chat', { opts: { chromePanelTab: target } }), /no longer available/);
  });
}
