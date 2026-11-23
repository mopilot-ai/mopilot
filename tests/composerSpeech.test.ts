// Composer speech controls: the voice conversation button starts at once where the chat declares it, and preserves draft
// ownership while its preparation is pending.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click } from './support/composer-kit.ts';
import { all, fx, last, mountComposer, reset, settle, setVoice, store } from './support/composer-setup.ts';
import { act } from 'react';
beforeEach(() => reset());

test('voice: explicit conversation starts in this chat; errors leave the draft visible', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    const btn = () => $('.send-btn.voice');
    assert.equal(btn().getAttribute('title'), null);
    await click(btn());
    assert.deepEqual(last('startVoice'), ['startVoice', 't1']);
    await setVoice({ phase: 'listening', threadId: 't1' });
    assert.ok($('.voice-bar'));
    assert.match(m.editor().className, /voice-hidden/);
    assert.equal(btn().getAttribute('aria-label'), 'End voice');
    await click(btn());
    assert.ok(last('stopVoice'));
    await setVoice({ phase: 'listening', threadId: 'other' });
    assert.ok(!$('.voice-bar'));
  } finally {
    await m.unmount();
  }
  // a session on another chat isn't shown on the new-chat composer
  const m0 = await mountComposer({ threadId: null });
  try {
    assert.ok(!$('.voice-bar'));
  } finally {
    await m0.unmount();
  }
  store.set({ harnessOf: { t2: 'claude' } });
  fx.caps.voiceChat = 'none';
  await setVoice({ phase: 'idle', threadId: null });
  const m2 = await mountComposer({ threadId: 't2' });
  try {
    // no native voice here: no voice button, and the empty composer's Send waits disabled
    assert.equal($('.send-btn.voice'), null);
    assert.equal(($('.send-btn[aria-label="Send"]') as HTMLButtonElement).disabled, true);
  } finally {
    await m2.unmount();
  }
  // a voice error with no chat shows on the new-chat composer
  await setVoice({ phase: 'error', threadId: null, error: 'Voice chat needs Codex.' });
  fx.caps.voiceChat = 'native';
  const m3 = await mountComposer({ threadId: null });
  try {
    assert.ok($('.voice-bar.error'));
    assert.doesNotMatch(m3.editor().className, /voice-hidden/);
  } finally {
    await m3.unmount();
  }
});

test('pending voice preparation is cancelled on another click, draft switch or editor close', async () => {
  for (const change of ['click', 'switch', 'close']) {
    reset();
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    fx.startVoiceChat = (_id: string, signal: AbortSignal) => {
      signals.push(signal);
      return pending;
    };
    const m = await mountComposer({ threadId: 't1' });
    let closed = false;
    try {
      await click($('.send-btn.voice'));
      if (change === 'click') await click($('.send-btn.voice'));
      else if (change === 'switch') await m.rerender({ threadId: 't2' });
      else {
        await m.unmount();
        closed = true;
      }
      assert.equal(signals.length, 1);
      assert.equal(signals[0]?.aborted, true);
      await act(async () => release());
      await settle();
      assert.equal(all('stopVoice').length, 0, 'cancellation belongs to the pending attempt, not a later global voice session');
    } finally {
      release();
      if (!closed) await m.unmount();
    }
  }
});

test('voice preparation errors are shown only while the editor owns the attempt', async () => {
  for (const failure of [new Error('voice failed'), 'plain failure', null])
    for (const cancelled of [false, true]) {
      reset();
      let reject!: (reason: unknown) => void;
      const pending = new Promise<void>((_done, fail) => {
        reject = fail;
      });
      fx.startVoiceChat = () => pending;
      const m = await mountComposer({ threadId: 't1' });
      try {
        await click($('.send-btn.voice'));
        if (cancelled) await click($('.send-btn.voice'));
        await act(async () => reject(failure));
        await settle();
        const message = failure instanceof Error ? failure.message : String(failure);
        assert.deepEqual(all('toast'), cancelled ? [] : [['toast', `Couldn't start voice: ${message}`, 'error']]);
        assert.equal($('.send-btn.voice').getAttribute('aria-label'), 'Voice conversation');
      } finally {
        await m.unmount();
      }
    }
});

test('voice opening its own chat hands the pending attempt over; End voice still cancels it until then', async () => {
  for (const change of ['switch', 'click', 'close'] as const) {
    reset();
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    fx.startVoiceChat = (_id: string, signal: AbortSignal, opening: () => void) => {
      signals.push(signal);
      opening();
      return pending;
    };
    const m = await mountComposer({ threadId: 't1' });
    let closed = false;
    try {
      await click($('.send-btn.voice'));
      // the switch the attempt makes to the chat it opened (or the editor closing with it) is not a cancellation
      if (change === 'switch') await m.rerender({ threadId: 'voice-chat' });
      else if (change === 'close') {
        await m.unmount();
        closed = true;
      } else await click($('.send-btn.voice'));
      assert.equal(signals[0]?.aborted, change === 'click');
      if (!closed) assert.equal($('.send-btn.voice').getAttribute('aria-label'), 'Voice conversation');
      await act(async () => release());
      await settle();
      if (!closed) assert.equal($('.send-btn.voice').getAttribute('aria-label'), 'Voice conversation');
    } finally {
      release();
      if (!closed) await m.unmount();
    }
  }
});

test('voice conversation stays reachable beside Send while a typed draft is present', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('Keep this draft');
    const voice = document.querySelector('button[aria-label="Voice conversation"]');
    assert.ok(voice, 'a typed draft keeps the voice conversation button');
    assert.match(voice!.className, /composer-icon-btn/);
    await click(voice);
    assert.deepEqual(last('startVoice'), ['startVoice', 't1']);
    assert.equal(m.text, 'Keep this draft');
    assert.ok(document.querySelector('button[aria-label="Send"]'));
  } finally {
    await m.unmount();
  }
});

test('an audio selection attaches without submitting; failed and retired durable handoffs preserve the original draft', async () => {
  for (const failed of [true, false]) {
    reset();
    fx.audioSupported = true;
    const m = await mountComposer({ threadId: 't1' });
    try {
      // an agent that takes audio offers it in the + menu
      await click(document.querySelector('button[aria-label="Add files and more"]'));
      await click([...document.querySelectorAll('.add-panel-item')].find((b) => b.textContent?.startsWith('Audio message')));
      assert.ok(document.querySelector('audio'));
      assert.equal(all('send').length, 0);
      await m.type('Listen to this');
      let finish!: (id: string) => void;
      fx.audioHold = failed
        ? async () => {
            throw new Error('disk full');
          }
        : () => new Promise<string>((resolve) => (finish = resolve));
      await m.key('Enter');
      await settle();
      if (failed) {
        assert.match(all('toast').at(-1)![1], /Couldn't retain audio message/);
        assert.equal(m.text, 'Listen to this');
      } else {
        await m.rerender({ threadId: 't2' });
        await act(async () => finish('retired'));
        await settle();
        assert.equal(store.get().drafts.t1.text, 'Listen to this');
      }
      assert.equal(all('send').length, 0);
    } finally {
      await m.unmount();
    }
  }
});

test('a goal with an audio attachment carries the same durable transfer as an ordinary message', async () => {
  fx.chatCaps.goal = { state: 'native', via: 'passthrough', template: '/goal {args}' };
  store.set({ drafts: { t1: { text: 'Listen', goal: true, attachments: [{ kind: 'audio', path: '/saved.wav', name: 'Audio' }] } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.key('Enter');
    await settle();
    assert.equal(last('send')?.at(-1)?.audioTransfer, 'audio-transfer');
  } finally {
    await m.unmount();
  }
});

test('pending initial Send holds native conversation until its provisional chat is established', async () => {
  let finish!: () => void;
  fx.sendAnswer = () => new Promise<void>((resolve) => (finish = resolve));
  const m = await mountComposer({ threadId: null });
  try {
    await m.type('Create this chat');
    await m.key('Enter');
    await settle();
    assert.ok(document.querySelector('[aria-label="Starting chat"]'));
    const conversation = document.querySelector('button[aria-label="Voice conversation"]') as HTMLButtonElement;
    assert.equal(conversation.disabled, true);
    await click(conversation);
    assert.equal(all('startVoice').length, 0);
    await act(async () => finish());
    await settle();
  } finally {
    finish?.();
    await m.unmount();
  }
});
