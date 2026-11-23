// What each pick in a chat's model sheet changes in the controls the phone shows, before the Mac has answered: the pick and nothing else, so the Mac's read-back replaces it.
import type { ChatControls } from './controls';

type Patch = (controls: ChatControls) => ChatControls;
const options =
  (change: Partial<ChatControls['options']>): Patch =>
  (c) => ({ ...c, options: { ...c.options, ...change } });

/** A model, with the effort it keeps or its own default (the sheet's choice, which is also what the Mac is asked for). */
export const withModel = (model: string, effort: string | null): Patch => options({ model, effort });

export const withEffort = (effort: string): Patch => options({ effort });

/** A permission: its label as the Mac listed it, else the id (the Mac names rows this phone may not set, too). */
export const withPermission =
  (value: string): Patch =>
  (c) => ({
    ...c,
    options: {
      ...c.options,
      permission: value,
      permissionLabel: c.options.permissions.find((p) => p.id === value)?.label ?? value,
    },
  });

/** A login the chat is pinned to, or null for the agent's own choice (then which login serves is the Mac's to say). */
export const withAccount =
  (id: string | null): Patch =>
  (c) => ({
    ...c,
    options: {
      ...c.options,
      account: {
        id,
        pinned: id !== null,
        serving: id === null ? null : (c.options.accounts.find((a) => a.id === id)?.label ?? id),
      },
    },
  });

/**
 * The agent the chat moves to with its next message. `own` is the agent it runs on now: the chat list's, or its machine's.
 * Where that is not known, the one the chat is on stands in unless a move already waits (then it stays a move).
 * `moved`: the models and permissions in the controls are the old agent's until they are read again.
 */
export const withAgent =
  (to: { id: string; label: string }, own: string | undefined): Patch =>
  (c) => {
    // the agent it ran on before the first pick of a row of them, so a second pick back to it is not a move
    const from = own ?? c.moved?.from ?? (c.switching ? undefined : c.harness?.id);
    return {
      ...c,
      harness: { id: to.id, label: to.label },
      switching: from === undefined ? true : to.id !== from,
      moved: { from },
    };
  };
