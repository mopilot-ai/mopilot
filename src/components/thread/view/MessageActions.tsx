// Final-response copy, direct good/bad rating, fork and (with a turn trace) Replay controls.
import { useEffect, useRef, useState } from 'react';
import { toastFailure } from '../../../store/core';
import { forkThread } from '../../../store/actions';
import { rateReply } from '../../../session/chatActions';
import { Tooltip } from '../../ui/Popover';
import { Copy, ThumbsUp, ThumbsDown, Split, Check } from '../../ui/icons';
import { useCopyConfirm } from '../../../session/copyConfirm';
import { TurnReplay } from './TurnReplay';
import { heartbeatMessage } from '../../../../shared/heartbeatMessage.mjs';

/** The copy button's key: this response is the only thing it copies, and its text may be empty. */
const RESPONSE = 'response';

export function MessageActions({
  text,
  threadId,
  turnId,
  startedAt,
  completedAt,
}: {
  text: string;
  threadId: string;
  turnId: string;
  /** the turn's own time (seconds): a turn trace that started and ended with it is its Replay */
  startedAt?: number | null;
  completedAt?: number | null;
}) {
  const { copied, copy } = useCopyConfirm();
  const [rating, setRating] = useState<null | 'good' | 'bad'>(null);
  const latest = useRef<object | null>(null);
  // A different response retires both the selection and pending UI completions.
  useEffect(() => {
    latest.current = { threadId, turnId };
    setRating(null);
    return () => {
      latest.current = null;
    };
  }, [threadId, turnId]);
  const send = async (kind: 'good' | 'bad') => {
    const attempt = {};
    latest.current = attempt;
    setRating(kind);
    // Every click is sent; only the latest attempt can clear the selection on failure.
    if (!(await rateReply(threadId, kind)) && latest.current === attempt) setRating(null);
  };
  return (
    <div className="message-actions">
      {/* keyed, not tested for truth: an empty response still confirms that it reached the clipboard */}
      <Tooltip label={copied === RESPONSE ? 'Copied' : 'Copy'}>
        <button className="icon-btn xs" aria-label="Copy" onClick={() => copy(heartbeatMessage(text), RESPONSE)}>
          {copied === RESPONSE ? <Check size={15} className="copy-check" /> : <Copy size={15} />}
        </button>
      </Tooltip>
      <Tooltip label="Good response">
        <button
          className={`icon-btn xs ${rating === 'good' ? 'on' : ''}`}
          aria-label="Good response"
          aria-pressed={rating === 'good'}
          onClick={() => send('good')}
        >
          <ThumbsUp size={15} />
        </button>
      </Tooltip>
      <Tooltip label="Bad response">
        <button
          className={`icon-btn xs ${rating === 'bad' ? 'on' : ''}`}
          aria-label="Bad response"
          aria-pressed={rating === 'bad'}
          onClick={() => send('bad')}
        >
          <ThumbsDown size={15} />
        </button>
      </Tooltip>
      <Tooltip label="Fork chat from here">
        <button
          className="icon-btn xs"
          aria-label="Fork chat from here"
          onClick={() => forkThread(threadId, turnId).catch(toastFailure("Couldn't fork the chat"))}
        >
          <Split size={15} style={{ transform: 'rotate(90deg)' }} />
        </button>
      </Tooltip>
      <TurnReplay threadId={threadId} startedAt={startedAt} completedAt={completedAt} />
    </div>
  );
}
