// The effort a chat of a harness starts on before the model's own default, in the one order This Mac's picker uses (session/harness/select.ts): the remembered pick, then Codex's own config file; a machine chat's picker calls it too.
import type { HarnessId } from './types';

/**
 * The first level This Mac says for a new chat: Claude Code's remembered pick; Codex's remembered pick, then a running chat's setting, then `model_reasoning_effort` from its config file. Null when none says one (the model's default follows).
 * @param remembered the selection the Mac remembers for new chats of the harness
 * @param running the setting of a chat already running (a new chat has none)
 * @param config Codex's `model_reasoning_effort`
 */
export function localEffortChoice(
  h: HarnessId,
  remembered: string | null | undefined,
  running?: string | null,
  config?: string | null,
): string | null {
  if (h !== 'codex') return remembered ?? null;
  return remembered ?? running ?? config ?? null;
}

/**
 * What a new chat of the agent `id` on a machine starts on, read from this Mac's remembered picks the way a local new chat reads them: Claude Code's remembered selection; Codex's remembered effort, then its config file. Null for any other agent.
 * @param s the app state's `prefs` and Codex `config`
 */
export function newChatEffortOf(
  id: string,
  s: {
    prefs?: { claudeSelection?: { effort?: string | null }; effort?: string | null };
    config?: { model_reasoning_effort?: string | null } | null;
  },
): string | null {
  if (id === 'claude') return localEffortChoice('claude', s.prefs?.claudeSelection?.effort);
  if (id === 'codex') return localEffortChoice('codex', s.prefs?.effort, null, s.config?.model_reasoning_effort);
  return null;
}
