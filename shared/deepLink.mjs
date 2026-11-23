// The hash that opens an app window on one chat ("thread=<encoded id>"), shared by main and the window (src/lib/deepLink.ts).
import edition from './edition.json' with { type: 'json' };

/** The hash (without '#') that opens a window on this chat. Ids can hold ':' and other reserved characters, so they are URI-encoded. */
export function threadHash(id) {
  return `thread=${encodeURIComponent(id)}`;
}

/** The URL scheme the app answers to (Info.plist CFBundleURLTypes): the macOS Quick Actions open `mopilot://chat/new?...`. */
export const APP_SCHEME = edition.desktop.scheme;
/** The most text one link may carry into a draft, and the most files it may name. */
export const LINK_TEXT_MAX = 16_384;
export const LINK_FILES_MAX = 32;

/**
 * What a `mopilot://chat/new` link asks for: a draft (`q`), a folder to start in (`folder`), files to mention
 * (`file`, repeated). Anything else is null; a link only ever prefills a new chat, it never sends one.
 * @param {unknown} url
 * @returns {{ text: string, folder: string | null, files: string[] } | null}
 */
export function parseNewChatLink(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.hostname !== 'chat' || u.pathname !== '/new') return null;
  const absolute = (p) => p.startsWith('/') && !/[\u0000-\u001f]/.test(p);
  const folders = u.searchParams.getAll('folder').filter(absolute);
  const files = u.searchParams.getAll('file').filter(absolute).slice(0, LINK_FILES_MAX);
  const text = (u.searchParams.get('q') ?? '').slice(0, LINK_TEXT_MAX);
  if (!text.trim() && !folders.length && !files.length) return null;
  return { text, folder: folders[0] ?? null, files };
}
