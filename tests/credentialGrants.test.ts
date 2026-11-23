// Browser origin approvals: credential, downgrade and pending permission races.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { OriginGrants } = createRequire(import.meta.url)('../electron/capabilities/browser/origins.cjs');
const ctx = { chatId: 'chat', segmentId: 'segment' };
const url = 'https://user:secret@example.com/page';

test('credential permission previews agree with required access even under Full access and saved grants', async () => {
  for (const anchor of ['full', 'ask']) {
    let prompts = 0;
    const grants = new OriginGrants({
      anchor: () => anchor,
      ask: async () => {
        prompts++;
        return { decision: 'deny' };
      },
    });
    grants.grants.set('https://example.com', 'write');
    assert.equal(grants.peek(url, 'read', ctx), 'ask');
    assert.equal(grants.peek(url, 'write', ctx), 'ask');
    await assert.rejects(grants.require(url, 'read', ctx), { code: 'denied' });
    assert.equal(grants.peek(url, 'read', ctx), 'denied');
    await assert.rejects(grants.require(url, 'read', ctx), { code: 'denied' });
    assert.equal(prompts, 1);
  }
});

test('a Read only answer overrides an older saved write grant for the current turn', async () => {
  for (const anchor of ['full', 'ask']) {
    let prompts = 0;
    let level = 'read';
    const grants = new OriginGrants({
      anchor: () => anchor,
      ask: async () => {
        prompts++;
        return { decision: 'allow', scope: 'chat', level };
      },
    });
    grants.grants.set('https://example.com', 'write');
    await assert.rejects(grants.require(url, 'write', ctx), { code: 'read_only' });
    assert.equal(grants.peek(url, 'write', ctx), 'read_only');
    await assert.rejects(grants.require(url, 'write', ctx), { code: 'read_only' });
    assert.equal(prompts, 1);
    assert.equal(grants.get('https://example.com'), 'write');
    assert.equal(grants.peek(url, 'write', { ...ctx, chatId: 'other' }), 'ask');
    grants.turnEnded(ctx.chatId);
    assert.equal(grants.peek(url, 'write', ctx), 'reask');
    level = 'write';
    await grants.require(url, 'write', ctx);
    assert.equal(prompts, 2);
    assert.equal(grants.peek(url, 'write', ctx), 'ask');
  }
});

test('credential URLs cannot share the approval of an ordinary URL on the same origin', async () => {
  const prompts: any[] = [];
  const grants = new OriginGrants({
    ask: async (request: any) => {
      prompts.push(request);
      return request.risk?.credentials ? { decision: 'deny' } : { decision: 'allow', scope: 'once', level: 'read' };
    },
  });
  const [plain, credential] = await Promise.allSettled([
    grants.require('https://example.com/page', 'read', ctx),
    grants.require(url, 'read', ctx),
  ]);
  assert.equal(plain.status, 'fulfilled');
  assert.equal(credential.status, 'rejected');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].risk.credentials, true);
  assert.equal(prompts[1].allowAlways, false);
});

test('high-risk pages cannot reuse ordinary origin approval', async () => {
  const { SiteRisk } = createRequire(import.meta.url)('../electron/capabilities/browser/siteRisk.cjs');
  const risk = new SiteRisk({ data: { pages: [{ host: 'example.com', path: '/secure', category: 'account_security' }] } });
  const prompts: any[] = [];
  const grants = new OriginGrants({
    risk,
    ask: async (request: any) => {
      prompts.push(request);
      return request.risk ? { decision: 'deny' } : { decision: 'allow', scope: 'always', level: 'read' };
    },
  });
  const [plain, secure] = await Promise.allSettled([
    grants.require('https://example.com/page', 'read', ctx),
    grants.require('https://example.com/secure', 'read', ctx),
  ]);
  assert.equal(plain.status, 'fulfilled');
  assert.equal(secure.status, 'rejected');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].risk.category, 'account_security');
  // the risky page's card shows its risk class; it may be saved for good there (#5464)
  assert.equal(prompts[1].allowAlways, undefined);
});
