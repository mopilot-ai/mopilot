// Audio attachment and retry cases share the dictation recorder fixture without duplicating capture behavior.
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './async-scenarios.ts';

export function registerAudioCases(f: any) {
  const { createRef, mount, createElement, Dictation, act, press, flush, calls, render } = f;
  test('explicit audio mode saves a replayable attachment without transcribing or sending a task', async () => {
    const control = createRef();
    const audio: any[] = [],
      texts: string[] = [];
    const m = await mount(
      createElement(Dictation, { control, threadId: 'chat', onAudio: (a) => audio.push(a), onText: (t) => texts.push(t) }),
    );
    try {
      await act(() => control.current.audio());
      await press();
      await flush();
      assert.equal(audio[0].kind, 'audio');
      assert.deepEqual(texts, []);
      assert.equal(calls.filter((c) => c[0] === 'transcribe').length, 0);
    } finally {
      await m.unmount();
    }
  });

  test('a failed recording is retained and Retry reuses its bytes without acquiring another microphone', async () => {
    const m = await render();
    try {
      f.transcribe = async () => ({ error: 'offline' });
      await press();
      await press();
      await flush();
      assert.match(m.host.textContent ?? '', /Recording retained/);
      f.transcribe = async () => ({ text: 'Recovered' });
      await act(async () => [...m.host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click());
      await flush();
      assert.deepEqual(m.texts, ['Recovered']);
      assert.equal(f.gumArgs.length, 1);
    } finally {
      await m.unmount();
    }
  });

  test('audio save failure keeps the clip; a retired owner cannot publish its late saved asset', async () => {
    const control = createRef();
    const audio: any[] = [];
    const m = await mount(createElement(Dictation, { control, onAudio: (a) => audio.push(a), onText: () => {} }));
    try {
      f.saveAudio = async () => {
        throw new Error('disk full');
      };
      await act(() => control.current.audio());
      await press();
      await flush();
      assert.match(m.host.textContent ?? '', /Recording retained/);
      const saving = deferred<any>();
      f.saveAudio = () => saving.promise;
      await act(async () => [...m.host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click());
      await press(); // Cancel the pending save; its late answer cannot attach to a replacement draft.
      saving.resolve({ kind: 'audio', path: '/late.wav' });
      await flush();
      assert.deepEqual(audio, []);
    } finally {
      await m.unmount();
    }
  });
  test('malformed backend transcript and error bodies become readable failures and allow another recording', async () => {
    const { createDictation } = createRequire(import.meta.url)('../../electron/platform/voice.cjs');
    let reply: any = { ok: true, body: { text: { unexpected: true } } };
    const service = createDictation({
      chatgptHeaders: async () => ({}),
      fetch: async () => ({ ok: reply.ok, status: 400, json: async () => reply.body }),
    });
    f.transcribe = (_bytes, _mime, _lang, requestedEngine) =>
      service.transcribe({ engine: requestedEngine, bytes: new Uint8Array([1]), mime: 'audio/webm' });
    const m = await render();
    try {
      for (const bad of [
        { ok: true, body: { text: {} } },
        { ok: false, body: { detail: { code: 'bad_audio' } } },
      ]) {
        reply = bad;
        await press();
        await press();
        await flush();
        await press(); // Discard each retained failure before starting another clip.
      }
      assert.deepEqual(
        calls.filter((call) => call[0] === 'toast'),
        [
          ['toast', 'Transcription failed: invalid response', 'error'],
          ['toast', 'Transcription failed (400)', 'error'],
        ],
      );
      assert.deepEqual(m.texts, []);
      assert.equal(
        calls.some((call) => call[0] === 'save'),
        false,
      );
      reply = { ok: true, body: { text: 'valid retry' } };
      await press();
      await press();
      await flush();
      assert.deepEqual(m.texts, ['valid retry']);
      assert.ok(calls.some((call) => call[0] === 'save'));
    } finally {
      await m.unmount();
    }
  });
  test('retained dictation can retry an explicitly chosen service, while raw audio requires recovery or discard', async () => {
    const control = createRef();
    const texts: string[] = [];
    const m = await mount(createElement(Dictation, { control, onText: (t: string) => texts.push(t) }));
    try {
      await act(() => control.current.audio());
      assert.ok(calls.some((c: any[]) => c[0] === 'toast' && /unavailable/.test(c[1])));
      f.transcribe = async () => ({ error: 'offline' });
      await act(() => control.current.dictate('chatgpt'));
      await press();
      await flush();
      await act(() => control.current.audio());
      assert.ok(calls.some((c: any[]) => /Retry or discard/.test(c[1])));
      f.transcribe = async () => ({ text: 'From chosen service' });
      await act(() => control.current.dictate('credits'));
      await flush();
      assert.deepEqual(texts, ['From chosen service']);
      assert.equal(calls.filter((c: any[]) => c[0] === 'transcribe').at(-1)[4], 'credits');
      f.transcribe = async () => ({ error: 'offline again' });
      await act(() => control.current.dictate('credits'));
      await press();
      await flush();
      await act(() => [...m.host.querySelectorAll('button')].find((b: any) => b.textContent === 'Discard')!.click());
      assert.doesNotMatch(m.host.textContent ?? '', /Recording retained/);
    } finally {
      await m.unmount();
    }
  });

  test('a capture acquired after cancellation is released, and a retired recording never produces text or an attachment', async () => {
    const control = createRef();
    const texts: string[] = [],
      audio: any[] = [];
    const m = await mount(createElement(Dictation, { control, onText: (t: string) => texts.push(t), onAudio: (a: any) => audio.push(a) }));
    try {
      const gate = deferred<string>();
      f.begin = () => gate.promise;
      await act(() => {
        void control.current.dictate('credits');
      });
      await press();
      gate.resolve('late');
      await flush();
      assert.equal(f.gumArgs.length, 0);
      f.begin = async () => 'current';
      await act(() => control.current.audio());
      f.currentCapture = false;
      await press();
      await flush();
      assert.match(m.host.textContent ?? '', /Recording retained/);
      await act(() => [...m.host.querySelectorAll('button')].find((b: any) => b.textContent === 'Discard')!.click());
      f.currentCapture = true;
      const wav = deferred<Uint8Array>();
      f.wav = () => wav.promise;
      await act(() => control.current.audio());
      await press();
      await press();
      wav.resolve(new Uint8Array([1]));
      await flush();
      assert.deepEqual(audio, []);
      f.transcribe = async () => {
        f.currentCapture = false;
        return { text: 'retired' };
      };
      await act(() => control.current.dictate('credits'));
      await press();
      await flush();
      assert.deepEqual(texts, []);
    } finally {
      await m.unmount();
    }
  });

  test('recording duration is bounded, including an externally inactive recorder', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const settle = () =>
      act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
    const m = await render();
    try {
      await press();
      await act(() => t.mock.timers.tick(120_000));
      await settle();
      assert.deepEqual(m.texts, ['hello world']);
      await press();
      f.recorders.at(-1).state = 'inactive';
      await act(() => t.mock.timers.tick(120_000));
      await settle();
      assert.equal(f.recorders.at(-1).state, 'inactive');
    } finally {
      await m.unmount();
    }
  });
}
