// Opening the microphone for dictation and voice: macOS is asked first, a saved device that is gone falls back to the
// system default, and each failure says what the user can do about it (a denied grant opens System Settings).
import { native } from '../lib/native';
import { ignoring } from '../lib/ignored';
import { userError } from '../../shared/userError.mjs';
import { get as getState, toast } from '../store/core';

export type MicFailure = 'permission' | 'missing' | 'busy' | 'other';

export const MIC_TEXT: Record<Exclude<MicFailure, 'other'>, string> = {
  permission: 'Microphone access is off for MoPilot.',
  missing: 'No microphone was found.',
  busy: 'The microphone is in use by another app or could not start.',
};

export class MicError extends Error {
  readonly failure: MicFailure;
  constructor(failure: MicFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

/** What a getUserMedia rejection means for the user. */
export function classifyMicError(error: unknown): MicFailure {
  switch ((error as { name?: unknown } | null)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'missing';
    case 'NotReadableError':
    case 'AbortError':
      return 'busy';
    default:
      return 'other';
  }
}

function micError(error: unknown) {
  const failure = classifyMicError(error);
  return new MicError(failure, failure === 'other' ? userError(error, { fallback: 'The microphone could not start' }) : MIC_TEXT[failure]);
}

/** The microphone chosen in Settings › Voice (or the default), with `extra` processing constraints. */
export async function openMicrophone(extra: MediaTrackConstraints = {}): Promise<MediaStream> {
  // a grant that can't be read (or a page older than the call) is left to Chromium's own request below
  const access = await Promise.resolve()
    .then(() => native.dictation.micAsk())
    .catch(() => 'unknown' as const);
  if (access === 'denied' || access === 'restricted') throw new MicError('permission', MIC_TEXT.permission);
  const saved = getState().prefs.micDeviceId;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: saved ? { ...extra, deviceId: { exact: saved } } : extra });
  } catch (error) {
    if (!saved || classifyMicError(error) !== 'missing') throw micError(error);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: extra });
    toast('The microphone chosen in Settings was not found, so the system default is used.', 'info');
    return stream;
  } catch (error) {
    throw micError(error);
  }
}

/** A microphone failure as a toast; a denied grant offers System Settings. */
export function reportMicError(error: unknown) {
  if (error instanceof MicError && error.failure === 'permission')
    return toast(MIC_TEXT.permission, 'error', {
      action: {
        label: 'Open System Settings',
        run: () => void native.dictation.micSettings().catch(ignoring('open the microphone settings')),
      },
    });
  toast(userError(error), 'error');
}
