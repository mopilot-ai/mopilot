// The Host's handler for `chat.goal` (feature `goalControls`): what the goal bar and a typed /goal do to a chat's goal, run by the family the chat is on (./goalRuntime.mjs). It answers with the goal the chat has after it, which the state lane tells every other client too.
import { UnsupportedError } from '../errors.mjs';

/** @param {{ runtime: { goal?: (p: any) => Promise<unknown> } }} deps */
export default ({ runtime }) => ({
  effects: {
    /** @param {{ chatId: string, action: string, human?: boolean, tokens?: number | null, objective?: string }} p */
    async 'chat.goal'(p) {
      if (!runtime.goal) throw new UnsupportedError('This host cannot control a goal yet. Update it.');
      return { goal: (await runtime.goal(p)) ?? null };
    },
  },
});
