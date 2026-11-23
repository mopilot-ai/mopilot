// The harness-specific steps behind runSemantic: one handler per (harness, semantic) where a binding
// can't be run from its description alone. This and electron/harness/* are the places that name harnesses.
import { ownTable } from '../../../shared/ownTable.mjs';
import { unsupportedGoalWords } from '../../../shared/codexGoals.mjs';
import type { HarnessKind, Semantic } from '../../../shared/model/harness';
import type { CapView } from '../../../shared/model/session';

export interface SemanticCall {
  chatId: string;
  args: string;
  /** the chat's capability; absent when a handler runs for the chat's first harness, not its current one */
  cap?: CapView;
}
export type SemanticHandler = (call: SemanticCall) => Promise<unknown> | unknown;

/** A goal action this harness has no form of (a goal set on another harness before the chat switched). */
export function unsupportedGoal(label: string, args: string): never {
  throw new Error(unsupportedGoalWords(label, args.split(' ')[0]));
}

/** Handlers set at runtime (tests, or a harness added later); they win over the built-in ones. */
const OVERRIDES: Partial<Record<string, Partial<Record<Semantic, SemanticHandler>>>> = ownTable({});

/** Register how a harness runs a semantic. */
export function registerSemantic(kind: HarnessKind, semantic: Semantic, handler: SemanticHandler) {
  (OVERRIDES[kind] ??= ownTable<Partial<Record<Semantic, SemanticHandler>>>({}))[semantic] = handler;
}

type HandlerLoader = () => Promise<Partial<Record<Semantic, SemanticHandler>>>;

/**
 * Where each harness's built-in handlers load from, on first use: they live with the runtime that drives the store
 * (src/session/harness/adapters), so the composition root registers them rather than this layer importing them.
 */
const LOADERS: Partial<Record<string, HandlerLoader>> = ownTable({});

/** Register how a harness's built-in handlers load. */
export function registerSemanticLoader(kind: HarnessKind, load: HandlerLoader) {
  LOADERS[kind] = load;
}

export async function handlerFor(kind: HarnessKind, semantic: Semantic): Promise<SemanticHandler | null> {
  return OVERRIDES[kind]?.[semantic] ?? (await LOADERS[kind]?.())?.[semantic] ?? null;
}
