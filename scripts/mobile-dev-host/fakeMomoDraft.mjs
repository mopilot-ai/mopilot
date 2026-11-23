// DEV ONLY: a draft MoMo wrote, as the Mac puts it in MoMo's chat for the phone (a note row with `draft`, electron/capabilities/browser/chromePanelLive.cjs), for the scenario `momo-draft` (design/phone-on-orca/momo-drafts-contract.md). It only adds or removes rows in the fake chat; nothing is sent anywhere.
import { SENT_SHAPES, raiseSentDraft } from './fakeMomoDraftSent.mjs';

export const SHAPES = Object.freeze(['one', 'long', ...SENT_SHAPES, 'off']);

const ONE = {
  to: ['sam@example.com', 'lee@example.com'],
  subject: 'Re: Friday lunch',
  body: 'Hi Sam,\n\nFriday works for me. Noon at the usual place?\n\nThanks,\nAlex',
};
/** A body far over what a mail link carries, under what a draft may hold: Copy works, Open in Mail says it is too long. */
/** (tests/mobileDevHostDraft.test.ts holds both to the Mac's own check) */
const LONG = {
  to: ['sam@example.com'],
  subject: 'Notes from the review',
  body: 'The review covered the plan, the schedule and the open risks in detail. '.repeat(40).slice(0, 2600),
};

/**
 * The rows `momo-draft <shape>` puts in a chat.
 * @param {string} shape one, long, sent, asked, unsure or off @param {{ id: string, rows: any[] }} chat @param {() => number} now
 * @returns {string} what happened
 */
export function raiseDraft(shape, chat, now) {
  if (!SHAPES.includes(shape)) throw new Error(`The shape must be one of ${SHAPES.join(', ')}.`);
  if (SENT_SHAPES.includes(shape)) return raiseSentDraft(shape, chat, now);
  if (shape === 'off') {
    const kept = chat.rows.filter((r) => !r.draft);
    const removed = chat.rows.length - kept.length;
    chat.rows.splice(0, chat.rows.length, ...kept);
    return `${removed} draft${removed === 1 ? '' : 's'} removed from MoMo's chat`;
  }
  const draft = shape === 'long' ? LONG : ONE;
  chat.rows.push({
    role: 'note',
    text: `Draft · ${draft.subject}`,
    draft,
    at: now(),
    id: `${chat.id}-r${chat.rows.length + 1}`,
  });
  return shape === 'long'
    ? 'a long draft is in MoMo’s chat: Copy works, Open in Mail says it is too long'
    : 'a draft for two people is in MoMo’s chat: Edit, Copy and Open in Mail';
}
