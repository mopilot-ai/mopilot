// The chats a Chrome side panel message @ mentions (app/chromePanel.cjs): each read from main's history into the snapshot the window's composer attaches (src/lib/readChatReferences.ts), so every harness gets the same reference.
const { sessionMentions } = require('../../shared/sessionMentions.mjs');
const { transcriptMarkdown } = require('../../shared/transcriptMarkdown.mjs');
const { suffixUnits } = require('../../shared/textPrefix.mjs');

/** The longest snapshot of one chat, its recent end kept (the window's limit). */
const LIMIT = 32_000;
/** How many chats one message may reference. */
const MAX_REFERENCES = 10;

/**
 * @param {object} d
 * @param {{ readReference: (chatId: string, assistantOnly: boolean) => Promise<{ turns: any[], earlierContentOmitted: boolean }> }} d.peerRuntime
 *   a chat's history from each segment's harness (session/peerRuntime.cjs)
 * @param {(chatId: string) => boolean} d.known the chat is one MoPilot has
 */
function createPanelMentions({ peerRuntime, known }) {
  /**
   * The snapshots the message's chat mentions carry, in order, once each; refused when one isn't a chat MoPilot has.
   * @param {string} text
   * @returns {Promise<{ kind: 'session', path: string, name: string, text: string }[]>}
   */
  async function references(text) {
    const mentions = [...new Map(sessionMentions(text).map((m) => [m.id, m])).values()];
    if (mentions.length > MAX_REFERENCES) throw new Error(`Mention up to ${MAX_REFERENCES} chats.`);
    for (const m of mentions) if (!known(m.id)) throw new Error(`“${m.title}” isn't a chat in MoPilot.`);
    return Promise.all(
      mentions.map(async (m) => {
        const history = await peerRuntime.readReference(m.id, false);
        const body = transcriptMarkdown(m.title, history.turns);
        const clipped = body.length > LIMIT;
        return {
          kind: /** @type {const} */ ('session'),
          path: m.id,
          name: m.title,
          text: `${history.earlierContentOmitted || clipped ? '[Earlier content omitted; recent conversation follows.]\n' : ''}${clipped ? suffixUnits(body, LIMIT) : body}`,
        };
      }),
    );
  }
  return { references };
}

module.exports = { createPanelMentions };
