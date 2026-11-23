import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { voiceUnavailable, VOICE_UNAVAILABLE } = await import('../src/session/voiceAccess.ts');
const { startVoice } = createRequire(import.meta.url)('../electron/session/voice.cjs');

test('voice access asks about the current chat and returns the capability reason', async () => {
  const reads: any[] = [];
  const native: any = { kind: 'codex', caps: { voiceChat: { state: 'native' } } };
  assert.equal(
    await voiceUnavailable('chat', async (...args) => {
      reads.push(args);
      return native;
    }),
    null,
  );
  assert.deepEqual(reads, [['chat', {}]]);
  assert.equal(await voiceUnavailable(null, async () => null), VOICE_UNAVAILABLE);
  assert.equal(await voiceUnavailable(null, async () => ({ kind: 'codex', caps: {} }) as any), VOICE_UNAVAILABLE);
  assert.equal(
    await voiceUnavailable('claude-chat', async () => ({ kind: 'claude', caps: { voiceChat: { state: 'native' } } }) as any),
    null,
  );
  const blocked: any = {
    kind: 'codex',
    caps: { voiceChat: { state: 'disabled', why: { layer: 'account', code: 'account.voiceChatRequiresChatGPT' } } },
  };
  assert.match((await voiceUnavailable(null, async () => blocked))!, /signed-in ChatGPT account/);
  blocked.kind = 'acp:fake';
  blocked.caps.voiceChat.why = { layer: 'harness', code: 'harness.noVoiceConversation' };
  assert.match((await voiceUnavailable(null, async () => blocked))!, /voice/);
  blocked.provider = { label: 'Custom' };
  blocked.caps.voiceChat.why = { layer: 'provider', code: 'provider.unsupported' };
  assert.equal(await voiceUnavailable(null, async () => blocked), "Custom doesn't support voice chat");
});

test('main sends voice start only for the current native Codex segment', async () => {
  const seen: any[] = [];
  const params = { threadId: 'later-native-thread', transport: { type: 'webrtc', sdp: 'offer' } };
  const codex = {
    serverObservers: new Set(),
    pin() {},
    ensureResumed: async (threadId: string) => void seen.push(['ensureResumed', threadId]),
    applyPermission: async (chatId: string, threadId: string) => void seen.push(['applyPermission', chatId, threadId]),
    request: async (...args: any[]) => {
      seen.push(args);
      return { accepted: true };
    },
  };
  const result = await startVoice(
    {
      controller: {
        state: { get: () => ({ turn: 'idle', queue: [] }) },
        drain() {},
        chatOf: (id: string) => {
          seen.push(['alias', id]);
          return 'stable-chat';
        },
        ref: (id: string) => {
          seen.push(['ref', id]);
          return { kind: 'codex', key: 'later-native-thread' };
        },
        adapterFor: (kind: string) => (kind === 'codex' ? codex : null),
      },
      caps: {
        get: async (id: string) => {
          seen.push(['caps', id]);
          return { kind: 'codex', caps: { voiceChat: { state: 'native' } } };
        },
      },
      codex,
    },
    params,
  );
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(seen, [
    ['alias', 'later-native-thread'],
    ['caps', 'stable-chat'],
    ['ref', 'stable-chat'],
    // the turns a voice session delegates run on the thread's settings: the chat's permission goes on first
    ['ensureResumed', 'later-native-thread'],
    ['applyPermission', 'stable-chat', 'later-native-thread'],
    ['thread/realtime/start', params],
  ]);
});

test('main rejects unavailable capabilities, stale segments and invalid input without sending', async () => {
  for (const [ref, available, params] of [
    [null, null, null],
    [{ kind: 'claude', key: 'native' }, null, { threadId: 'native' }],
    [{ kind: 'codex', key: 'other' }, null, { threadId: 'native' }],
    [{ kind: 'codex', key: 'native' }, null, { threadId: 'native' }],
    [{ kind: 'codex', key: 'native' }, { kind: 'claude' }, { threadId: 'native' }],
    [{ kind: 'codex', key: 'native' }, { kind: 'codex', caps: { voiceChat: { state: 'disabled' } } }, { threadId: 'native' }],
    // a segment whose adapter isn't Codex's never reaches Codex's app-server, whatever its capabilities say
    [{ kind: 'claude', key: 'native' }, { kind: 'claude', caps: { voiceChat: { state: 'native' } } }, { threadId: 'native' }],
    [{ kind: 'acp:kimi', key: 'native' }, { kind: 'acp:kimi', caps: { voiceChat: { state: 'native' } } }, { threadId: 'native' }],
  ]) {
    const codex = { request: () => assert.fail('must not send') };
    await assert.rejects(
      startVoice(
        {
          controller: { chatOf: (id: string) => id, ref: () => ref, adapterFor: (kind: string) => (kind === 'codex' ? codex : {}) },
          caps: { get: async () => available },
          codex,
        },
        params,
      ),
      /unavailable/,
    );
  }
  let ref: any = { kind: 'codex', key: 'native' };
  await assert.rejects(
    startVoice(
      {
        controller: { chatOf: (id: string) => id, ref: () => ref, adapterFor: () => ({}) },
        caps: {
          get: async () => {
            ref = { kind: 'acp:kimi', key: 'different' };
            return { kind: 'codex', caps: { voiceChat: { state: 'native' } } };
          },
        },
        codex: { request: () => assert.fail('must not send') },
      },
      { threadId: 'native' },
    ),
    /unavailable/,
  );
});
