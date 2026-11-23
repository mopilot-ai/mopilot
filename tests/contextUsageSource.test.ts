// The real Codex adapter attributes context to the native thread before canonical-chat mapping.
import { test, assert, setup } from './support/codex-adapter/fixture.ts';
test('mapped and unmapped Codex usage always names its actual native sender', () => {
  for (const [chatId, nativeId] of [
    ['canonical', 'native'],
    ['own', 'own'],
  ]) {
    const { server, events } = setup({}, { segments: { [chatId]: nativeId } });
    server.notify('thread/tokenUsage/updated', {
      threadId: nativeId,
      turnId: 'turn',
      tokenUsage: { last: { totalTokens: 80 } },
      tokenUsageSource: { harness: 'claude', nativeId: 'forged' },
    });
    const event = events.at(-1)!.e;
    assert.equal(event.chatId, chatId);
    assert.equal(event.params.threadId, chatId);
    assert.deepEqual(event.params.tokenUsageSource, { harness: 'codex', nativeId });
  }
});
