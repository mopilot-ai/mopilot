// The harness a new-chat draft starts on, and its own choice, with a revision so a completed start cannot consume a replacement draft's choice.
import type { HarnessKind } from '../harness/adapter';
import type { AppState } from './state';
import { ownTable } from '../../shared/ownTable.mjs';

type Draft = Pick<AppState, 'newChatHarnessPick' | 'newChatHarnessRevision'>;

/**
 * The harness a new chat starts on before its draft picks one: the last used one while new chats follow it
 * (prefs.newChatStart 'last', src/session/newChatStart.ts), else `saved`, the saved default (store/chats.ts reads it).
 */
export const startingKind = (s: Pick<AppState, 'prefs'>, saved: HarnessKind): HarnessKind =>
  (s.prefs.newChatStart !== 'default' && s.prefs.lastHarness) || saved;

type Prefs = AppState['prefs'];
/** Where Codex and Claude Code keep the model and effort their new chats start with (a basic harness keeps its own). */
const WORKING: Record<string, ((p: Prefs) => { model: string | null; effort: string | null }) | undefined> = ownTable({
  codex: (p: Prefs) => p,
  claude: (p: Prefs) => p.claudeSelection,
});

/**
 * What choosing `kind` as the default writes, wherever it is chosen (Settings, the account menu, Welcome): while new chats
 * follow the last used it is the latest choice too, and a fixed default for another harness moves to this one with the
 * model and effort it uses now (Settings then sets the model picked there).
 */
export function defaultChoicePrefs(prefs: Prefs, kind: HarnessKind): Partial<Prefs> {
  const latest = prefs.newChatStart === 'default' ? {} : { lastHarness: kind };
  if (prefs.newChatDefault?.harness === kind) return { defaultHarness: kind, ...latest };
  const now = WORKING[kind]?.(prefs);
  return { defaultHarness: kind, ...latest, newChatDefault: { harness: kind, model: now?.model ?? null, effort: now?.effort ?? null } };
}

export const replaceDraftHarness = (state: Draft, kind: HarnessKind | null): Draft => ({
  newChatHarnessPick: kind,
  newChatHarnessRevision: state.newChatHarnessRevision + 1,
});

/** Retire only the choice that this start consumed, including when a replacement chose the same harness. */
export function consumeDraftHarness(current: Draft, started: Draft): Partial<Draft> {
  return current.newChatHarnessPick === started.newChatHarnessPick && current.newChatHarnessRevision === started.newChatHarnessRevision
    ? replaceDraftHarness(current, null)
    : {};
}
