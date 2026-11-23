// Usage limit reset cards: Claude's on its official Usage page, and Codex's per account.

import { visiblePoll } from '../../lib/visiblePoll';
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { get as getState, set as setState, toast, useStore } from '../../store/core';
import { openLink } from '../../session/open';
import { refreshClaudeUsage } from '../../session/harness/claude';
import { useHarnessAccounts } from '../../session/harness/select';
import { accountName } from '../../harness/accounts';
import type { Account } from '../../harness/accounts';
import type { UsageReason } from '../../harness/types';
import type { RateLimitResetCreditsSummary } from '../../protocol/v2/RateLimitResetCreditsSummary';
import type { RateLimitResetCredit } from '../../protocol/v2/RateLimitResetCredit';
import { Group, Row, Segmented } from '../pages/Settings';
import { errorText } from '../../lib/ignored';

const CLAUDE_USAGE = 'https://claude.ai/settings/usage';
const CODEX_USAGE = 'https://chatgpt.com/codex/settings/usage';
const dateText = (sec: number) => new Date(sec * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** Refresh on page entry, return from the provider website, and reopening the disclosure, without remounting it. */
function useEntryRefresh(refresh: () => void, expanded: boolean) {
  useEffect(() => {
    const enter = () => refresh();
    enter();
    window.addEventListener('focus', enter);
    return () => window.removeEventListener('focus', enter);
  }, [refresh]);
  useEffect(() => {
    if (expanded) refresh();
  }, [expanded, refresh]);
}

/** Claude's resets are redeemed on the official Usage page, and apply to Claude Code too. */
export function ClaudeResetCards({ expanded = false }: { expanded?: boolean }) {
  const { active } = useHarnessAccounts('claude');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const refresh = useCallback(async (reason: UsageReason = 'surface') => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    setError(null);
    try {
      await refreshClaudeUsage(reason);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      busy.current = false;
      if (alive.current) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEntryRefresh(refresh, expanded);
  // The usage refresher keeps read failures on the account rather than rejecting its promise.
  const usage = active?.usage;
  const failure =
    error ??
    (usage?.fetchState === 'error' || usage?.fetchState === 'unavailable'
      ? (usage.fetchError ?? 'Usage is unavailable. Try again.')
      : null);
  return (
    <div className="usage-resets">
      <Group title="Usage limit resets" desc="Redeem on Claude’s Usage page. Usage refreshes when you return.">
        <Row
          title="Reset cards on Claude"
          desc={`Sign in as ${active?.email ?? 'your Claude Code account'}, then choose “Reset for free”.`}
        >
          {refreshing && (
            <span className="usage-resets-status" role="status">
              Refreshing usage…
            </span>
          )}
          <button className="btn-pill" onClick={() => openLink(CLAUDE_USAGE)}>
            Open Claude Usage
          </button>
        </Row>
        {failure && (
          <Row title="Could not refresh usage" desc={failure}>
            <button className="btn-pill" disabled={refreshing} onClick={() => void refresh('now')}>
              Retry
            </button>
          </Row>
        )}
      </Group>
    </div>
  );
}

export function CodexResetCards({ expanded = false }: { expanded?: boolean }) {
  const { active } = useHarnessAccounts('codex');
  if (!active || active.kind !== 'subscription') return null;
  // Remount on account changes so a previous account's cards are never displayed for the next one.
  return <AccountResetCards key={JSON.stringify([active.id, active.email])} account={active} expanded={expanded} />;
}

function AccountResetCards({ account, expanded }: { account: Account; expanded: boolean }) {
  const [summary, setSummary] = useState<RateLimitResetCreditsSummary | null>(null);
  const [tab, setTab] = useState<'available' | 'history'>('available');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<{ creditId: string | null } | null>(null);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);
  const busy = useRef(false);
  const reading = useRef(false);
  const status = useStore((s) => s.accounts.accounts.find((a) => a.id === account.id)?.status);

  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    setLoading(true);
    setError(null);
    try {
      const r = await native.accounts.resetCredits(account.id);
      if (!alive.current) return;
      setSummary(r.rateLimitResetCredits ?? null);
      setNow(Date.now());
      // Keep the app's usage indicators current only if this is still the account in use.
      if (getState().accounts.active === account.id) setState({ rateLimits: r });
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      reading.current = false;
      if (alive.current) setLoading(false);
    }
  }, [account.id]);

  useEffect(() => {
    alive.current = true;
    const stopClock = visiblePoll('now:30000', 30_000, () => setNow(Date.now()));
    return () => {
      alive.current = false;
      stopClock();
    };
  }, []);
  const refresh = useCallback(() => {
    if (!busy.current) void load();
  }, [load]);
  useEntryRefresh(refresh, expanded);

  const redeem = async (creditId: string | null, title: string) => {
    if (busy.current || reading.current || loading || error || status === 'expired') return;
    const card = summary?.credits?.find((c) => c.id === creditId);
    if (!uncertain && card?.expiresAt != null && card.expiresAt * 1000 <= Date.now()) {
      void load();
      return toast('This reset has expired. Checking available resets…', 'error');
    }
    if (!uncertain && !confirm(`Use “${title}” for ${accountName(account)}? This cannot be undone.`)) return;
    busy.current = true;
    setPending(creditId ?? 'next');
    try {
      const r = await native.accounts.consumeResetCredit(account.id, creditId);
      switch (r.outcome) {
        case 'reset':
          toast('Usage limits reset', 'success');
          break;
        case 'nothingToReset':
          toast('Your usage limits do not need a reset.');
          break;
        case 'noCredit':
          toast('No reset is available. It may have expired or already been used.', 'error');
          break;
        case 'alreadyRedeemed':
          toast('This reset was already redeemed. Usage will be refreshed.');
          break;
        default:
          throw new Error('Couldn’t confirm the reset result.');
      }
      if (alive.current) setUncertain(null);
    } catch (e) {
      if (alive.current) setUncertain({ creditId });
      toast(`${errorText(e)} Retry checks the same request without spending another card.`, 'error');
    } finally {
      // Read both the cards and quota after every response, including ambiguous failures.
      if (alive.current) await load();
      busy.current = false;
      if (alive.current) setPending(null);
    }
  };

  const cards = summary?.credits ?? [];
  const expired = (c: RateLimitResetCredit) => c.expiresAt != null && c.expiresAt * 1000 <= now;
  const available = cards.filter((c) => c.status === 'available' && !expired(c));
  const history = cards.filter((c) => c.status !== 'available' || expired(c));
  const rows = tab === 'available' ? available : history;
  const count = summary ? String(summary.availableCount) : '0';
  const hasAvailable = /^[0-9]+$/.test(count) && BigInt(count) > 0n;
  const disabled = loading || pending !== null || !!error || !!uncertain || status === 'expired';

  return (
    <div className="usage-resets">
      <Group title="Usage limit resets" desc={`Reset cards for ${accountName(account)}. Each restores the limits in its offer.`}>
        <div className="usage-resets-toolbar">
          {summary && (
            <Segmented
              label="Reset cards"
              value={tab}
              options={[
                {
                  value: 'available',
                  label: (
                    <>
                      Available <span className="count-pill">{count}</span>
                    </>
                  ),
                },
                { value: 'history', label: 'History' },
              ]}
              onChange={setTab}
            />
          )}
          <div className="usage-resets-actions">
            {loading && (
              <span className="usage-resets-status" role="status">
                {summary ? 'Refreshing…' : 'Loading reset cards…'}
              </span>
            )}
            <button className="btn-pill" onClick={() => openLink(CODEX_USAGE)}>
              Open Codex Usage
            </button>
          </div>
        </div>
        {error && (
          <Row title="Could not load reset cards" desc={error}>
            <button className="btn-pill" disabled={loading || pending !== null} onClick={() => void load()}>
              Retry
            </button>
          </Row>
        )}
        {!loading && !error && !summary && (
          <Row title="Reset card information is not available" desc="Check Codex Usage on the website for offers for this account." />
        )}
        {uncertain && (
          <Row title="Reset result needs confirmation" desc="Retry checks the previous attempt without using another reset card.">
            <button
              className="btn-pill"
              disabled={loading || pending !== null || !!error || status === 'expired'}
              onClick={() => void redeem(uncertain.creditId, 'Reset card')}
            >
              Retry reset
            </button>
          </Row>
        )}
        {summary && (
          <div className="usage-reset-list">
            {tab === 'available' && rows.length === 0 && !hasAvailable && <Row title="No resets available" />}
            {tab === 'history' && rows.length === 0 && (
              <Row title="No reset history was returned" desc="Codex may return only available cards." />
            )}
            {rows.map((c) => (
              <Row
                key={c.id}
                title={c.title ?? 'Usage limit reset'}
                desc={
                  <>
                    {c.description && <span className="usage-reset-description">{c.description}</span>}
                    <span className="usage-reset-expiry">
                      {[
                        c.expiresAt != null ? `${expired(c) ? 'Expired' : 'Expires'} ${dateText(c.expiresAt)}` : null,
                        expired(c)
                          ? null
                          : c.status === 'redeemed'
                            ? 'Used'
                            : c.status === 'redeeming'
                              ? 'Redemption in progress'
                              : c.status === 'unknown'
                                ? 'Status unavailable'
                                : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </>
                }
              >
                {c.status === 'available' && !expired(c) && (
                  <button className="btn-pill" disabled={disabled} onClick={() => void redeem(c.id, c.title ?? 'Usage limit reset')}>
                    {pending === c.id ? 'Using reset…' : 'Use reset'}
                  </button>
                )}
              </Row>
            ))}
            {tab === 'available' && hasAvailable && (cards.length === 0 || BigInt(count) > BigInt(available.length)) && (
              <Row title="More resets available" desc="Codex didn’t list every card. Use the next reset, or see the website.">
                <button className="btn-pill" disabled={disabled} onClick={() => void redeem(null, 'Next available reset')}>
                  {pending === 'next' ? 'Using reset…' : 'Use next reset'}
                </button>
              </Row>
            )}
          </div>
        )}
      </Group>
    </div>
  );
}
