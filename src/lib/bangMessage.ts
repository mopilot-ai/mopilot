// The message a `!` command sends with its output, and the command read back from it (the composer's ↑ history).

const PREFIX = 'I ran `';
const SUFFIX = '` in my terminal. The output is attached.';

/** What a `!cmd` sends in place of itself, with the output attached. */
export const bangMessage = (cmd: string): string => `${PREFIX}${cmd}${SUFFIX}`;

/** The `!cmd` a sent message stands for, or null for any other message. */
export function bangCommand(text: string): string | null {
  if (!text.startsWith(PREFIX) || !text.endsWith(SUFFIX) || text.length <= PREFIX.length + SUFFIX.length) return null;
  return `!${text.slice(PREFIX.length, -SUFFIX.length)}`;
}
