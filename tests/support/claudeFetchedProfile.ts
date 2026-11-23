// The profile a fake Claude Code CLI fetched during a login read: a fresh one is built when the fake writes it, never before.

/** A profile, none, or one to build when the fake CLI writes it (so its fetch time is after the read began). */
export type Fetched = object | null | (() => object);

/**
 * What the fake CLI writes: a read counts a profile only when it was fetched at or after the read's own start
 * (`heardSince` in electron/harness/claude/loginReader.cjs), so a fresh fetch time taken before the read is a race a slow runner
 * loses. Such a profile is refused; an old mark (0 or 1) or no fetch time is a profile the read does not count.
 */
export function fetchedNow(cfg: Fetched): object | null {
  if (typeof cfg === 'function') return cfg();
  const at = (cfg as { oauthAccount?: { profileFetchedAt?: unknown } } | null)?.oauthAccount?.profileFetchedAt;
  if (typeof at === 'number' && at > 1) {
    throw new Error('a fresh profile built before the read races its clock: pass () => profile(...) instead');
  }
  return cfg;
}
