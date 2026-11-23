// The Claude Code key setting as the window last read it from main (electron/harness/claude/auth.cjs), with no other
// dependency, so code outside React (harnessAccounts, the limit offers) reads the same value the hooks do.
import type { ClaudeApiKeyInfo } from '../lib/native';

let claudeKey: ClaudeApiKeyInfo | null = null;
const listeners = new Set<() => void>();

/** The key setting as last read (null: not read yet). */
export const getClaudeKey = (): ClaudeApiKeyInfo | null => claudeKey;

/** Record a reading and tell every subscriber. */
export function publishClaudeKey(k: ClaudeApiKeyInfo) {
  claudeKey = k;
  listeners.forEach((l) => l());
}

/** Subscribe to readings (useSyncExternalStore's shape); returns the unsubscribe. */
export function subscribeClaudeKey(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
