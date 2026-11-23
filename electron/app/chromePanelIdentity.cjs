// Read the current adapter's canonical title and account-limit notice without creating a second title or quota owner.
const { parseKind } = require('../../shared/harnessKind.mjs');
const { prefixCodePoints } = require('../../shared/textPrefix.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { within } = require('../harness/autoTitle.cjs');

const TITLES = {
  codex: (live, _claude, chatId) => live.codex?.chatName(chatId),
  claude: async (_live, claude, _chatId, ref) => (await claude?.info?.(ref.id))?.customTitle,
  acp: async (live, _claude, _chatId, ref) => (await live.acpHost?.titleOf?.(ref.key))?.name,
};

async function panelIdentity(live, claude, chatId) {
  const ref = live.controller.ref(chatId);
  const record = live.chats.records.get(chatId);
  const family = parseKind(ref?.kind)?.family;
  if (!family) return {};
  let title;
  try {
    title = await within(
      Promise.resolve().then(() => TITLES[family](live, claude, chatId, ref)),
      3000,
    );
  } catch (error) {
    noteIgnored('read the Chrome panel chat title', error);
  }
  const current = live.controller.ref(chatId);
  if (current?.kind !== ref.kind || current?.key !== ref.key || live.chats.records.get(chatId) !== record) return {};
  const text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  let limit;
  try {
    limit = live.capsService?.accountLimit?.(chatId);
  } catch (error) {
    noteIgnored('read the Chrome panel account limit', error);
  }
  return {
    ...(text ? { title: prefixCodePoints(text, 80) } : {}),
    ...(limit ? { limit } : {}),
  };
}

module.exports = { panelIdentity };
