// window.native.dictation's types (dictation), merged into NativeApi; the calls are declared in electron/bridge/dictation.cjs.
import type { LocalSpeechFailure, LocalSpeechStatus } from '../native';

export type MicAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

declare module '../native' {
  interface NativeApi {
    dictation: {
      /** Local engine: Speech Recognition permission and availability; null off macOS or when the helper can't start */
      localStatus(language?: string): Promise<LocalSpeechStatus | null>;
      /** Shows the macOS permission prompt (first time only) and answers like localStatus */
      localRequest(language?: string): Promise<LocalSpeechStatus | LocalSpeechFailure | null>;
      /** Shows macOS's microphone prompt the first time, then the app's grant ('granted' off macOS) */
      micAsk(): Promise<MicAccess>;
      /** Opens System Settings › Privacy & Security › Microphone */
      micSettings(): Promise<void>;
    };
  }
}
