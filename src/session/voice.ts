// Codex voice chat in the renderer: starting it in the right chat, the realtime session, mute and the voice bar's state.

import { create } from 'zustand';
import { onCodexNotification } from '../harness/adapters/codex';
import { useStore, toast } from '../store/core';
import { chatFamily, nativeOf, newChatKind } from '../store/chats';
import { ensureResumed } from '../store/threads';
import { createChatThread } from '../store/send';
import { VOICE_HARNESS } from '../harness/family';
import { voiceUnavailable as checkVoiceAccess } from './voiceAccess';
import { capsOf } from '../store/session/useCaps';
import { native } from '../lib/native';
import { withTimeout, timedOut } from '../lib/localSpeech';
import { openMicrophone, reportMicError, MicError } from './microphone';
import { noSpeechReason } from '../../shared/speech.mjs';
import { ignoring, noteIgnored, errorText } from '../lib/ignored';
import type { DictationEngine } from '../lib/dictation';
import type { CapsHint } from '../store/session/capsTypes';
import type { ThreadRealtimeSdpNotification } from '../protocol/v2/ThreadRealtimeSdpNotification';
import type { ThreadRealtimeErrorNotification } from '../protocol/v2/ThreadRealtimeErrorNotification';
import type { ThreadRealtimeTranscriptDeltaNotification } from '../protocol/v2/ThreadRealtimeTranscriptDeltaNotification';
import type { ThreadRealtimeTranscriptDoneNotification } from '../protocol/v2/ThreadRealtimeTranscriptDoneNotification';

/** Globals tests and dev builds use: a synthetic microphone, and the realtime event types seen. */
type VoiceTestWindow = Window & { __voiceTestStream?: MediaStream; __voiceEvents?: string[] };

/**
 * The services main resolves, in the order a clip is tried: the one pinned in Settings, else (Automatic) the chat's own
 * account's service, this Mac, then any other signed-in one.
 */
export async function currentDictationChain(chatId: string | null = null, hint: CapsHint = {}): Promise<DictationEngine[]> {
  const options = await withTimeout(native.speech.options(chatId, hint), 10_000);
  if (timedOut(options)) throw new Error('Speech services did not respond. Try again.');
  const chain = options.chain ?? (options.engine ? [options.engine] : []);
  if (!chain.length) throw new Error(noSpeechReason(useStore.getState().prefs.dictationEngine, options.choices ?? []));
  return chain;
}

/** The first service of that order. */
export async function currentDictationEngine(chatId: string | null = null, hint: CapsHint = {}): Promise<DictationEngine> {
  return (await currentDictationChain(chatId, hint))[0];
}

/**
 * Voice mode: a thread-scoped realtime session over WebRTC.
 * The app-server negotiates the call (ChatGPT auth only works over WebRTC, v3),
 * the realtime model hands work off to Codex in the same thread.
 */
export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

interface VoiceState {
  threadId: string | null;
  phase: VoicePhase;
  muted: boolean;
  /** live caption: last thing said by either side */
  caption: { role: 'user' | 'assistant'; text: string } | null;
  level: number;
  error: string | null;
}

export const useVoice = create<VoiceState>(() => ({ threadId: null, phase: 'idle', muted: false, caption: null, level: 0, error: null }));

/** Vite's build flags (absent outside a Vite build, e.g. under node); DEV records data-channel events for tests. */
export const voiceEnv: { DEV?: boolean } = import.meta.env ?? {};

const V3_VOICES = ['cove', 'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol'];

let pc: RTCPeerConnection | null = null;
let mic: MediaStream | null = null;
let audioEl: HTMLAudioElement | null = null;
let offNotif: (() => void) | null = null;
let raf = 0;
let ctx: AudioContext | null = null;
let voiceRun = 0;
let voiceCapture: string | null = null;

/** Only the current chat's native conversation capability may start this realtime transport. */
export { VOICE_UNAVAILABLE } from './voiceAccess';

async function voiceUnavailable(chatId: string | null): Promise<string | null> {
  return checkVoiceAccess(chatId, capsOf, { kind: newChatKind(useStore.getState()) });
}

/** Start realtime in this chat, or a new chat on its selected harness; never move another chat to Codex. */
export async function startVoiceChat(chatId: string | null, signal?: AbortSignal, opening?: () => void) {
  if (signal?.aborted) return;
  if (useVoice.getState().phase !== 'idle') {
    const stopped = stopVoice();
    const afterStop = voiceRun;
    await stopped;
    if (afterStop !== voiceRun || signal?.aborted) return;
  }
  const attempt = ++voiceRun;
  const current = () => attempt === voiceRun;
  const cancel = () => {
    if (current()) void stopVoice();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const unavailable = await voiceUnavailable(chatId);
    if (!current()) return;
    if (unavailable) {
      useVoice.setState({ threadId: chatId, phase: 'error', error: unavailable, muted: false, caption: null });
      return;
    }
    if (!chatId) opening?.();
    const id = chatId ?? (await createChatThread('Voice chat', { typed: false }));
    if (!current()) return;
    if (id) await startVoice(id, useStore.getState().prefs.voice ?? 'cove', signal);
  } catch (error) {
    if (current()) toast(`Couldn't start voice: ${errorText(error)}`, 'error');
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function startVoice(threadId: string, voice = 'cove', signal?: AbortSignal) {
  if (signal?.aborted) return;
  if (useVoice.getState().phase !== 'idle') {
    const stopped = stopVoice();
    const afterStop = voiceRun;
    await stopped;
    if (afterStop !== voiceRun || signal?.aborted) return;
  }
  const run = ++voiceRun;
  const current = () => run === voiceRun;
  const cancel = () => {
    if (current()) void stopVoice();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  useVoice.setState({ threadId, phase: 'connecting', muted: false, caption: null, error: null });
  try {
    const unavailable = await voiceUnavailable(threadId);
    if (!current()) return;
    if (unavailable) throw new Error(unavailable);
    const capture = await native.speech.begin(threadId, {});
    if (!current()) {
      await native.speech.end(capture);
      return;
    }
    voiceCapture = capture;
    const nativeThread = nativeOf(threadId);
    // Tests can inject a synthetic stream instead of the microphone.
    const stream: MediaStream =
      (window as VoiceTestWindow).__voiceTestStream ?? (await openMicrophone({ echoCancellation: true, noiseSuppression: true }));
    if (!current()) {
      if (stream !== (window as VoiceTestWindow).__voiceTestStream) stream.getTracks().forEach((t) => t.stop());
      return;
    }
    mic = stream;
    const peer = new RTCPeerConnection();
    pc = peer;
    for (const t of stream.getAudioTracks()) peer.addTrack(t, stream);
    const dc = peer.createDataChannel('oai-events');
    dc.onmessage = (e) => current() && onEvent(e.data);
    peer.ontrack = (e) => {
      if (!current()) return;
      audioEl ??= new Audio();
      audioEl.autoplay = true;
      audioEl.srcObject = e.streams[0];
      // autoplay can be refused; the call and its captions go on
      audioEl.play().catch((error) => noteIgnored("play the voice call's audio", error));
    };
    peer.onconnectionstatechange = () => {
      if (!current()) return;
      if (peer.connectionState === 'connected') useVoice.setState({ phase: 'listening' });
      if (peer.connectionState === 'failed') fail('Voice connection failed');
    };
    offNotif = onCodexNotification((method: string, params: unknown) => {
      const p = params as { threadId?: string } | null;
      if (!current() || p?.threadId !== threadId) return;
      if (method === 'thread/realtime/sdp')
        peer
          .setRemoteDescription({ type: 'answer', sdp: (params as ThreadRealtimeSdpNotification).sdp })
          .catch((e) => current() && fail(e.message));
      else if (method === 'thread/realtime/error') fail(cleanError((params as ThreadRealtimeErrorNotification).message));
      // stopVoice releases everything local first; only that release can throw here
      else if (method === 'thread/realtime/closed') stopVoice(false).catch(ignoring('end a voice session the app-server closed'));
      else if (method === 'thread/realtime/transcript/delta')
        caption(
          (params as ThreadRealtimeTranscriptDeltaNotification).role,
          (params as ThreadRealtimeTranscriptDeltaNotification).delta,
          true,
        );
      else if (method === 'thread/realtime/transcript/done')
        caption(
          (params as ThreadRealtimeTranscriptDoneNotification).role,
          (params as ThreadRealtimeTranscriptDoneNotification).text,
          false,
        );
    });
    const offer = await peer.createOffer();
    if (!current()) return;
    await peer.setLocalDescription(offer);
    if (!current()) return;
    // a voice session writes the thread the whole time: hold its lease until it stops
    await ensureResumed(nativeThread);
    if (!current()) return;
    if (chatFamily(threadId) !== VOICE_HARNESS || nativeOf(threadId) !== nativeThread)
      throw new Error('This chat changed harness. Start voice again.');
    if (!(await native.speech.current(capture)) || !current()) throw new Error('Voice was stopped. Start voice again.');
    await native.speech.conversation(capture, {
      threadId: nativeThread,
      outputModality: 'audio',
      version: 'v3',
      model: 'gpt-live-1-codex',
      includeStartupContext: false,
      flushTranscriptTailOnSessionEnd: false,
      transport: { type: 'webrtc', sdp: offer.sdp },
      voice: V3_VOICES.includes(voice) ? voice : 'cove',
    });
    if (current()) meter(stream);
  } catch (e) {
    if (!current()) return;
    if (e instanceof MicError && e.failure === 'permission') reportMicError(e);
    fail(cleanError(errorText(e)));
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function stopVoice(notify = true) {
  const stopping = ++voiceRun;
  const { threadId } = useVoice.getState();
  const capture = voiceCapture;
  voiceCapture = null;
  const ending = capture
    ? native.speech.end(capture).catch((error) => {
        if (voiceRun === stopping) useVoice.setState({ phase: 'error', threadId, error: errorText(error) });
      })
    : Promise.resolve();
  cancelAnimationFrame(raf);
  offNotif?.();
  offNotif = null;
  pc?.close();
  pc = null;
  if (mic && mic !== (window as VoiceTestWindow).__voiceTestStream) mic.getTracks().forEach((t) => t.stop());
  mic = null;
  if (audioEl) audioEl.srcObject = null;
  // the level meter's context; nothing else uses it
  ctx?.close().catch((error) => noteIgnored("close the voice level meter's audio context", error));
  ctx = null;
  const err = useVoice.getState().phase === 'error';
  useVoice.setState({ phase: err ? 'error' : 'idle', threadId: err ? threadId : null, level: 0 });
  // Main closes the captured original resource; no thread-id-only Stop can reach a replacement session.
  if (notify) await ending;
}

export function toggleMute() {
  const muted = !useVoice.getState().muted;
  mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  useVoice.setState({ muted });
}

export function dismissVoiceError() {
  useVoice.setState({ phase: 'idle', threadId: null, error: null });
}

function fail(message: string) {
  useVoice.setState({ phase: 'error', error: message });
  // the error is shown already; stopVoice releases everything local first
  stopVoice().catch(ignoring('end a voice session that failed'));
}

function cleanError(m: string) {
  try {
    const j = JSON.parse(m);
    return j?.error?.message ?? m;
  } catch {
    return m.split('\n')[0];
  }
}

function caption(role: string, text: string, delta: boolean) {
  const r = role === 'user' ? 'user' : 'assistant';
  const prev = useVoice.getState().caption;
  const next = delta && prev?.role === r ? prev.text + text : text;
  useVoice.setState({ caption: { role: r, text: next }, phase: r === 'assistant' ? 'speaking' : 'listening' });
}

/** Realtime events on the data channel (transcripts arrive here for WebRTC calls). */
function onEvent(raw: string) {
  let e: { type?: string; delta?: string; transcript?: string };
  try {
    e = JSON.parse(raw);
  } catch {
    return;
  }
  if (voiceEnv.DEV) ((window as VoiceTestWindow).__voiceEvents ??= []).push(e.type as string);
  switch (e.type) {
    case 'conversation.item.input_audio_transcription.delta':
      return caption('user', e.delta ?? '', true);
    case 'conversation.item.input_audio_transcription.completed':
      return caption('user', e.transcript ?? '', false);
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      return caption('assistant', e.delta ?? '', true);
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      return caption('assistant', e.transcript ?? '', false);
    case 'output_audio_buffer.stopped':
    case 'response.done':
      return useVoice.setState({ phase: 'listening' });
    case 'input_audio_buffer.speech_started':
      return useVoice.setState({ phase: 'listening', caption: null });
  }
}

/** Input level for the waveform animation. */
function meter(stream: MediaStream) {
  ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  const tick = () => {
    an.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += (v - 128) ** 2;
    useVoice.setState({ level: Math.min(1, Math.sqrt(sum / data.length) / 40) });
    raf = requestAnimationFrame(tick);
  };
  tick();
}
