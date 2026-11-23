// The recording of a voice note and its transcription on the Mac, as one state machine for every composer that offers one: idle, recording, transcribing, and why the last try failed. It sends nothing; the text goes to the caller.
import { useEffect, useRef, useState } from 'react';
import type { Media } from '../platform/media';
import { AccessDenied } from '../platform/accessDenied';
import { explain, transcribe, type Capabilities, type Owned } from './client';
import { Cancelled } from './upload';
import { useMeter } from './useMeter';

export type VoicePhase = 'idle' | 'recording' | 'transcribing';

export function useVoiceNote({
  media,
  request,
  caps,
  method,
  onText,
}: {
  media: Media;
  request: Owned;
  caps: Capabilities | null;
  /** The Mac's method that turns the recording into text; the coding chat's by default. */
  method?: string;
  /** The transcript, while the screen is still there. */
  onText: (text: string) => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  // a refusal the system will not ask about again: the way forward is Settings
  const [denied, setDenied] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const meter = useMeter(media, phase === 'recording');
  const alive = useRef(true);
  const sending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      alive.current = false;
      sending.current?.abort();
      void media.cancelRecording().catch(() => {
        /* Nothing is recording after the view is gone. */
      });
    },
    [media],
  );
  const starting = useRef(false);
  async function start() {
    // a second tap while the microphone prompt or the recorder is still opening must not start another recording
    if (starting.current) return;
    starting.current = true;
    setWaiting(true);
    setError(null);
    setDenied(false);
    try {
      await media.startRecording();
      setPhase('recording');
    } catch (e) {
      setError(explain(e));
      setDenied(e instanceof AccessDenied);
    } finally {
      starting.current = false;
      setWaiting(false);
    }
  }
  async function stop() {
    setPhase('transcribing');
    const controller = new AbortController();
    sending.current = controller;
    try {
      const clip = await media.stopRecording();
      const result = await transcribe(request, clip, caps, controller.signal, method);
      if (alive.current) onText(result.text);
    } catch (e) {
      if (alive.current && !(e instanceof Cancelled)) setError(explain(e));
    } finally {
      sending.current = null;
      if (alive.current) setPhase('idle');
    }
  }
  async function discard() {
    setPhase('idle');
    try {
      await media.cancelRecording();
    } catch (e) {
      setError(explain(e));
    }
  }
  return { phase, error, denied, waiting, meter, start, stop, discard, cancelTranscribing: () => sending.current?.abort() };
}
