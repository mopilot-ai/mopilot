// Reading a harness's plan usage for the composer popover or side pane: Claude Code's logins, or Codex's pool and its app-server login; only Refresh starts a Codex left idle.
import { get } from '../../store/core';
import { refreshAccountsUsage } from '../../store/accounts';
import { ensureCodex, refreshRateLimits } from '../../store/connection';
import { refreshClaudeUsage } from './claude/usage';
import type { HarnessId, UsageReason } from '../../harness/types';

/** A view opening asks for a fresh-enough reading ('surface'); its Refresh button for a new one ('now'). */
export function refreshPlanUsage(h: HarnessId, reason: UsageReason): Promise<unknown> {
  if (h === 'claude') return refreshClaudeUsage(reason);
  const s = get();
  const running = s.conn === 'ready';
  const pool = s.accounts.accounts.length > 0;
  return Promise.all([
    // reads the app-server's own login, then the pool's accounts on their usual pacing; asked for a new reading, one
    // left idle starts, and starting reads its rate limits (connection.ts connect)
    running ? refreshRateLimits() : reason === 'now' ? ensureCodex() : null,
    // the pool is read through main, whether or not the app-server runs; asked again only for a new reading
    pool && (reason === 'now' || !running) ? refreshAccountsUsage(reason) : null,
  ]);
}
