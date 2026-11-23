// DEV ONLY: a draft the user already sent from the Mac's card, as the Mac puts it in MoMo's chat for the phone (a note row with `draft` and `send`, electron/capabilities/browser/chromePanelLive.cjs), for the scenario `momo-draft sent|asked|unsure`. It only adds rows to the fake chat; the account is a fake .test address and nothing is sent anywhere.
export const SENT_SHAPES = Object.freeze(['sent', 'asked', 'unsure']);

const DRAFT = {
  to: ['sam@example.com'],
  subject: 'Re: Friday lunch',
  body: 'Hi Sam,\n\nFriday works for me. Noon at the usual place?\n\nThanks,\nAlex',
};
const FROM = Object.freeze({ id: 'test-mail-home', label: 'Test mail (home)', account: 'home@mail.test' });
const SAID = Object.freeze({
  sent: 'a sent draft is in MoMo’s chat: read only, with “Asked to send”, “You chose Send” and the sent line',
  asked: 'a draft the Mac asked to send is in MoMo’s chat: read only, “Asked to send”',
  unsure: 'a draft the Mac is not sure it sent is in MoMo’s chat: read only, with where to look',
});

/**
 * The row `momo-draft <state>` puts in a chat.
 * @param {string} state sent, asked or unsure @param {{ id: string, rows: any[] }} chat @param {() => number} now
 * @returns {string} what happened
 */
export function raiseSentDraft(state, chat, now) {
  if (!SENT_SHAPES.includes(state)) throw new Error(`The state must be one of ${SENT_SHAPES.join(', ')}.`);
  const at = now();
  chat.rows.push({
    role: 'note',
    text: `Draft · ${DRAFT.subject}`,
    draft: DRAFT,
    send: { state, from: FROM, at },
    at,
    id: `${chat.id}-r${chat.rows.length + 1}`,
  });
  return SAID[/** @type {keyof typeof SAID} */ (state)];
}
