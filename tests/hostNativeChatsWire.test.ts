// The wire words of native sessions on a Host (#5576, Phase 4): the row id, the origins a list takes, what each request needs of its peer, and a Host that was not built to find them (flag `hosts.nativeSessions`, off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helloParams, negotiate, parseParams, requireFeatures } from '../shared/host/schema.mjs';
import { hostIdOfNative, nativeChatId, nativeNeeds, parseNativeChatId, wantsNative } from '../shared/host/nativeChats.mjs';
import { offeredFeatures } from '../host/src/offeredFeatures.mjs';
import { FLAG_DEFS } from '../shared/flagDefs.mjs';

const UUID = '3f9b6c1e-0000-4000-8000-123456789abc';

test('a native row id names the family and the agent’s own id, and nothing else parses as one', () => {
  assert.equal(nativeChatId('claude', UUID), `native:claude:${UUID}`);
  assert.deepEqual(parseNativeChatId(`native:codex:${UUID}`), { family: 'codex', id: UUID });
  for (const bad of [
    undefined,
    null,
    7,
    '',
    UUID,
    `claude:${UUID}`,
    'native:',
    'native:claude',
    'native:claude:',
    `native:kimi:${UUID}`,
    'native:claude:../etc/passwd',
    'native:claude:a/b',
    'native:claude: a',
    `native:claude:${'x'.repeat(129)}`,
  ])
    assert.equal(parseNativeChatId(bad), null, String(bad));
  assert.equal(hostIdOfNative('claude', UUID), `claude:${UUID}`);
  assert.equal(hostIdOfNative('codex', UUID), UUID, 'a Codex thread is bare on a Host');
});

test('a list takes an origin, host by default, and asks the peer for the feature only when native rows are wanted', () => {
  assert.deepEqual(parseParams('host.chats', { limit: 5 }), { limit: 5 });
  assert.deepEqual(parseParams('host.chats', { limit: 5, origin: 'host' }), { limit: 5 }, 'the default is not sent on');
  assert.deepEqual(parseParams('host.chats', { origin: 'native' }), { limit: 200, origin: 'native' });
  assert.equal((parseParams('host.chats', { origin: 'all' }) as any).origin, 'all');
  for (const origin of ['everything', 3, null, ''])
    assert.throws(() => parseParams('host.chats', { origin }), /native sessions/, String(origin));
  assert.equal(wantsNative('native') && wantsNative('all') && !wantsNative('host') && !wantsNative(undefined), true);
  assert.deepEqual(nativeNeeds('host.chats', { origin: 'native' }), ['nativeList']);
  assert.deepEqual(nativeNeeds('host.chats', { limit: 3 }), []);
  assert.deepEqual(nativeNeeds('chat.send', { origin: 'native' }), []);

  assert.deepEqual(parseParams('host.chats.watch', {}), {});
  assert.deepEqual(parseParams('host.chats.watch', { native: true }), { native: true });
  assert.deepEqual(parseParams('host.chats.watch', { native: false }), {});
  assert.throws(() => parseParams('host.chats.watch', { native: 'yes' }), /choice of events/);
  assert.deepEqual(nativeNeeds('host.chats.watch', { native: true }), ['nativeEvents']);
  assert.deepEqual(nativeNeeds('host.chats.watch', {}), []);
});

test('a Host without the feature is refused a native list and a native watch, and still serves the plain ones', () => {
  const agreed = { minor: 1, features: ['chatList', 'chatPaging', 'chatEvents'] };
  requireFeatures('host.chats', agreed, { limit: 5 } as any);
  requireFeatures('host.chats.watch', agreed, {});
  for (const [method, params, lacks] of [
    ['host.chats', { origin: 'native' }, 'nativeList'],
    ['host.chats', { origin: 'all' }, 'nativeList'],
    ['host.chats.watch', { native: true }, 'nativeEvents'],
  ] as const)
    assert.throws(
      () => requireFeatures(method, agreed, params),
      (e: any) => e.code === 'feature_missing' && e.message.includes(lacks),
      `${method} ${JSON.stringify(params)}`,
    );
  requireFeatures('host.chats', { ...agreed, features: [...agreed.features, 'nativeList'] }, { origin: 'all' });
});

test('the hello offers the two features only to a Host built with the option, and the flag is off by default', () => {
  const all = helloParams({ switching: false, continueFamilies: false }).features;
  assert.ok(all.includes('nativeList') && all.includes('nativeEvents'));
  const without = offeredFeatures(all, { dataDir: '/d' });
  assert.equal(without.includes('chatList'), true);
  assert.equal(without.includes('nativeList') || without.includes('nativeEvents'), false);
  const withOption = offeredFeatures(all, { dataDir: '/d', nativeSessions: {} });
  assert.ok(withOption.includes('nativeList') && withOption.includes('nativeEvents'));
  assert.equal(offeredFeatures(all, { nativeSessions: {} }).includes('nativeList'), false, 'no data directory, no list of any kind');
  const flag = FLAG_DEFS.find((f: any) => f.key === 'hosts.nativeSessions') as any;
  assert.equal(flag?.default, false);
  assert.equal(flag?.mode, 'toggle');
  // an agreement with a client that never named them has neither
  const hello = helloParams({ switching: false, continueFamilies: false });
  const agreed = negotiate({ ...hello, features: withOption }, { ...hello, features: ['chatList'] });
  assert.equal(agreed.features.includes('nativeList'), false);
});
