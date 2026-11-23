// The composer's Dictate button (#2139): MoMo's own in MoMo's chats (this Mac's speech recognition, no recording kept, MomoDictation.tsx), the app's in every other chat, hidden there while no dictation service can be used.
import { useStore } from '../../store/core';
import { isMomoChat } from '../../lib/momoChats';
import { Dictation, type DictationControl } from '../ui/Dictation';
import type { Ref } from 'react';
import type { CapsHint } from '../../store/session/capsTypes';
import type { Attachment } from '../../store/types';
import { MomoDictation } from './MomoDictation';
import { useDictationAvailable } from '../composer/useDictationAvailable';

export function ComposerDictation({
  threadId,
  onText,
  control,
  hint,
  onAudio,
}: {
  threadId: string | null;
  onText: (text: string) => void;
  control?: Ref<DictationControl>;
  hint?: CapsHint;
  onAudio?: (attachment: Attachment) => void;
}) {
  const momo = useStore((s) => isMomoChat(s.momoChats, threadId));
  const available = useDictationAvailable(threadId, hint, momo);
  return momo ? (
    <MomoDictation onText={onText} control={control} threadId={threadId} hint={hint} />
  ) : (
    <Dictation onText={onText} control={control} threadId={threadId} hint={hint} onAudio={onAudio} available={available} />
  );
}
