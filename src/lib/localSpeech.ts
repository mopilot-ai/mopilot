// Local dictation's macOS Speech Recognition permission (#2286), for the composer's Dictate in every chat (MoMo's and the
// coding side's): whether a clip can go to this Mac's recognition now, has to wait for macOS's prompt, or can't; the
// prompt's answer, never waited on forever; and the one line each case says.
import { noteIgnored } from './ignored';
import { native } from './native';
import { localSpeechReadiness, SPEECH_WAIT_MS } from '../../shared/speech.mjs';

/** What the composer says while macOS asks, and when local dictation can't run. */
export const SPEECH_TEXT = {
  ask: 'Allow Speech Recognition to dictate',
  denied: 'Turn on Speech Recognition in System Settings to dictate',
  timeout: 'Dictation timed out',
  failed: 'Couldn’t ask for Speech Recognition',
  unavailable: 'On-device recognition is unavailable for this language. Choose another dictation service.',
} as const;

/** How long the prompt and a transcription may take before the composer gives up (the helper's own limits, electron/capabilities/computer.cjs). */
export const SPEECH_ASK_MS = 120_000;
export const SPEECH_TRANSCRIBE_MS = SPEECH_WAIT_MS;

const TIMED_OUT = Symbol('timed out');

/** `p`, or TIMED_OUT once `ms` pass first. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
export const timedOut = (v: unknown): v is typeof TIMED_OUT => v === TIMED_OUT;

/**
 * Where local dictation stands before a clip goes to it: `ready` (allowed, or not known: the transcription then says what
 * went wrong), `ask` (macOS hasn't asked yet: its prompt comes first) or `denied` (turned off or restricted).
 */
export async function speechGate(language: string): Promise<'ready' | 'ask' | 'denied' | 'unavailable'> {
  let status: Awaited<ReturnType<typeof native.dictation.localStatus>>;
  try {
    status = await native.dictation.localStatus(language);
  } catch {
    return 'unavailable';
  }
  const state = localSpeechReadiness(status);
  if (state.state === 'permission') return 'ask';
  if (status?.authorization === 'denied' || status?.authorization === 'restricted') return 'denied';
  return state.state === 'ready' ? 'ready' : 'unavailable';
}

/** macOS's answer to its Speech Recognition prompt: granted, denied, failed (it couldn't be asked, `why` says why when main knows), or none in time. */
export async function askSpeech(language: string): Promise<{ answer: 'granted' | 'denied' | 'failed' | 'timeout'; why?: string }> {
  const got = await withTimeout(requested(language), SPEECH_ASK_MS);
  if (timedOut(got)) return { answer: 'timeout' };
  if (!got) return { answer: 'failed' };
  if ('failure' in got) return { answer: 'failed', why: got.failure };
  return { answer: got.authorization === 'authorized' ? 'granted' : 'denied' };
}

/** The prompt's answer, or null when it couldn't be asked (the helper gone). */
async function requested(language: string) {
  try {
    return await native.dictation.localRequest(language);
  } catch (e) {
    noteIgnored('ask macOS for Speech Recognition', e);
    return null;
  }
}
