// Computer History's parts shared by main and the windows (#1363): the built-in browser's entry on the app allow list (no bundle id, since those never hold ':', so no app can claim it), the <sage-computer-history> block a message carries when the user shares memories, how each harness gets it (Codex: the turn's untrusted additionalContext; Claude Code and ACP: the block ahead of the message), and stripping it from what is shown, handed off or reported.

export const BUILT_IN_BROWSER = Object.freeze({ bundleId: 'mopilot:built-in-browser', name: 'Built-in browser' });

export const HISTORY_TAG = 'sage-computer-history';
/** The additionalContext key of a Codex turn that carries shared memories. */
export const HISTORY_CONTEXT_KEY = 'mopilot.computer-history';

const OPEN = `<${HISTORY_TAG}>\n`;
const CLOSE = `\n</${HISTORY_TAG}>`;

/** Whether `text` is exactly one block: it opens and closes once, so nothing in it can end the block early. */
export function isHistoryBlock(text) {
  return (
    typeof text === 'string' &&
    text.startsWith(OPEN) &&
    text.endsWith(CLOSE) &&
    text.indexOf(`</${HISTORY_TAG}>`) === text.length - CLOSE.length + 1 &&
    text.lastIndexOf(`<${HISTORY_TAG}>`) === 0
  );
}

/** The memories a message's Computer History attachments carry, as one text, or null when it has none. */
export function historyContext(attachments = []) {
  const blocks = attachments.filter((a) => a?.kind === 'computerHistory' && isHistoryBlock(a.text)).map((a) => a.text);
  return blocks.length ? blocks.join('\n') : null;
}

/** The prompt with the shared memories ahead of it (Claude Code and ACP), unchanged when there are none. */
export function withComputerHistory(prompt, attachments = []) {
  const context = historyContext(attachments);
  return context ? `${context}\n${prompt}` : prompt;
}

const BLOCK_RE = new RegExp(`<${HISTORY_TAG}>[\\s\\S]*?</${HISTORY_TAG}>\\n?`, 'g');

/** The text without any Computer History block (a handoff to another harness, a bug report, a message as shown). */
export function stripHistoryBlocks(text) {
  return typeof text === 'string' ? text.replace(BLOCK_RE, '') : text;
}
