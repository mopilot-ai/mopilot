// Default speech-bridge stand-in for UI tests whose unit is capture, not main's ownership service.
export function speechMock(transcribe: (...args: any[]) => any = async () => ({ text: '' })) {
  return {
    hold: async () => 'audio-transfer',
    finishTransfer: async () => undefined,
    drafts: async () => ({}),
    draft: async () => undefined,
    begin: async () => 'capture',
    current: async () => true,
    end: async () => undefined,
    transcribe: (_id: string, ...args: any[]) => transcribe(...args),
    options: async () => ({ engine: 'chatgpt', chain: ['chatgpt'], choices: [], audioMessage: false, conversation: false }),
    available: async () => true,
  };
}

/** Composer cases vary native conversation availability without replacing the input control. */
export function composerSpeechMock(
  conversation: () => boolean,
  audio: () => boolean = () => false,
  hold: () => Promise<string> = async () => 'audio-transfer',
) {
  return {
    ...speechMock(),
    hold,
    read: async () => 'data:audio/wav;base64,AA',
    options: async () => ({
      choices: [],
      engine: null,
      audioMessage: audio(),
      conversation: conversation(),
    }),
  };
}
