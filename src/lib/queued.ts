// A queued follow-up as the queue tray shows it, and how "Edit message" puts it back in the composer.
import type { Attachment } from '../../shared/model/store';
import type { QueuedMessage } from '../../shared/model/session';
import type { SideSessionDelivery } from '../../shared/orchestration';
import { basename } from './paths';
import { withoutHiddenBlocks } from '../../shared/userText.mjs';
import { DELIVERY_BODY_CHARS } from '../../shared/deliveryBody.mjs';
import { AUTHOR_LABEL, type AuthoredInput } from './authoredInput';

/** A brief, message or wake-up main delivered from another session, as its row and preview read. */
export type QueuedSide = { label: string; body: string };

/**
 * What a queued item another session sent reads as, as Claude Desktop 4.29.0 words it ("Received message from <session>"
 * in place of the envelope): `name` is the sender's title, null while this window doesn't know it.
 */
export function sideQueued(delivery: SideSessionDelivery, name: string | null): QueuedSide {
  const from = name ?? 'another session';
  // main keeps the first DELIVERY_BODY_CHARS of a message: a longer one says it goes on
  if (delivery.kind === 'message')
    return {
      label: `Received message from ${from}`,
      body: delivery.body.length < DELIVERY_BODY_CHARS ? delivery.body : `${delivery.body}…`,
    };
  if (delivery.kind === 'brief') return { label: `Task from ${from}`, body: delivery.body };
  const n = delivery.notes.length;
  return {
    label: `${n === 1 ? 'Report' : 'Reports'} from ${n} ${n === 1 ? 'session' : 'sessions'}`,
    body: delivery.notes.map((x) => x.body).join('\n\n'),
  };
}

/** What a queued message from another chat reads as, the same way; `name` is what this window calls it now. */
export function peerQueued(peer: NonNullable<QueuedMessage['peer']>, name: string | null): QueuedSide {
  return { label: `Received message from ${name ?? peer.sourceTitle ?? 'another session'}`, body: peer.body ?? '' };
}

/**
 * What a row shows: the message as its bubble will (no hidden blocks), else the names of what it attaches; one no human
 * wrote (`shown`, its chat's record of it) by its author and title, never its text; one another session sent (`side`) by
 * who sent it.
 */
export const queuedLabel = (q: QueuedMessage, shown: AuthoredInput | null = null, side: QueuedSide | null = null) =>
  shown
    ? `${AUTHOR_LABEL[shown.by]}: ${shown.title}`
    : (side?.label ?? (withoutHiddenBlocks(q.text) || q.attachments.map((a) => a.name || basename(a.path)).join(', ')));

/**
 * Whether the user wrote this queued item: not one another session or chat sent (`sideSession`, `peer`) nor an input no
 * human wrote (`authored`). Only these go back to the composer (Edit message, a harness switch); the item's own marker decides, never
 * a record this window may not have loaded yet.
 */
export const isUserQueued = (q: Partial<QueuedMessage>): boolean => !q.sideSession && !q.peer && !q.authored;

/** The composer once a queued message comes back to it: its text goes first, its attachments too. */
export function withQueued(text: string, attachments: Attachment[], q: Pick<QueuedMessage, 'text' | 'attachments'>) {
  // what the user sees of it: a hidden block (a Continue in Chrome's routing note) never lands in the composer
  const own = withoutHiddenBlocks(q.text);
  return { text: text.trim() ? `${own}\n${text}` : own, attachments: [...q.attachments, ...attachments] };
}
