// Native compaction commands and menu picks use the shared semantic action, preserving arguments across every family.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { acpCommands, claudeCommands, codexCommands, composeCommands, resolveTyped, appEntries } from '../src/harness/commands.ts';
import './support/dom.ts';
import { $, $$, mouse } from './support/composer-kit.ts';
import { all, fx, last, mountComposer, reset, settle, setSessionState, store } from './support/composer-setup.ts';

beforeEach(() => reset());

test('declared compact aliases resolve to the shared action while unlisted commands remain text', () => {
  const claude = claudeCommands([{ name: 'compact', aliases: ['squash'], description: 'Compact' }]);
  for (const [provider, text] of [
    [claude, '/squash Keep decisions'],
    [acpCommands('Kimi', [{ name: '/compact', description: 'Compact' }]), '/compact Keep decisions'],
  ] as const) {
    const result = resolveTyped(text, composeCommands(provider));
    assert.equal(result.kind, 'rpc');
    assert.equal((result as any).command.name, 'compact');
    assert.equal((result as any).args, 'Keep decisions');
  }
  assert.equal(resolveTyped('/compact', composeCommands(acpCommands('Kimi', null))).kind, 'passthrough');
  assert.equal(resolveTyped('/compress', composeCommands(claude)).kind, 'passthrough');
});

test('a MoMo literal command remains ordinary input even when the native catalog declares compaction', async () => {
  fx.provider = claudeCommands([{ name: 'compact', description: 'Compact' }]);
  fx.nativeCmds = fx.provider;
  fx.registry = composeCommands;
  fx.resolve = resolveTyped;
  fx.appEntries = appEntries;
  store.set({ harnessOf: { t1: 'claude' }, momoChats: { t1: 'main' } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/compact literal words');
    if ($('.slash-panel')) await m.key('Escape');
    await m.key('Enter');
    await settle();
    assert.equal(last('compact'), undefined);
    assert.deepEqual(last('send'), ['send', 't1', '/compact literal words', [], { plan: false, human: true }]);
  } finally {
    await m.unmount();
  }
});

for (const reason of ['blocked', 'refused']) {
  test(`a ${reason} compaction keeps its typed instructions and attachments for retry`, async () => {
    fx.provider = claudeCommands([{ name: 'compact', description: 'Compact' }]);
    fx.registry = composeCommands;
    fx.resolve = resolveTyped;
    const attachment = { kind: 'file', path: '/notes.txt', name: 'notes.txt' };
    store.set({ drafts: { t1: { text: '/compact Keep decisions', attachments: [attachment] } } });
    if (reason === 'blocked') fx.blocked.compact = 'Compaction is unavailable';
    else fx.compactAnswer = async () => false;
    const m = await mountComposer({ threadId: 't1' });
    try {
      if ($('.slash-panel')) await m.key('Escape');
      await m.key('Enter');
      await settle();
      assert.equal(m.text, '/compact Keep decisions');
      assert.equal($('.attachment-name')!.textContent, 'notes.txt');
      assert.equal(all('send').length, 0);
    } finally {
      await m.unmount();
    }
  });
}
for (const kind of ['codex', 'claude', 'acp']) {
  for (const entry of ['typed', 'typed-empty', 'typed-menu', 'picker']) {
    test(`${kind} ${entry} compaction enters the semantic queue while busy`, async () => {
      const provider =
        kind === 'codex'
          ? codexCommands()
          : kind === 'claude'
            ? claudeCommands([{ name: 'compact', description: 'Summarize context' }])
            : acpCommands('Kimi', [{ name: 'compress', description: 'Summarize context' }]);
      const command = kind === 'acp' ? 'compress' : 'compact';
      fx.provider = kind === 'acp' ? null : provider;
      fx.nativeCmds = kind === 'claude' ? provider : null;
      fx.registry = composeCommands;
      fx.resolve = resolveTyped;
      fx.appEntries = appEntries;
      fx.acpRegistry = composeCommands(provider);
      fx.acpTyped = (text: string) => resolveTyped(text, composeCommands(provider));
      store.set({
        harnessOf: { t1: kind === 'claude' ? 'claude' : 'codex' },
        basicOf: kind === 'acp' ? { t1: 'kimi' } : {},
        runtime: { t1: { activeTurnId: 'running-turn' } },
        prefs: { ...store.get().prefs, followUp: 'steer' },
      });
      setSessionState('t1', { turn: 'running' });
      const m = await mountComposer({ threadId: 't1' });
      try {
        if (entry === 'picker') {
          await m.type(`/${command.slice(0, 4)}`);
          const item = $$('.slash-panel .add-panel-item').find(
            (node) => node.querySelector('.add-panel-title')!.textContent === `/${command}`,
          );
          assert.ok(item);
          await mouse(item, 'mousedown');
          await settle();
          if (m.text.trim()) await m.key('Enter');
        } else {
          await m.type(`/${command}${entry === 'typed' ? ' Keep $$ and $&' : ''}`);
          if (entry === 'typed-menu') assert.ok($('.slash-panel'));
          else if ($('.slash-panel')) await m.key('Escape');
          await m.key('Enter');
          if (entry === 'typed-menu' && kind === 'acp') await m.key('Enter');
        }
        await settle();
        assert.equal(all('send').length, 0, 'native compaction never becomes an ordinary steerable message');
        assert.equal(all('interrupt').length, 0, 'the compaction interaction never stops the current turn');
        assert.equal(all('compact').length, 1);
        assert.deepEqual(last('compact'), ['compact', 't1', entry === 'typed' ? 'Keep $$ and $&' : '']);
        assert.equal(m.text, '');
      } finally {
        await m.unmount();
      }
    });
  }
}
