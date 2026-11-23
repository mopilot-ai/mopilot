// The link an agent writes to another MoPilot chat in a message, [title](mopilot:chat/<chat id>), as the agents' note on linked sessions asks (electron/capabilities/contract/sessionsNote.cjs).

const CHAT_HREF = /^mopilot:chat\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/;

/** The chat a message link opens, or null when `href` is not a chat link. */
export function chatIdFromHref(href: string | null | undefined): string | null {
  return (href && CHAT_HREF.exec(href)?.[1]) || null;
}
