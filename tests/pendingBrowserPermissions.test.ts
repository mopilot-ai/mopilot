// Browser origin approvals: credential, downgrade and pending permission races.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { OriginGrants } = createRequire(import.meta.url)('../electron/capabilities/browser/origins.cjs');
const ctx = { chatId: 'chat', segmentId: 'segment' };
const url = 'https://example.com/page';

test('a write approved after the chat becomes Read only is refused; reads still work', async () => {
  for (const need of ['write', 'read']) {
    let anchor = 'ask';
    const grants = new OriginGrants({
      anchor: () => anchor,
      ask: async () => {
        anchor = 'readOnly';
        return { decision: 'allow', scope: 'once', level: need };
      },
    });
    if (need === 'write') await assert.rejects(grants.require(url, need, ctx), { code: 'read_only' });
    else await grants.require(url, need, ctx);
  }
});

test('a sensitive action approved after a Read only mode change cannot run', async () => {
  let anchor = 'ask';
  const grants = new OriginGrants({
    anchor: () => anchor,
    ask: async () => null,
    confirmAction: async () => {
      anchor = 'readOnly';
      return true;
    },
  });
  await assert.rejects(grants.act(url, ctx, { tool: 'click', sensitive: { verb: 'delete' } }), { code: 'read_only' });
});

test('action checks enforce Read only before asking for any confirmation', async () => {
  const grants = new OriginGrants({
    anchor: () => 'readOnly',
    ask: async () => assert.fail('must not ask'),
    confirmAction: async () => assert.fail('must not confirm'),
  });
  await assert.rejects(grants.act(url, ctx), { code: 'read_only' });
});
