// The composer's dictation button: records the microphone and turns speech into draft text; with this Mac's engine, the
// first use waits for macOS's Speech Recognition prompt and says so, and a second press gives up waiting (#2286).

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { get as getState, toast } from '../../store/core';
import { native } from '../../lib/native';
import { currentDictationChain, currentDictationEngine } from '../../session/voice';
import { openMicrophone, reportMicError } from '../../session/microphone';
import { recordingToWav, type DictationEngine } from '../../lib/dictation';
import { Tooltip } from './Popover';
import { Mic, Spinner } from './icons';
import { errorText, ignoring } from '../../lib/ignored';
import { SPEECH_TEXT } from '../../lib/localSpeech';
import { engineLabel, sendAlong } from './dictationSend';
import { DictationMeter, DICTATION_MAX_MS } from './DictationMeter';
import { startStream, type LocalStream } from './dictationStream';
import type { CapsHint } from '../../store/session/capsTypes';
import type { Attachment } from '../../store/types';

export interface DictationControl {
  /** start or stop dictating: on `engine`, else on the services main orders (Automatic) */
  dictate(engine?: DictationEngine): Promise<void>;
  /** stop a recording and transcribe it (hold-to-talk's release); nothing otherwise */
  stop(): void;
  /** a recording is running */
  recording(): boolean;
  audio(): Promise<void>;
}

/** Tests inject a fake microphone stream here. */
type VoiceTestWindow = Window & { __voiceTestStream?: MediaStream };

/* ------------------------------------------------------------------ */
/* Shared dictation for the composer and selection comments.           */
/* ------------------------------------------------------------------ */
export function Dictation({
  onText,
  engine: only,
  keepRecording = true,
  control,
  threadId = null,
  hint = {},
  onAudio,
  available = true,
}: {
  onText: (t: string) => void;
  /** this engine whatever Settings chose (MoMo: this Mac only) */
  engine?: DictationEngine;
  /** false: the recording is not kept in Settings › Voice's recordings */
  keepRecording?: boolean;
  control?: Ref<DictationControl>;
  threadId?: string | null;
  hint?: CapsHint;
  onAudio?: (attachment: Attachment) => void;
  /** false: every dictation service is blocked here (useDictationAvailable), so the idle button is hidden */
  available?: boolean;
}) {
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  // Use the configured local or cloud transcription engine.
  // asking: macOS's Speech Recognition prompt is up, before this Mac's recognition can take the clip
  // the next service a clip moved on to, after the one before couldn't transcribe it
  const [trying, setTrying] = useState<string | null>(null);
  // the recording's microphone and start, for the level meter and its clock
  const [meter, setMeter] = useState<{ stream: MediaStream; startedAt: number } | null>(null);
  // the live recognition of the recording (dictationStream.ts: this Mac's or the ChatGPT login's), and what it heard so far
  const streaming = useRef<LocalStream | null>(null);
  const [caption, setCaption] = useState('');
  const endStream = useCallback(() => {
    streaming.current?.cancel();
    streaming.current = null;
  }, []);
  const button = useRef<HTMLButtonElement>(null);
  // hold-to-talk released before the recording began
  const stopWhenStarted = useRef(false);
  const [state, setState] = useState<'idle' | 'preparing' | 'recording' | 'asking' | 'transcribing' | 'failed'>('idle');
  const retry = useRef<((engine?: DictationEngine) => void) | null>(null);
  // why the retained recording wasn't transcribed: the note keeps saying it after the toast is gone
  const [why, setWhy] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rec = useRef<MediaRecorder | null>(null);
  // the clip being transcribed: a press while it waits gives it up, and its late answer changes nothing
  const run = useRef(0);
  const mounted = useRef(true);
  const requesting = useRef(false);
  const capture = useRef<string | null>(null);
  const release = useCallback(() => {
    const id = capture.current;
    capture.current = null;
    if (id) void native.speech.end(id).catch(ignoring('release voice input ownership'));
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      run.current++;
      requesting.current = false;
      release();
      endStream();
      const recorder = rec.current;
      if (recorder) {
        recorder.onstop = null;
        if (recorder.state !== 'inactive') recorder.stop();
        if (recorder.stream !== (window as VoiceTestWindow).__voiceTestStream) recorder.stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [release, endStream]);
  const toggle = async (selected?: DictationEngine, audio = false) => {
    if (state === 'recording') {
      const recorder = rec.current!;
      if (recorder.state !== 'inactive') recorder.stop();
      return;
    }
    if (state === 'failed' && selected) {
      retry.current?.(selected);
      return;
    }
    if (state === 'failed' && audio) return toast('Retry or discard the retained recording first', 'error');
    if (state === 'preparing' || state === 'asking' || state === 'transcribing' || state === 'failed') {
      retry.current = null;
      run.current++;
      requesting.current = false;
      release();
      setState('idle');
      return;
    }
    if (requesting.current) return;
    requesting.current = true;
    stopWhenStarted.current = false;
    setState('preparing');
    const attempt = ++run.current;
    const current = () => mounted.current && run.current === attempt;
    let stream: MediaStream;
    let engine: DictationEngine | null = null;
    // the engine came from main's choice, not this surface or the menu: it is read again when the clip is transcribed
    let automatic = false;
    let acquiringMicrophone = false;
    try {
      if (audio && !onAudio) throw new Error('Audio attachments are unavailable in this input');
      engine = audio ? null : (only ?? selected ?? (await currentDictationEngine(threadId, hint)));
      automatic = !audio && !only && !selected;
      if (!current()) return;
      const id = await native.speech.begin(threadId, hint);
      if (!current()) {
        await native.speech.end(id);
        return;
      }
      capture.current = id;
      acquiringMicrophone = true;
      stream = (window as VoiceTestWindow).__voiceTestStream ?? (await openMicrophone());
    } catch (error) {
      if (!current()) return;
      setState('idle');
      requesting.current = false;
      release();
      return acquiringMicrophone ? reportMicError(error) : toast(errorText(error), 'error');
    }
    requesting.current = false;
    if (!current()) {
      if (stream !== (window as VoiceTestWindow).__voiceTestStream) stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    let r: MediaRecorder;
    try {
      r = new MediaRecorder(stream, { mimeType: mime });
    } catch (e) {
      if (stream !== (window as VoiceTestWindow).__voiceTestStream) stream.getTracks().forEach((t) => t.stop());
      release();
      setState('idle');
      return toast(errorText(e), 'error');
    }
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = async () => {
      clearTimeout(timer.current);
      setMeter(null);
      setCaption('');
      if (stream !== (window as VoiceTestWindow).__voiceTestStream) stream.getTracks().forEach((t) => t.stop());
      const live = current;
      const heard = streaming.current;
      streaming.current = null;
      setTrying(null);
      setState('transcribing');
      const blob = new Blob(chunks, { type: mime });
      const lang = getState().prefs.dictationLanguage;
      let res: { text?: string; error?: string };
      let retain = false;
      let failure = '';
      try {
        const owner = capture.current!;
        if (!(await native.speech.current(owner))) throw new Error('This voice input belongs to an earlier chat or account');
        if (!live()) return;
        if (audio) {
          const wav = await recordingToWav(blob);
          if (!live()) return;
          const saved = await native.speech.save(owner, wav);
          if (live()) onAudio?.(saved);
          return;
        }
        // a service pinned or turned off while recording is respected: never upload where the user just said no
        const chain = automatic ? await currentDictationChain(threadId, hint) : [engine!];
        if (!live()) return heard?.cancel();
        // the first service heard it live: its text, unless the stream failed (then the recording goes along the chain)
        let streamed: string | null = null;
        if (heard && chain[0] === heard.engine) streamed = await heard.finish();
        else heard?.cancel();
        if (!live()) return;
        const sent =
          streamed !== null
            ? { text: streamed }
            : await sendAlong(chain, {
                blob,
                lang,
                owner,
                live,
                progress: {
                  asking: (on) => setState(on ? 'asking' : 'transcribing'),
                  trying: (next) => setTrying(engineLabel(next)),
                },
              });
        if (!sent) return;
        res = sent;
        if (!(await native.speech.current(owner))) return;
        retain = !!res.error;
        failure = res.error ?? '';
      } catch (e) {
        // a failure with nothing to say still says the recording wasn't transcribed
        res = { error: errorText(e) || "Couldn't transcribe the recording" };
        retain = true;
        failure = res.error!;
      } finally {
        if (live()) {
          setTrying(null);
          setWhy(failure);
          setState(retain ? 'failed' : 'idle');
          // a failed dictation frees the microphone while it waits (Retry takes a new capture); an audio message keeps
          // the capture it was recorded under, since it belongs to that chat and account
          if (!retain || !audio) release();
          if (retain && audio) retry.current = () => void r.onstop?.(new Event('stop'));
          else if (retain) {
            const again = (selected?: DictationEngine) => {
              if (selected) {
                engine = selected;
                automatic = false;
              }
              retry.current = null;
              setState('transcribing');
              native.speech.begin(threadId, hint).then(
                (id) => {
                  if (!live()) return void native.speech.end(id).catch(ignoring('release a retry nobody waits for'));
                  capture.current = id;
                  void r.onstop?.(new Event('stop'));
                },
                (error) => {
                  if (!live()) return;
                  retry.current = again;
                  setWhy(errorText(error));
                  setState('failed');
                  toast(errorText(error), 'error');
                },
              );
            };
            retry.current = again;
          }
        }
      }
      if (!live()) return;
      if (res.error) toast(res.error, 'error');
      else if (res.text?.trim()) {
        onTextRef.current(res.text.trim());
        if (!keepRecording) return;
        try {
          await native.recordings.save(new Uint8Array(await blob.arrayBuffer()), res.text.trim());
        } catch (error) {
          if (mounted.current) toast(`Could not save recording: ${errorText(error)}`, 'error');
        }
      }
    };
    try {
      r.start();
    } catch (e) {
      if (stream !== (window as VoiceTestWindow).__voiceTestStream) stream.getTracks().forEach((t) => t.stop());
      release();
      setState('idle');
      return toast(errorText(e), 'error');
    }
    timer.current = setTimeout(() => {
      if (r.state !== 'inactive') r.stop();
    }, DICTATION_MAX_MS);
    rec.current = r;
    setMeter({ stream, startedAt: Date.now() });
    setState('recording');
    if (engine && engine !== 'credits') {
      // live words while recording; the recording stays the fallback until the stream answers
      setCaption('');
      void startStream({
        engine,
        capture: capture.current!,
        lang: getState().prefs.dictationLanguage,
        stream,
        onCaption: (text) => current() && setCaption(text),
      }).then((s) => {
        if (current() && rec.current === r && r.state !== 'inactive') streaming.current = s;
        else s?.cancel();
      });
    }
    if (stopWhenStarted.current) {
      stopWhenStarted.current = false;
      r.stop();
    }
  };
  /** Esc or × on the meter (shown only while recording): the recording is thrown away, nothing is transcribed and the
   * microphone is free at once. */
  const discard = () => {
    const r = rec.current!;
    run.current++;
    clearTimeout(timer.current);
    r.onstop = null;
    if (r.state !== 'inactive') r.stop();
    if (r.stream !== (window as VoiceTestWindow).__voiceTestStream) r.stream.getTracks().forEach((t) => t.stop());
    release();
    endStream();
    setMeter(null);
    setCaption('');
    setState('idle');
  };
  const stop = () => {
    if (state === 'recording' && rec.current && rec.current.state !== 'inactive') rec.current.stop();
    // released while the recording was still starting (a prompt, a slow lookup): it stops as soon as it starts
    else if (state === 'preparing') stopWhenStarted.current = true;
  };
  useImperativeHandle(control, () => ({
    dictate: (engine) => toggle(engine),
    audio: () => toggle(undefined, true),
    stop,
    recording: () => state === 'recording',
  }));
  // nothing could dictate here: no button rather than one that only fails (a pending or failed clip still shows)
  if (available === false && state === 'idle') return null;
  const busy = state === 'preparing' || state === 'asking' || state === 'transcribing';
  return (
    <>
      {state === 'failed' && (
        <span className="dictation-note" role="status">
          {/* a retained clip always has its reason (the chain's error, or why it threw or couldn't retry) */}
          <span className="dictation-why" title={why}>
            Recording retained. {why}
          </span>
          <button type="button" onClick={() => retry.current?.()}>
            Retry
          </button>
          <button type="button" onClick={() => void toggle()}>
            Discard
          </button>
        </span>
      )}
      {trying && state === 'transcribing' && (
        <span className="dictation-note" role="status">
          Trying {trying}…
        </span>
      )}
      {state === 'asking' && (
        <span className="dictation-note" role="status">
          {SPEECH_TEXT.ask}
        </span>
      )}
      {state === 'recording' && meter && (
        <DictationMeter
          stream={meter.stream}
          startedAt={meter.startedAt}
          caption={caption}
          scope={() => button.current!.closest('.composer, form') ?? button.current!.parentElement}
          onStop={stop}
          onCancel={discard}
        />
      )}
      <Tooltip
        label={state === 'recording' ? 'Stop dictation' : busy ? 'Cancel dictation' : 'Dictate'}
        shortcut={state === 'recording' ? '↵' : undefined}
      >
        <button
          ref={button}
          type="button"
          className={`composer-icon-btn mic ${state === 'recording' ? 'recording' : ''}`}
          onClick={() => void toggle()}
          aria-label="Dictate"
          aria-busy={busy || undefined}
        >
          {busy ? <Spinner size={14} /> : <Mic size={16} strokeWidth={1.8} />}
        </button>
      </Tooltip>
    </>
  );
}
