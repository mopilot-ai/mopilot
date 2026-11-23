// The composer's voice conversation button: the chat harness's own realtime voice, only where the chat declares it.
// Without it an empty composer keeps a disabled Send in that place, as dictation has its own button.
import type { AnimationEventHandler } from 'react';
import { Tooltip } from '../ui/Popover';
import { ArrowUp, Waveform, X } from '../ui/icons';
import { COPY } from '../../harness/copy';
import type { useComposerSpeech } from './useComposerSpeech';

export function ComposerVoice({
  speech,
  available,
  pending,
  compact,
  morph,
  onAnimationEnd,
}: {
  speech: ReturnType<typeof useComposerSpeech>;
  /** the chat's voiceChat capability is native */
  available: boolean;
  /** the chat is still opening: voice waits for it */
  pending: boolean;
  /** a chat starts, a turn runs or the draft can be sent: the button shrinks beside Send/Stop (else it is in Send's place) */
  compact: boolean;
  morph?: string;
  onAnimationEnd?: AnimationEventHandler<HTMLButtonElement>;
}) {
  const busy = speech.voiceBusy;
  if (!available && !busy)
    return !compact ? (
      <button className="send-btn" disabled aria-label="Send" data-morph={morph} onAnimationEnd={onAnimationEnd}>
        <ArrowUp size={17} strokeWidth={2.2} />
      </button>
    ) : null;
  return (
    <Tooltip label={busy ? 'End voice' : COPY.routing.voiceConversation}>
      <button
        data-morph={compact ? undefined : morph}
        onAnimationEnd={onAnimationEnd}
        className={`${compact ? 'composer-icon-btn' : 'send-btn'} voice ${busy ? 'on' : ''}`}
        aria-label={busy ? 'End voice' : COPY.routing.voiceConversation}
        disabled={pending && !busy}
        onClick={() => void speech.toggleVoice(true)}
      >
        {busy ? <X size={16} /> : <Waveform size={15} />}
      </button>
    </Tooltip>
  );
}
