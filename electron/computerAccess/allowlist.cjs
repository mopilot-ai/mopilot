// Computer access (#1364): which of this Mac's tools a paired device may call, by the scopes the person gave it. An
// exact list, never the whole registry: tools that run commands, read local files or the clipboard, reach other chats,
// start sessions or scheduled tasks, or send screenshots to another model are never offered to a remote owner.

/** The scope each tool family needs. A tool not matched here is never offered. */
const FAMILIES = [
  { scope: 'browser', prefix: 'browser_' },
  { scope: 'chrome', prefix: 'chrome_' },
  { scope: 'apps', prefix: 'desktop_app_' },
  { scope: 'apps', prefix: 'desktop_' },
];

/** Tools of an offered family that stay on this Mac. */
const NEVER = new Set([
  // a shell command or a dev server on this Mac
  'browser_preview_start',
  'browser_preview_stop',
  'browser_preview_list',
  // script in the page, local files, saved sign-ins, history and bookmarks are this Mac's, not a remote chat's
  'browser_javascript_exec',
  'browser_file_upload',
  'browser_request_credentials',
  'browser_request_signin',
  'browser_history_search',
  'browser_bookmarks_search',
  'chrome_javascript_tool',
  'chrome_file_upload',
  // the clipboard
  'desktop_read_clipboard',
  'desktop_write_clipboard',
]);

/**
 * The scope a tool needs, or null when no device may call it.
 * @param {unknown} name
 * @returns {'browser' | 'chrome' | 'apps' | null}
 */
function scopeOf(name) {
  if (typeof name !== 'string' || NEVER.has(name) || name.startsWith('browser_preview_')) return null;
  const f = FAMILIES.find((x) => name.startsWith(x.prefix));
  return /** @type {any} */ (f ? f.scope : null);
}

/**
 * Whether a device with these scopes may call the tool.
 * @param {unknown} name @param {Record<string, boolean>} scopes
 */
function allowed(name, scopes) {
  const scope = scopeOf(name);
  return !!scope && scopes?.[scope] === true;
}

/**
 * What the device is told about the tools it may call: name, description, schema and policy, from the registry's list.
 * @param {{ name: string }[]} listed @param {Record<string, boolean>} scopes
 */
function offered(listed, scopes) {
  return listed.filter((t) => allowed(t.name, scopes));
}

module.exports = { scopeOf, allowed, offered, NEVER };
