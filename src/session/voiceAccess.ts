// Whether voice chat can start for a destination chat, read from its capabilities before asking for the microphone.

import type { ChatCaps, CapsHint } from '../store/session/capsTypes';
import { whyText } from '../harness/caps';
import { HARNESS_LABEL, type HarnessId } from '../harness/types';

export const VOICE_UNAVAILABLE = 'Voice conversation is unavailable here. Use Dictate to speak your message.';

/** Read the destination's capabilities before creating a chat or requesting the microphone. */
export async function voiceUnavailable(
  chatId: string | null,
  readCaps: (id: string | null, hint: CapsHint) => Promise<ChatCaps | null>,
  hint: CapsHint = {},
): Promise<string | null> {
  const caps = await readCaps(chatId, hint);
  const cap = caps?.caps.voiceChat;
  if (cap?.state === 'native') return null;
  return cap?.why
    ? whyText(cap.why, {
        semantic: 'voiceChat',
        label: HARNESS_LABEL[caps!.kind as HarnessId] ?? caps?.provider?.label ?? 'this harness',
        provider: caps?.provider?.label,
      })
    : VOICE_UNAVAILABLE;
}
