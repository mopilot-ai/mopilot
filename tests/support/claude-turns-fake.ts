// A fake of main's claude:turns for renderer tests: the core's replay over a fake transcript's messages.
import { rawPage } from './claude-translate.ts';

type TurnsOpts = { chatId: string; cwd: string; liveTail?: boolean; limit?: number; before?: string | null };

/** native.claude.turns over `messages(sessionId)`, paged as main pages it, with `diffs` the saved diffs of the turns. */
export const turnsOver =
  (messages: (sessionId: string) => unknown[] | Promise<unknown[]>, diffs: Record<string, string> = {}) =>
  async (sessionId: string, o: TurnsOpts) => ({ page: rawPage(await messages(sessionId), o.chatId, o.cwd, o).page, diffs });
