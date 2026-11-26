// The agent, model and effort a New chat last started with on each computer, by pair and machine: offered again the next time, kept in memory only and forgotten with the account.
export type StartPick = { harness: string; model: string | null; effort: string | null };
type Models = readonly { id: string; efforts: readonly { id: string }[]; defaultEffort?: string | null }[];

const kept = new Map<string, StartPick>();
const key = (pairId: string | null, host: string) => `${pairId ?? ''}\u0000${host}`;

export const lastPick = (pairId: string | null, host: string): StartPick | null => kept.get(key(pairId, host)) ?? null;
export const rememberPick = (pairId: string | null, host: string, pick: StartPick) => void kept.set(key(pairId, host), pick);
/** An account leaving the phone takes its picks with it. */
export const forgetPicks = () => kept.clear();

/** The remembered agent when the computer lists it ready now, else null (the screen keeps its own rule). */
export const rememberedHarness = (pick: StartPick | null, harnesses: readonly { id: string; unavailable?: boolean }[]) =>
  pick && harnesses.some((h) => h.id === pick.harness && !h.unavailable) ? pick.harness : null;

/**
 * The remembered model and effort for `harness` when its options still list that model, else null: the effort only while
 * the model offers it, else the effort the options already chose for that model, else the model's own default.
 */
export function rememberedModel(
  pick: StartPick | null,
  harness: string,
  models: Models,
  loaded: { model: string | null; effort: string | null },
) {
  if (!pick || pick.harness !== harness || !pick.model) return null;
  const model = models.find((m) => m.id === pick.model);
  if (!model) return null;
  const offers = (e: string | null) => !!e && model.efforts.some((x) => x.id === e);
  const effort = offers(pick.effort)
    ? pick.effort
    : model.id === loaded.model && offers(loaded.effort)
      ? loaded.effort
      : (model.defaultEffort ?? null);
  return { model: model.id, effort };
}
