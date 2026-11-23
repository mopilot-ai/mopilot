// One recorded clip to the dictation services in order: WAV for this Mac (after macOS's first-use prompt), the recorder's
// webm for the others, moving on to the next service only when one couldn't transcribe it (not when the user or main
// refused the clip), until one answers.
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { recordingToWav, type DictationEngine } from '../../lib/dictation';
import { askSpeech, speechGate, SPEECH_TEXT, SPEECH_TRANSCRIBE_MS, timedOut, withTimeout } from '../../lib/localSpeech';
import { speechFailure, speechLabel, speechSettles, takesWav } from '../../../shared/speech.mjs';

/** `final`: a refusal of the clip itself (the user declined, main ended the capture): no other service is asked. */
export type Sent = { text?: string; error?: string; final?: boolean };

/** How long a service may take when another one could still be asked; the last one gets the full wait. */
export const SPEECH_NEXT_MS = 45_000;

/** What a send reports while it runs: macOS's prompt is up, or the clip moved on to the next service. */
export interface SendProgress {
  asking(on: boolean): void;
  trying(engine: DictationEngine): void;
}

export const engineLabel = (engine: DictationEngine) => speechLabel(engine);

/** An answer no other service would change: text (even none), a clip too short, dictation switched off, or a refusal. */
export const settles = (r: Sent) => !!r.final || speechSettles(r);

/** The clip on one service; null once the recording was given up (`live` false) so nothing more is said. */
export async function sendClip(
  engine: DictationEngine,
  o: { blob: Blob; lang: string; owner: string; live: () => boolean; progress: SendProgress; waitMs: number },
): Promise<Sent | null> {
  try {
    let sent: Promise<Sent>;
    if (engine === 'local') {
      // macOS asks on the first use: the composer says so while it waits, and a refusal ends this service here
      const gate = await speechGate(o.lang);
      if (!o.live()) return null;
      if (gate === 'ask') {
        o.progress.asking(true);
        const { answer, why } = await askSpeech(o.lang);
        if (!o.live()) return null;
        o.progress.asking(false);
        // the user just declined (or the prompt failed): the clip stops here rather than going to another service
        if (answer !== 'granted') return { error: why || SPEECH_TEXT[answer], final: true };
        if ((await speechGate(o.lang)) !== 'ready') return { error: SPEECH_TEXT.unavailable };
      } else if (gate !== 'ready') return { error: SPEECH_TEXT[gate] };
      const wav = await recordingToWav(o.blob);
      if (!o.live()) return null;
      sent = native.speech.transcribe(o.owner, wav, 'audio/wav', o.lang, engine, o.waitMs);
    } else if (takesWav(engine)) {
      const wav = await recordingToWav(o.blob);
      if (!o.live()) return null;
      sent = native.speech.transcribe(o.owner, wav, 'audio/wav', o.lang === 'auto' ? undefined : o.lang, engine, o.waitMs);
    } else {
      const audio = new Uint8Array(await o.blob.arrayBuffer());
      if (!o.live()) return null;
      sent = native.speech.transcribe(o.owner, audio, 'audio/webm', o.lang === 'auto' ? undefined : o.lang, engine, o.waitMs);
    }
    // a service that never answers still ends the wait, and main stops its request then too
    const answered = await withTimeout(sent, o.waitMs);
    if (!o.live()) return null;
    return timedOut(answered) ? { error: SPEECH_TEXT.timeout } : answered;
  } catch (e) {
    // a service's failure comes back as its answer; a throw is main refusing the clip (an ended capture, a bad request)
    return { error: errorText(e) || "Couldn't transcribe the recording", final: true };
  }
}

/**
 * The clip on each service in `chain` until one settles it. With every one failing, each says why
 * ("This Mac: … · ChatGPT account: …"); one alone keeps its own words.
 */
export async function sendAlong(
  chain: DictationEngine[],
  o: Omit<Parameters<typeof sendClip>[1], 'waitMs'>,
): Promise<(Sent & { engine?: DictationEngine }) | null> {
  const failed: { engine: DictationEngine; error: string }[] = [];
  for (const [i, engine] of chain.entries()) {
    if (i > 0) o.progress.trying(engine);
    const sent = await sendClip(engine, { ...o, waitMs: i < chain.length - 1 ? SPEECH_NEXT_MS : SPEECH_TRANSCRIBE_MS });
    if (!sent) return null;
    if (settles(sent)) {
      const { final: _final, ...answer } = sent;
      return { ...answer, engine };
    }
    failed.push({ engine, error: String(sent.error) });
  }
  return { error: failed.length ? speechFailure(failed) : "Couldn't transcribe the recording" };
}
