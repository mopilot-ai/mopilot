// A new chat opened by a mopilot:// link (the macOS Quick Actions, electron/app/quickActionLinks.cjs): in the folder it names, with its text drafted for the user to read and send. The chat runs on the default harness, as any new chat does.

export type NewChatLink = { folder: string | null; text: string };

/** What the window offers a link: kept as parameters so the order of steps is testable. */
export interface NewChatLinkDeps {
  /** the project for a folder (created when it is new), or null when it can't be made */
  createProject(path: string): Promise<string | null | undefined>;
  /** the next new chat is outside any project */
  clearProject(): void;
  /** the next new chat belongs to this project */
  setProject(id: string): void;
  home(cwd?: string): void;
  /** the text goes after what the new chat's box already holds, once the box is on screen */
  draft(text: string): void;
  /** the view the window is on now: a link that took long to resolve does not land on a view the user left */
  stale(): boolean;
}

/** Reads the command's argument; anything that is not a link (a bad message from main) is ignored. */
export function asNewChatLink(arg: unknown): NewChatLink | null {
  if (!arg || typeof arg !== 'object') return null;
  const { folder, text } = arg as { folder?: unknown; text?: unknown };
  const f = typeof folder === 'string' && folder ? folder : null;
  const t = typeof text === 'string' ? text : '';
  return f || t.trim() ? { folder: f, text: t } : null;
}

export async function openNewChatLink(arg: unknown, d: NewChatLinkDeps): Promise<void> {
  const link = asNewChatLink(arg);
  if (!link) return;
  if (link.folder) {
    const id = await d.createProject(link.folder);
    if (d.stale()) return;
    // a folder that can't become a project still gets its chat, outside the project that was selected before
    if (id) d.setProject(id);
    else d.clearProject();
    d.home(link.folder);
  } else {
    d.clearProject();
    d.home();
  }
  if (link.text.trim()) d.draft(link.text);
}
