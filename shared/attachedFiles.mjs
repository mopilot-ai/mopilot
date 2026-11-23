// The Host-staged files a Codex turn names for the model, as a hidden block ahead of the message (userText.mjs strips it), so the thread never shows the Host's private path.

export const ATTACHED_FILES_TAG = 'sage-attached-files';

/**
 * The text with the paths of the (one or more) files it carries named in a block ahead of it.
 * @param {string} text
 * @param {string[]} paths
 */
export const withAttachedFiles = (text, paths) =>
  `<${ATTACHED_FILES_TAG}>\n${paths.map((p) => `@${p}`).join('\n')}\n</${ATTACHED_FILES_TAG}>\n${text}`;
