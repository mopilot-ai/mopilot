// Dictation into MoMo (#2139): the app's own Dictate button, on this Mac's speech recognition only, with the recording kept out of the app's saved recordings; for the MoMo composer and Ask MoMo in Quick Chat.
import { Dictation, type DictationControl } from '../ui/Dictation';
import type { CapsHint } from '../../store/session/capsTypes';
import type { Ref } from 'react';
import { useFlag } from '../../lib/flags';
import { isMac } from '../../lib/platform';

/** Nothing where on-device recognition isn't (off macOS, or switched off by the server). */
export function MomoDictation({
  onText,
  control,
  threadId = null,
  hint = {},
}: {
  threadId?: string | null;
  hint?: CapsHint;
  onText: (text: string) => void;
  control?: Ref<DictationControl>;
}) {
  const local = useFlag('shared.dictation.local');
  if (!(isMac && local)) return null;
  return <Dictation onText={onText} engine="local" keepRecording={false} control={control} threadId={threadId} hint={hint} />;
}
