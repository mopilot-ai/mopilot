// The composer's slash and @ popups: which one the caret opens, the items it lists and applying a skill reference.

export interface ComposerPopup {
  kind: 'slash' | 'mention';
  query: string;
  start: number;
  skillsOnly?: boolean;
}

/**
 * Slash commands start the prompt; skill references can follow whitespace anywhere. A mention query may hold spaces
 * (`@My chat`), so a file mention the list inserted (`@/path `) would match again as the caret moves after it: an `@`
 * where one of those inserted texts (`applied`) still stands opens nothing, wherever edits have moved it.
 */
export function composerPopup(value: string, caret: number, applied: readonly string[] = []): ComposerPopup | null {
  const before = value.slice(0, caret);
  const skill = /(^|\s)([/$])([\w:.-]*)$/.exec(before);
  if (skill) {
    const start = caret - skill[3].length - 1;
    return { kind: 'slash', query: skill[3], start, skillsOnly: skill[2] === '$' || start > 0 };
  }
  const mention = /(^|\s)@([^\n@]*)$/.exec(before);
  if (mention) {
    const start = caret - mention[2].length - 1;
    // a pick stays picked with the space after it deleted: the caret beside its chip doesn't reopen the list (#4581)
    if (applied.some((token) => value.startsWith(token.trimEnd(), start))) return null;
    return { kind: 'mention', query: mention[2], start };
  }
  return null;
}

export interface ComposerSlashItem {
  skill?: boolean;
  nativeSkill?: string;
  run?: () => unknown;
}

/** The draft a command pick leaves: the text around its `/name`, the space or line break after a command at the start dropped. */
export function slashPickRest(text: string, popup: ComposerPopup): string {
  const before = text.slice(0, popup.start);
  const after = text.slice(popup.start + popup.query.length + 1);
  return before + (before ? after : after.replace(/^[ \t]*\n?/, ''));
}

export function composerSlashItems<T extends ComposerSlashItem>(items: T[], popup: ComposerPopup): T[] {
  return popup.skillsOnly ? items.filter((item) => item.skill) : items;
}

/**
 * Consume only the active reference, keeping the rest of the draft and restoring its caret. A command or mode switch
 * typed in front of a draft takes its `/name` alone: the draft stays, without the space or line break that set it apart.
 */
export function applyComposerSlashItem(
  text: string,
  popup: ComposerPopup,
  item: ComposerSlashItem,
  ui: {
    setText: (value: string) => void;
    close: () => void;
    focus: () => void;
    restoreCaret: (position: number) => void;
  },
): void {
  if (item.skill) {
    const before = text.slice(0, popup.start);
    const after = text.slice(popup.start + popup.query.length + 1);
    // Codex uses skill attachments; native harnesses retain the textual invocation.
    const token = item.nativeSkill ? `${text[popup.start]}${item.nativeSkill} ` : '';
    ui.setText(before + token + after);
    if (!item.nativeSkill) item.run?.();
    ui.restoreCaret(before.length + token.length);
  } else {
    ui.setText(slashPickRest(text, popup));
    item.run?.();
    ui.focus();
  }
  ui.close();
}
