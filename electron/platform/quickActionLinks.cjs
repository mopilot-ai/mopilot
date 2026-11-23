// What a mopilot://chat/new link (the Quick Actions') does: the app window comes forward on a new chat, in the folder the link names, with the text and the paths it carries drafted in the composer. Never sent: the user reads the draft and sends it, on their default harness.
const fs = require('node:fs/promises');
const { parseNewChatLink } = require('../../shared/deepLink.mjs');

/** @param {string} p @returns {Promise<'dir' | 'file' | null>} */
async function kindOf(p) {
  try {
    return (await fs.stat(p)).isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/**
 * The new-chat command a link asks for, or null when it names nothing that exists. A folder that is gone is dropped
 * (the chat opens without it); a lone folder in `file` starts the chat there, as the Finder action's folder does.
 * @param {unknown} url
 * @param {(p: string) => Promise<'dir' | 'file' | null>} [kind]
 * @returns {Promise<{ folder: string | null, text: string } | null>}
 */
async function newChatFor(url, kind = kindOf) {
  const link = parseNewChatLink(url);
  if (!link) return null;
  const known = await Promise.all(link.files.map(async (p) => ({ p, kind: await kind(p) })));
  const files = known.filter((f) => f.kind);
  let folder = link.folder && (await kind(link.folder)) === 'dir' ? link.folder : null;
  const lone = files.length === 1 && !link.text.trim() && !folder ? files[0] : null;
  if (lone?.kind === 'dir') folder = lone.p;
  const paths = lone?.kind === 'dir' ? [] : files.map((f) => f.p);
  const text = [link.text.trim() ? link.text : '', ...paths].filter(Boolean).join('\n');
  return folder || text ? { folder, text } : null;
}

/**
 * The handler for the link inbox (electron/app/openLinks.cjs).
 * A link opens a chat only while the Quick Actions are installed (`enabled`): the scheme is registered for every copy of
 * the app, so without the user's switch a web page's link would be a way to put text and folders in front of the user.
 * @param {{ readyMainWindow: () => Promise<{ webContents: { send(...a: unknown[]): void }, isMinimized(): boolean, restore(): void, show(): void, focus(): void }>, enabled: () => boolean, kind?: (p: string) => Promise<'dir' | 'file' | null> }} deps
 */
function createLinkOpener({ readyMainWindow, enabled, kind }) {
  return async (/** @type {string} */ url) => {
    if (!enabled()) return false;
    const chat = await newChatFor(url, kind);
    if (!chat) return false;
    const w = await readyMainWindow();
    w.webContents.send('app:command', 'new-chat-link', chat);
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    return true;
  };
}

module.exports = { newChatFor, createLinkOpener };
