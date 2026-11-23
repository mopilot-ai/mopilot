// Preparing and cancelling composer voice attempts, with draft ownership and chat-opening handover.

import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import { useEffectOn } from '../../lib/effects';
import { startVoiceChat, stopVoice } from '../../session/voice';
import { errorText } from '../../lib/ignored';
import { ownsComposerCommand } from '../../lib/shortcutFocus';
import { toast } from '../../store/core';

export function useComposerVoice(
  threadId: string | null,
  draftKey: string,
  voiceOn: boolean,
  anchor: RefObject<HTMLElement | null>,
  openOptions?: () => void,
) {
  const [preparingVoice, setPreparingVoice] = useState(false);
  const voicePreparation = useRef<AbortController | null>(null);
  // the pending attempt is opening the chat voice will run in: that switch hands it over instead of cancelling it
  const voiceOpening = useRef<AbortController | null>(null);
  // a voice attempt still preparing belongs to the draft it was started from: leaving that draft (or closing the
  // editor) cancels it
  useEffectOn([draftKey], () => () => {
    const pending = voicePreparation.current;
    if (pending !== voiceOpening.current) pending?.abort();
    voicePreparation.current = null;
    voiceOpening.current = null;
    setPreparingVoice(false);
  });
  useEffectOn([draftKey, voiceOn], () => () => {
    if (voiceOn) void stopVoice().catch((error) => toast(`Couldn't end voice: ${errorText(error)}`, 'error'));
  });
  const toggleVoice = async (conversation = false) => {
    if (voicePreparation.current) {
      const pending = voicePreparation.current;
      voicePreparation.current = null;
      pending.abort();
      setPreparingVoice(false);
      return;
    }
    if (voiceOn) return stopVoice();
    if (!conversation && openOptions) return openOptions();
    const pending = new AbortController();
    voicePreparation.current = pending;
    setPreparingVoice(true);
    try {
      await startVoiceChat(threadId, pending.signal, () => {
        voiceOpening.current = pending;
      });
    } catch (error) {
      if (!pending.signal.aborted) toast(`Couldn't start voice: ${errorText(error)}`, 'error');
    } finally {
      if (voicePreparation.current === pending) {
        voicePreparation.current = null;
        voiceOpening.current = null;
        setPreparingVoice(false);
      }
    }
  };
  const shortcut = useEffectEvent((event: Event) => {
    if (ownsComposerCommand(event, anchor.current)) void toggleVoice();
  });
  useEffect(() => {
    const receive = (event: Event) => shortcut(event);
    window.addEventListener('start-voice', receive);
    return () => window.removeEventListener('start-voice', receive);
  }, []);
  const voiceBusy = voiceOn || preparingVoice;
  return { voiceBusy, toggleVoice };
}
