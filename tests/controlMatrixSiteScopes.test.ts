// CM-P25, CM-P26: what a site card covers and when it asks again (#1319 G22 and the scope decision in design.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/capabilities/', 'shared/'];

const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const ctx = { chatId: 'chat', segmentId: 'segment' };

test('CM-P25: a site allowed for reading (in Settings, for good or for the chat) asks about a write instead of refusing it; Read only again refuses the turn (#1319 G22)', async () => {
  const { readOnlyNote } = require('../electron/capabilities/browser/origins.cjs');
  const asked: any[] = [];
  let answer: any = { decision: 'allow', scope: 'once', level: 'read' };
  const g = new OriginGrants({ ask: async (q: any) => (asked.push(q), answer) });
  g.set('https://d.test', 'read');
  // the card offers writing; Read only again: refused with the advice, and no second card this turn
  await assert.rejects(
    g.require('https://d.test/', 'write', ctx),
    (e: any) => e.code === 'read_only' && e.message === readOnlyNote('https://d.test'),
  );
  assert.deepEqual([asked.length, asked[0].need], [1, 'write']);
  await assert.rejects(g.require('https://d.test/x', 'write', ctx), { code: 'read_only' });
  assert.equal(asked.length, 1);
  // the next turn asks again, and a yes for the chat lets writes through while the site stays read for good
  g.turnEnded(ctx.chatId);
  answer = { decision: 'allow', scope: 'chat', level: 'write' };
  await g.require('https://d.test/', 'write', ctx);
  assert.equal(asked.length, 2);
  assert.equal(g.peek('https://d.test/', 'write', ctx), 'ok');
  assert.equal(g.get('https://d.test'), 'read');
  // the same for a site read only for the chat (a Read only answer "for this chat")
  g.chatGrants.set('c2', new Map([['https://e.test', 'read']]));
  answer = { decision: 'allow', scope: 'once', level: 'write' };
  await g.require('https://e.test/', 'write', { ...ctx, chatId: 'c2' });
  assert.equal(asked.length, 3);
});

test('CM-P26: Auto, like Full access, opens an ordinary site without a card; a risky site and a URL with credentials still ask, and sensitive actions still confirm', async () => {
  let asks = 0;
  const confirmed: any[] = [];
  const g = new OriginGrants({
    anchor: () => 'auto',
    ask: async () => (++asks, { decision: 'allow', scope: 'once', level: 'write' }),
    confirmAction: async (q: any) => (confirmed.push(q), true),
  });
  await g.require('https://ordinary.test/', 'write', ctx);
  assert.equal(g.peek('https://ordinary.test/x', 'write', ctx), 'ok');
  assert.equal(asks, 0);
  assert.equal(g.get('https://ordinary.test'), null, "no grant is saved: Auto is the chat's mode");
  await g.require('https://user:pw@ordinary.test/', 'read', ctx);
  assert.equal(asks, 1, 'a URL with credentials asks in every mode');
  // a sensitive action asks in Auto (only Full access covers the ordinary ones)
  await g.act('https://ordinary.test/', ctx, { sensitive: { verb: 'delete' } });
  assert.equal(confirmed.length, 1);
});

test('CM-P28: a write on a site allowed for reading, answered Read and write once, goes through, its own re-checks included; the next call asks again (#1319 G22, found in the dev app)', async () => {
  const { world } = await import('./support/browser-host-tools/fixture.ts');
  const w = world();
  w.grants.set('https://r.example', 'read');
  w.tabs.tab.url = 'https://r.example/';
  w.st.answer = { decision: 'allow', scope: 'once', level: 'write' };
  await w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] });
  assert.equal(w.tabs.called('click').length, 1, 'the click ran after the yes');
  assert.equal(w.st.asks.length, 1);
  // "once" covered that call only: the next write asks again
  await w.call('browser_computer', { action: 'left_click', coordinate: [2, 2] });
  assert.equal(w.st.asks.length, 2);
  // a site that drops to read only while a call runs (no card in that call) is refused at the re-check
  w.tabs.impl.intent = async () => (w.grants.set('https://r.example', 'read'), null);
  w.st.answer = { decision: 'allow', scope: 'chat', level: 'write' };
  w.grants.chatGrants.delete(w.ctx.chatId);
  w.grants.set('https://r.example', 'write');
  await assert.rejects(w.call('browser_computer', { action: 'left_click', coordinate: [3, 3] }), { code: 'read_only' });
  assert.equal(w.tabs.called('click').length, 2, 'nothing clicked after the site dropped to read only');
});
