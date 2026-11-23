// Speech operation availability and provider selection, shared by main and every input surface.
// `pcm`: the service takes 16 kHz PCM, so a recording goes to it as WAV (the others take the compressed recording)
export const SPEECH_PROVIDERS = [
  { id: 'local', label: 'This Mac', pcm: true },
  { id: 'chatgpt', label: 'ChatGPT account' },
  // last: the one service that bills
  { id: 'credits', label: 'MoPilot credits' },
];

/** Whether a recording goes to `engine` as WAV. */
export const takesWav = (engine) => SPEECH_PROVIDERS.some((p) => p.id === engine && p.pcm);

export function localSpeechReadiness(status) {
  if (!status || typeof status !== 'object') return { state: 'unknown', reason: 'On-device recognition could not be checked' };
  if (status.unsupported === true) return { state: 'blocked', reason: 'On-device recognition needs macOS' };
  if (status.authorization === 'denied' || status.authorization === 'restricted')
    return { state: 'blocked', reason: 'Turn on Speech Recognition in System Settings to dictate' };
  if (status.available !== true || status.onDevice !== true)
    return { state: 'blocked', reason: 'On-device recognition is unavailable for this language' };
  if (status.authorization === 'notDetermined') return { state: 'permission', reason: 'Allow Speech Recognition to dictate' };
  return status.authorization === 'authorized'
    ? { state: 'ready', reason: null }
    : { state: 'unknown', reason: 'Speech Recognition permission could not be checked' };
}

/**
 * The services a clip is tried on, in order. A pinned one is the only one. Automatic: the chat's own account's service
 * (its harness's nativeDictation) first, then this Mac, then any other signed-in service.
 */
export function speechChain(preference, choices, native = null) {
  const usable = (id) => {
    const p = choices.find((c) => c.id === id);
    return !!p && (p.state === 'ready' || p.state === 'permission');
  };
  const known = (id) => SPEECH_PROVIDERS.some((p) => p.id === id);
  if (preference != null) return known(preference) && usable(preference) ? [preference] : [];
  const order = [...(known(native) ? [native] : []), ...SPEECH_PROVIDERS.map((p) => p.id)];
  return [...new Set(order)].filter(usable);
}

/** The service a clip goes to first; null when none can dictate. */
export function speechEngine(preference, choices, native = null) {
  return speechChain(preference, choices, native)[0] ?? null;
}

/** The longest a window waits for one service's transcription; main stops a request the window no longer waits for. */
export const SPEECH_WAIT_MS = 180_000;

/** A service that ran out of its share of the wait (and was stopped). */
export const SPEECH_TOO_LONG = 'The dictation service took too long';

export const DICTATION_OFF = 'Dictation is turned off in this app';

/** This Mac's first use: macOS's prompt went up, and the clip ends there rather than going to another service. */
export const SPEECH_ASKED = 'Allow Speech Recognition, then dictate again';

/** A service's name for the user ("This Mac"). */
export const speechLabel = (engine) => SPEECH_PROVIDERS.find((p) => p.id === engine)?.label ?? String(engine);

/**
 * An answer no other service would change: text (even none), a clip too short, dictation switched off, or macOS asking
 * for on-device recognition (the clip is not sent elsewhere while the user decides).
 */
export const speechSettles = (r) => !r?.error || r.error === DICTATION_OFF || r.error === SPEECH_ASKED || /too short/i.test(r.error);

/** Every service in a chain failed: one alone keeps its own words; several each say why ("This Mac: … · ChatGPT account: …"). */
export const speechFailure = (/** @type {{ engine: string, error: string }[]} */ failed) =>
  failed.length === 1 ? failed[0].error : failed.map((f) => `${speechLabel(f.engine)}: ${f.error}`).join(' · ');

/** Why nothing can dictate: the pinned service's own reason, else what would make one usable. */
export function noSpeechReason(preference, choices) {
  const pinned = preference != null && choices.find((c) => c.id === preference)?.reason;
  if (pinned) return pinned;
  if (choices.length && choices.every((c) => c.reason === DICTATION_OFF)) return DICTATION_OFF;
  return 'No dictation service is available. Turn on Speech Recognition, or sign in to a ChatGPT account or to MoPilot';
}

/** A native operation must be declared on this chat, never inferred from the harness name. */
export function speechOperations(caps) {
  return {
    audioMessage: caps?.caps?.audioInput?.state === 'native',
    conversation: caps?.caps?.voiceChat?.state === 'native',
  };
}
