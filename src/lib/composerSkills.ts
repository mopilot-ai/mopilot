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

/** Editable invocation text, without the separating space. Only local native skills preserve the typed trigger. */
type SlashCompletion = { text: string; hint?: string; keepTrigger?: boolean };
export type SkillReference = { name: string; path: string; displayName?: string };

export interface ComposerSlashItem {
  /** Skills can be selected within prose as well as at the beginning. */
  skill?: boolean;
  skillAttachment?: SkillReference;
  completion?: SlashCompletion;
  aliases?: string[];
  disabled?: string;
  run?: () => unknown;
}

/** Put a new chip at the query and keep any later chips anchored to the surviving text. */
export function withSkillReference<T extends { kind: string; textOffset?: number }>(
  attachments: T[],
  skill: T,
  start: number,
  end: number,
): T[] {
  if (start === end) return [...attachments, skill];
  const next = attachments.map((a) => {
    const offset = a.textOffset ?? 0;
    return a.kind === 'skill' && offset > start ? { ...a, textOffset: Math.max(start, offset - (end - start)) } : a;
  });
  // Chips before the trigger stay before the pick even if deleting the query makes the offsets equal.
  const later = attachments.findIndex((a) => a.kind === 'skill' && (a.textOffset ?? 0) > start);
  next.splice(later < 0 ? next.length : later, 0, skill);
  return next;
}

const commandTokens = (text: string) => text.matchAll(/(?<!\S)[/$]\S+/gu);
export const hasSlashCommandToken = (text: string) => !commandTokens(text).next().done;

/** Text ranges and the argument hint for a bare command. The native Claude SDK requires "/" at the start of the message. */
export function slashCommandPresentation(text: string, items: ComposerSlashItem[]) {
  const ranges: { start: number; end: number }[] = [];
  const matches = [...commandTokens(text)];
  let hint: string | undefined;
  if (!matches.length) return { ranges, hint };

  const commands = new Map<string, SlashCompletion>();
  const skills = new Map<string, SlashCompletion>();
  // The first matching row in the menu owns a token.
  for (const { completion, disabled, skill, aliases } of items.toReversed()) {
    if (!completion || disabled) continue;
    const names = [completion.text.slice(1), ...(aliases ?? [])];
    for (const trigger of completion.keepTrigger ? ['/', '$'] : [completion.text[0]]) {
      for (const name of names) {
        const token = trigger + name;
        commands.set(token, completion);
        if (skill) skills.set(token, completion);
      }
    }
  }
  for (const { 0: token, index: start } of matches) {
    const completion = (start === 0 ? commands : skills).get(token);
    if (!completion) continue;
    const end = start + token.length;
    ranges.push({ start, end });
    if (start === 0 && token[0] === completion.text[0] && /^[^\S\r\n\u2028\u2029]*$/.test(text.slice(end))) hint = completion.hint;
  }
  return { ranges, hint };
}

/** The draft a command pick leaves: the text around its `/name`, the space or line break after a command at the start dropped. */
export function slashPickRest(text: string, popup: ComposerPopup): string {
  const before = text.slice(0, popup.start);
  const after = text.slice(popup.start + popup.query.length + 1);
  return before + (before ? after : afterCommandSeparator(after));
}

const afterCommandSeparator = (after: string) => after.replace(/^[ \t]*\n?/, '');

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
    insertSkill: (skill: SkillReference, start: number, end: number) => void;
  },
): void {
  const before = text.slice(0, popup.start);
  const after = text.slice(popup.start + popup.query.length + 1);
  if (item.completion) {
    const { text: command, keepTrigger } = item.completion;
    const token = (keepTrigger ? text[popup.start] + command.slice(1) : command) + ' ';
    const rest = item.skill || before ? after.replace(/^ /, '') : afterCommandSeparator(after);
    ui.setText(before + token + rest);
    ui.restoreCaret(before.length + token.length);
  } else if (item.skillAttachment) {
    ui.insertSkill(item.skillAttachment, popup.start, popup.start + popup.query.length + 1);
  } else {
    ui.setText(slashPickRest(text, popup));
    item.run?.();
    ui.focus();
  }
  ui.close();
}
