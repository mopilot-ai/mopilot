// Composer speech controls belong to the draft: a chat, account, model or dictation-setting change doesn't end them
// (main resolves the engine and account when a clip is transcribed).
import { useRef, type RefObject } from 'react';
import { dictateInto } from '../ui/dictationTarget';
import { holdToTalk } from './holdToTalk';
import type { ComposerInputElement } from './ComposerInput';
import { useVoice } from '../../session/voice';
import { useComposerVoice } from './useComposerVoice';
import type { DictationControl } from '../ui/Dictation';
export function useComposerSpeech(
  threadId: string | null,
  draftKey: string,
  anchor: RefObject<HTMLElement | null>,
  input: RefObject<ComposerInputElement | null>,
  setText: (update: (draft: string) => string) => void,
) {
  const ownerKey = draftKey;
  const voicePhase = useVoice((v) => v.phase);
  const voiceThread = useVoice((v) => v.threadId);
  const voiceHere = voicePhase !== 'idle' && voiceThread === threadId;
  const voiceOn = voiceHere && voicePhase !== 'error';
  const dictationControl = useRef<DictationControl>(null);
  // the voice shortcut and hotkey dictate (Automatic): a tap toggles, a press held in this window talks until released;
  // the voice conversation has its own button
  const dictate = () => {
    const control = dictationControl.current;
    if (!control) return;
    const starting = !control.recording();
    void control.dictate();
    if (starting && document.hasFocus()) holdToTalk(() => control.stop());
  };
  const { voiceBusy, toggleVoice } = useComposerVoice(threadId, ownerKey, voiceOn, anchor, dictate);
  // dictated text goes in at the caret, as typed words would
  const insertText = (text: string) => dictateInto(input.current, text, setText);
  return { voiceHere, voiceOn, dictationControl, voiceBusy, toggleVoice, ownerKey, insertText };
}
