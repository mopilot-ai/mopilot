// The composer's round Send button (its morph between send, stop and voice is the caller's): sends the draft, or stays off with why when the chat's agent can't take it yet ("Sign in first", useHostSigninNeed.ts).
import { Tooltip } from '../ui/Popover';
import { ArrowUp } from '../ui/icons';
import { RETURN_GLYPH } from '../../lib/composerSendKeys';
import type { SendMorph } from '../../lib/sendMorph';

/**
 * @param label what Send does now (Send, Steer, Queue message)
 * @param block why sending is off, or null; the button stays visible and says it
 */
export function SendButton({
  label,
  shortcut = RETURN_GLYPH,
  block,
  morph,
  onAnimationEnd,
  onSend,
}: {
  label: string;
  shortcut?: string;
  block: string | null;
  morph: SendMorph | null;
  onAnimationEnd: (e: { animationName: string }) => void;
  onSend: () => void;
}) {
  return (
    <Tooltip label={block ?? label} shortcut={block ? undefined : shortcut}>
      <button
        className="send-btn"
        data-morph={morph ?? undefined}
        onAnimationEnd={onAnimationEnd}
        disabled={!!block}
        onClick={onSend}
        aria-label="Send"
      >
        <ArrowUp size={17} strokeWidth={2.2} />
      </button>
    </Tooltip>
  );
}
