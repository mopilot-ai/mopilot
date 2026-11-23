// DEV ONLY: the Mac's speech as the fake app answers it: it says what the engine would have been given, so a device test can tell a real WAV from a clip in another format.

/**
 * @param {(line: string) => void} log
 * @returns {{ engine: () => Promise<string>, transcribe: (clip?: { audio?: Uint8Array, mime?: string }) => Promise<{ text: string }>, transcribeClip: (clip?: { audio?: Uint8Array, mime?: string }) => Promise<{ text: string }> }}
 */
export function createFakeDictation(log) {
  /** @param {{ audio?: Uint8Array, mime?: string }} [clip] */
  const transcribe = async (clip = {}) => {
    if (!clip.audio) return { text: '' };
    const audio = Buffer.from(clip.audio);
    const { mime } = clip;
    const wav = audio.subarray(0, 4).toString('latin1') === 'RIFF' && audio.subarray(8, 12).toString('latin1') === 'WAVE';
    const start = [...audio.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const text = `Heard ${audio.length} bytes of ${mime ?? 'an unknown type'}: ${wav ? 'a WAV file.' : `NOT a WAV file, it starts ${start || 'nothing'}.`}`;
    log(`app: dictation: ${text}`);
    return { text };
  };
  // a clip a phone sent whole (chat.transcribe, momo.chat.transcribe) is read the same way
  return { engine: async () => 'unavailable', transcribe, transcribeClip: transcribe };
}
