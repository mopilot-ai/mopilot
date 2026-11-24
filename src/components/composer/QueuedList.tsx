// The queue tray behind the composer: one row per waiting message, to steer now, remove, edit or copy.

import { useSessionField } from '../../store/session/useSession';
import type { QueuedMessage } from '../../store/session/sessionState';
import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { usePresentList } from '../ui/Presence';
import { prefersReducedMotion } from '../../lib/paneMotion';
import { giveBackToComposer, removeQueued, sendQueuedNow } from '../../store/send';
import { toast, useStore } from '../../store/core';
import { isUserQueued, peerQueued, queuedLabel, sideQueued } from '../../lib/queued';
import { sideSessionForItem, useOrchestrationSelect } from '../../lib/sideSessions';
import { useChatName } from '../markdown/useChatName';
import { authoredFor } from '../../lib/authoredInput';
import { userError } from '../../lib/ignored';
import { native } from '../../lib/native';
import { useHostMachines } from '../../lib/hostMachines';
import { hostUpdateLine } from '../../lib/machineStatus';
import { picksFolder, refusalActionLabel, runRefusalAction } from '../../session/refusalAction';
import { copyText } from '../../session/clipboard';
import { Menu, MenuItem, Tooltip, useAnchor } from '../ui/Popover';
import { QueuedPreview } from './QueuedPreview';
import { HostFolderPicker } from './HostFolderPicker';
import { Copy, CornerDownRight, Ellipsis, ListEnd, PenLine, Trash2 } from '../ui/icons';

/** How long a queued row takes to leave (sent or removed): Claude Desktop's queued cards, --dur-base. */
export const QUEUE_LEAVE_MS = 200;

const SEND_HINT = 'Sends at the agent’s next step';
/** What the button says with no turn running: there is nothing to steer, so it sends the message now. */
const IDLE_HINT = 'Send this queued message now';
const REPLACES_INPUT = new Set<string | null>(['newChat', 'chooseFolder', 'useMode']);

/**
 * A rail joined to the composer's top edge, following Codex's queue: one row per waiting message, each with the queue
 * glyph, a one-line prompt that opens a full preview, Steer, Remove and a ⋯ menu (Edit message, Copy), which a right-click, Shift-F10
 * or the Context Menu key on the row also opens. As Claude Desktop's queued cards do, a row queued while the tray
 * shows rises in, and a row sent or removed drops away (queue-enter, queue-leaving); rows already queued when the chat
 * opens are simply there. There is no drag handle: the queue has no reorder operation.
 */
export function QueuedList({ threadId, onEdit }: { threadId: string; onEdit?: (q: QueuedMessage) => void }) {
  const session = useSessionField(threadId, (s) => ({ queue: s.queue, turn: s.turn }));
  const queued = session.queue;
  const keyOf = useCallback((q: QueuedMessage) => JSON.stringify([threadId, q.id]), [threadId]);
  const rows = usePresentList(queued, keyOf, prefersReducedMotion() ? 0 : QUEUE_LEAVE_MS);
  // the rows there when this chat's tray first rendered: they don't play an entrance
  const first = useRef<Set<string> | null>(null);
  first.current ??= new Set(queued.map(keyOf));
  if (!rows.length) return null;
  return (
    <div className="queue-tray" data-queue-chat={threadId}>
      <div className="queue-list" role="list" aria-label="Queued messages">
        {rows.map((r) => (
          <QueuedRow
            key={r.key}
            threadId={threadId}
            q={r.item}
            idle={session.turn === 'idle' || session.turn === 'crashed'}
            onEdit={onEdit}
            enter={!first.current!.has(r.key)}
            leaving={r.leaving}
          />
        ))}
      </div>
    </div>
  );
}

/** The message as the tray shows it: when it will be sent first, so truncating a long message never hides it. */
function QueuedText({ q, label }: { q: QueuedMessage; label: string }) {
  return (
    <>
      {q.pendingStart && <span className="queue-wait">Delivery unconfirmed{q.error ? `: ${q.error}` : ''} · </span>}
      {!q.pendingStart && q.waitingFor && (
        <span className="queue-wait">
          {q.waitingFor === 'compaction'
            ? 'Will send after compaction'
            : q.waitingFor === 'voiceConversation'
              ? 'Waiting for voice conversation to close'
              : q.waitingFor === 'audioRecovery'
                ? 'Recovered audio · Review before sending'
                : q.waitingFor === 'host'
                  ? 'Waiting for host'
                  : q.waitingFor === 'hostMoving'
                    ? `Waiting for the switch${q.movingTo ? ` to ${q.movingTo}` : ''}`
                    : q.waitingFor === 'hostMoved'
                      ? 'Chat moved to another machine'
                      : q.waitingFor === 'hostRefused'
                        ? (q.refusal?.own || q.refusal?.named) && q.error
                          ? q.error
                          : `Host did not accept it${q.error ? `: ${q.error}` : ''}`
                        : q.waitingFor === 'orgSignin'
                          ? 'Organization sign-in needed'
                          : 'Retry when ready'}{' '}
          ·{' '}
        </span>
      )}
      {label}
    </>
  );
}

function QueuedRow({
  threadId,
  q,
  idle,
  onEdit,
  enter,
  leaving,
}: {
  threadId: string;
  q: QueuedMessage;
  /** no turn is running: the message is sent, not steered into one */
  idle: boolean;
  onEdit?: (q: QueuedMessage) => void;
  enter: boolean;
  leaving: boolean;
}) {
  const more = useAnchor();
  // one no human wrote (MoMo's routine result) shows as its author's, and isn't the user's to edit
  const shown = useStore((st) => (q.authored ? authoredFor(st.authoredInputs, threadId, { clientId: q.authored.id }) : null));
  // one another session sent shows as who sent it (Claude Desktop's "Received message from"), with its body to preview
  const delivery = useOrchestrationSelect((v) => sideSessionForItem(v, { clientId: q.sideSession?.id }));
  const senderName = useChatName(delivery && 'from' in delivery ? delivery.from : (q.peer?.sourceChatId ?? ''));
  const side = delivery ? sideQueued(delivery, senderName) : q.peer ? peerQueued(q.peer, senderName) : null;
  const label = queuedLabel(q, shown, side);
  const body = shown ? label : (side?.body ?? label);
  // where a right-click opened the menu, or null for the ⋯ button
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [sending, setSending] = useState(false);
  // the machine's folder picker, open for "Choose a folder"
  const [picking, setPicking] = useState(false);
  const pending = useRef(false);
  const send = async () => {
    if (pending.current) return;
    pending.current = true;
    setSending(true);
    try {
      const result = await sendQueuedNow(threadId, q.id);
      if (result.status === 'missing') toast('This message is no longer in the queue.', 'error');
      else if (result.status === 'queued' && result.waitingFor === 'compaction')
        toast('Message queued. It will send after compaction finishes.', 'info');
      else if (result.status === 'queued' && result.waitingFor === 'compactionRetry')
        toast('Message kept in the queue. Retry when you’re ready.', 'info');
      else if (result.status === 'queued' && result.waitingFor === 'host')
        toast('The host is not reachable yet. This message will send when it is.', 'info');
      else if (result.status === 'queued')
        toast(
          result.error
            ? `Message kept in queue: ${userError(result.error)}`
            : 'Message moved to the front of the queue. It will send after the current turn.',
          result.error ? 'error' : 'info',
        );
      else if (result.status === 'failed')
        toast(
          `Could not send queued message: ${userError(result.error, { fallback: 'The harness did not accept the message.' })}`,
          'error',
        );
    } catch (error) {
      toast(`Could not send queued message: ${userError(error)}`, 'error');
    } finally {
      pending.current = false;
      setSending(false);
    }
  };
  const remove = async (onRemoved?: () => void) => {
    let removed = false;
    try {
      removed = await removeQueued(threadId, q.id);
      if (removed) {
        onRemoved?.();
      }
    } catch (error) {
      toast(
        `${removed ? 'Message removed, but could not restore its draft' : 'Could not remove queued message'}: ${userError(error)}`,
        'error',
      );
    }
    return removed;
  };
  // editing gives the message back to the composer, only once it has left the queue
  const edit = onEdit && isUserQueued(q) && (() => remove(() => onEdit(q)));
  // a message a Host refused: the one action that fixes the cause when there is one, Retry only where sending it again can succeed
  const refusal = q.waitingFor === 'hostRefused' ? q.refusal : undefined;
  const pendingStart = q.pendingStart === true;
  const recover = async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const source = useStore.getState().paneTabs.find((tab) => tab.kind === 'chat' && tab.threadId === threadId)?.sourceChatId;
      if (!source) throw new Error('Open the parent chat to recover this draft.');
      const { openSideChat } = await import('../../store/actions');
      const child = await openSideChat(source, undefined, undefined, { recoveryFrom: threadId });
      if (child) giveBackToComposer(child, q.text, q.attachments);
    } catch (error) {
      toast(`Could not recover the draft: ${userError(error)}`, 'error');
    } finally {
      pending.current = false;
    }
  };
  const { machines } = useHostMachines();
  const refused = refusal ? machines.find((m) => m.id === refusal.hostId) : undefined;
  // An unconfirmed input can still be retried with its own key after sign-in or another in-place fix.
  const fix = refusal && !(pendingStart && REPLACES_INPUT.has(refusal.action)) ? refusalActionLabel(refusal, refused) : null;
  // an Update that cannot work from here says why, in the machine row's words (a newer Host, a machine added by command)
  const updateNote = refusal?.action === 'update' && !fix && refused ? hostUpdateLine(refused)?.text : undefined;
  const retry = q.waitingFor === 'compactionRetry' || (q.waitingFor === 'hostRefused' && (!refusal || refusal.retry));
  // a message that waits for the organization sign-in on this Mac: one click signs in, and the queue goes on its own
  const signinFirst = q.waitingFor === 'orgSignin';
  const afterTurn = !!q.opts.compact && !idle;
  const sendLabel = afterTurn ? 'After turn' : signinFirst ? 'Sign in' : fix ? fix : retry ? 'Retry' : idle ? 'Send' : 'Steer';
  // nothing in place can fix it and sending again would be refused again: the row offers Remove and Copy only
  const stuck = (q.waitingFor === 'hostRefused' && !fix && !retry) || q.steered === true;
  const signIn = async () => {
    if (pending.current) return;
    pending.current = true;
    setSending(true);
    try {
      await native.host.orgSignIn();
    } catch (error) {
      toast(`Could not sign in: ${userError(error)}`, 'error');
    } finally {
      pending.current = false;
      setSending(false);
    }
  };
  const runFix = async (folder?: string) => {
    if (pending.current || !refusal) return;
    // the picker comes first; the folder it gives is what the action then runs with
    if (picksFolder(refusal) && folder === undefined) return setPicking(true);
    pending.current = true;
    setSending(true);
    try {
      await runRefusalAction(
        refusal,
        { chatId: threadId, text: q.text, attachments: q.attachments, opts: q.opts, removeRow: () => remove() },
        folder,
      );
    } catch (error) {
      toast(`${sendLabel} failed: ${userError(error)}`, 'error');
    } finally {
      pending.current = false;
      setSending(false);
    }
  };
  // a right-click, Shift-F10 or the Context Menu key on the row opens the menu there; events from the open menu, which
  // React bubbles here through its portal, are the menu's own
  const openAt = (e: MouseEvent | KeyboardEvent, point: { x: number; y: number }) => {
    if (!e.currentTarget.contains(e.target as Node)) return;
    e.preventDefault();
    setAt(point);
    more.setOpen(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    const box = e.currentTarget.getBoundingClientRect();
    openAt(e, { x: box.left, y: box.bottom });
  };
  return (
    <div
      className={`queue-row${more.open ? ' menu-open' : ''}${sending ? ' queue-sending' : ''}${enter ? ' queue-enter' : ''}${leaving ? ' queue-leaving' : ''}`}
      role="listitem"
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      onContextMenu={(e) => openAt(e, { x: e.clientX, y: e.clientY })}
      onKeyDown={onKeyDown}
    >
      <ListEnd size={15} strokeWidth={1.6} className="queue-icon" aria-hidden />
      <QueuedPreview threadId={threadId} label={label} body={body} leaving={leaving}>
        <QueuedText q={q} label={label} />
        {updateNote && <span className="host-update-note"> · {updateNote}</span>}
      </QueuedPreview>
      <div className="queue-actions">
        {/* a message held after a failed compaction is retried, as Codex retries a paused one */}
        {!stuck && (
          <Tooltip
            label={
              afterTurn
                ? 'Compacts after the current turn'
                : signinFirst
                  ? 'Sign in to your organization; this message sends after'
                  : fix
                    ? 'Fix this, then the message can go'
                    : retry
                      ? 'Try sending this queued message again'
                      : idle
                        ? IDLE_HINT
                        : SEND_HINT
            }
          >
            <button
              className="queue-steer"
              type="button"
              aria-label={sendLabel}
              aria-busy={sending || undefined}
              disabled={sending || afterTurn}
              onClick={signinFirst ? signIn : fix ? () => runFix() : send}
            >
              <CornerDownRight size={14} strokeWidth={1.7} />
              <span className="queue-steer-label">{sendLabel}</span>
            </button>
          </Tooltip>
        )}
        {/* a refusal whose cause the action fixes and that the same message can then pass: the fix first, then Retry */}
        {fix && retry && (
          <Tooltip label="Try sending this queued message again">
            <button
              className="queue-steer"
              type="button"
              aria-label="Retry"
              aria-busy={sending || undefined}
              disabled={sending}
              onClick={send}
            >
              <CornerDownRight size={14} strokeWidth={1.7} />
              <span className="queue-steer-label">Retry</span>
            </button>
          </Tooltip>
        )}
        {!pendingStart && (
          <Tooltip label="Remove">
            <button className="icon-btn xs" type="button" aria-label="Remove from queue" disabled={sending} onClick={() => remove()}>
              <Trash2 size={15} strokeWidth={1.7} />
            </button>
          </Tooltip>
        )}
        <button
          ref={more.ref}
          className={`icon-btn xs ${more.open ? 'on' : ''}`}
          type="button"
          aria-label="Queued message actions"
          aria-haspopup="menu"
          aria-expanded={more.open}
          onClick={() => {
            setAt(null);
            more.toggle();
          }}
        >
          <Ellipsis size={15} strokeWidth={1.7} />
        </button>
      </div>
      <Menu anchor={at ?? more.anchor} open={more.open} onClose={more.close} placement={at ? 'bottom-start' : 'top-end'} width={180}>
        {pendingStart ? (
          <MenuItem disabled={sending} icon={<PenLine size={14} strokeWidth={1.7} />} onSelect={recover}>
            Recover as draft
          </MenuItem>
        ) : (
          edit && (
            <MenuItem disabled={sending} icon={<PenLine size={14} strokeWidth={1.7} />} onSelect={edit}>
              Edit message
            </MenuItem>
          )
        )}
        <MenuItem icon={<Copy size={14} strokeWidth={1.7} />} onSelect={() => copyText(body, 'Copied message')}>
          Copy
        </MenuItem>
      </Menu>
      {picking && refusal && (
        <HostFolderPicker
          hostId={refusal.hostId}
          name={refusal.machine}
          onClose={() => setPicking(false)}
          onPick={(folder) => {
            setPicking(false);
            void runFix(folder);
          }}
        />
      )}
    </div>
  );
}
