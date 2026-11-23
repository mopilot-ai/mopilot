// Refreshing Codex usage: the app-server's rate limits and the managed accounts' quotas, each kept on failure.
import { noteIgnored } from '../lib/ignored';

/** Refresh the app-server's billing metadata and the account-scoped quota independently. */
export async function refreshCodexUsage(deps: {
  readRateLimits: () => Promise<unknown>;
  setRateLimits: (limits: unknown) => void;
  hasManagedAccounts: () => boolean;
  refreshAccounts: () => Promise<unknown>;
}): Promise<void> {
  try {
    deps.setRateLimits(await deps.readRateLimits());
  } catch (error) {
    // keep the last reading; the account refresh below still runs
    noteIgnored("read Codex's rate limits", error);
  }
  if (deps.hasManagedAccounts()) {
    try {
      await deps.refreshAccounts();
    } catch (error) {
      // keep the cached account usage until the next refresh
      noteIgnored("refresh the managed Codex accounts' usage", error);
    }
  }
}
