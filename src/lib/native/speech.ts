// Typed main-owned speech readiness, capture and durable audio-message bridge.
import type { SpeechOptions } from '../../../shared/speech.mjs';
import type { CapsHint } from '../../store/session/capsTypes';
import type { Attachment } from '../../store/types';
declare module '../native' {
  interface NativeApi {
    speech: {
      hold(key: string, draft: { text: string; attachments: Attachment[] }, chatId: string | null, hint?: CapsHint): Promise<string>;
      finishTransfer(id: string, preserve?: boolean): Promise<void>;
      drafts(): Promise<Record<string, { text: string; attachments: Attachment[]; goal?: boolean }>>;
      draft(key: string, draft: { text: string; attachments: Attachment[]; goal?: boolean }): Promise<void>;
      options(chatId?: string | null, hint?: CapsHint): Promise<SpeechOptions>;
      /** false only when every dictation service is known to be blocked here; never launches the speech helper */
      available(chatId?: string | null, hint?: CapsHint): Promise<boolean>;
      begin(chatId: string | null, hint?: CapsHint): Promise<string>;
      conversation(id: string, params: Record<string, unknown>): Promise<unknown>;
      current(id: string): Promise<boolean>;
      end(id: string): Promise<void>;
      save(id: string, bytes: Uint8Array): Promise<Attachment>;
      read(path: string): Promise<string>;
      transcribe(
        id: string,
        bytes: Uint8Array,
        mime: string,
        language: string | undefined,
        engine: string,
        /** how long the window waits for the answer: main stops the request after it */
        waitMs?: number,
      ): Promise<{ text?: string; error?: string }>;
      /** Streaming recognition for capture `id` on `engine` (this Mac's, or the ChatGPT login's); rejects when it can't */
      streamStart(id: string, language: string, engine?: 'local' | 'chatgpt'): Promise<void>;
      /** one frame of 16 kHz mono 16-bit PCM */
      streamAudio(id: string, pcm: Uint8Array): Promise<void>;
      /** the final text once every frame is in, or why there is none */
      streamFinish(id: string): Promise<{ text?: string; error?: string }>;
      streamCancel(id: string): Promise<void>;
      /** each new guess (`text`, all heard so far) or the stream's failure, for capture `id` */
      onStream(cb: (e: { id: string; text?: string; error?: string }) => void): () => void;
    };
  }
}
