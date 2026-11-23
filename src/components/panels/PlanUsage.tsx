// The side pane's plan limits: every Claude Code and Codex login with what each window has left and when it resets, the one this chat runs on and the one new chats use marked, read again when shown; the account view (useAccountView) decides what each login says.
import { useEffect } from 'react';
import { useStore } from '../../store/core';
import { chatFamily } from '../../store/chats';
import { firstTierOf } from '../../harness/family';
import { useAccountView } from '../../session/harness/useAccountView';
import { useChatAccountView } from '../../session/harness/chatAccountView';
import { refreshPlanUsage } from '../../session/harness/planUsage';
import type { HarnessAccountView } from '../../harness/accountView';
import { HARNESS_IDS, type UsageReason } from '../../harness/types';
import { noteIgnored } from '../../lib/ignored';
import { LimitMeters } from '../accounts/meters';
import { RefreshCw } from '../ui/icons';

const refresh = (reason: UsageReason) =>
  Promise.all(
    HARNESS_IDS.map((h) => refreshPlanUsage(h, reason).catch((e) => noteIgnored(`refresh ${h}'s plan usage for the side pane`, e))),
  );

/** `chatAccount`: the id of the login this chat runs on, when it runs on this harness. */
function HarnessLimits({ view, chatAccount }: { view: HarnessAccountView; chatAccount: string | null }) {
  if (!view.accounts.length) return null;
  return (
    <div className="plan-usage-harness" aria-label={`${view.label} plan limits`} role="group">
      <h4>{view.label}</h4>
      {view.accounts.map((r) => (
        <div key={r.key} className="plan-usage-account" data-account={r.key}>
          <div className="plan-usage-who">
            <span className="plan-usage-name">{r.name}</span>
            {r.plan && <span className="plan-usage-plan">{r.plan}</span>}
            {r.account.id === chatAccount && <span className="plan-usage-plan">This chat</span>}
            {r.active && <span className="plan-usage-plan">New chats</span>}
          </div>
          {/* the meters say what is left; the line says what they can't: a lapsed login, a key, an old reading */}
          {(!r.windows.length || r.status.tone !== 'ok') && (
            <span className="plan-usage-status" data-tone={r.status.tone}>
              {r.status.text}
            </span>
          )}
          <LimitMeters windows={r.windows} variant="detail" />
        </div>
      ))}
    </div>
  );
}

export function PlanUsage({ threadId }: { threadId: string }) {
  const views = [useAccountView('claude'), useAccountView('codex')];
  // the chat's harness and the login it runs on (one pinned or moved), as its composer popover and Status name it
  const h = useStore(() => firstTierOf(chatFamily(threadId)));
  const { account } = useChatAccountView(h ?? 'codex', threadId);
  const chatAccount = (v: HarnessAccountView) => (h === v.harness ? (account?.id ?? null) : null);
  useEffect(() => {
    void refresh('surface');
  }, []);
  return (
    <section className="plan-usage" aria-label="Plan limits">
      <header>
        <h3>Plan limits</h3>
        <button
          type="button"
          className="btn-pill icon"
          title="Refresh usage"
          aria-label="Refresh usage"
          onClick={() => void refresh('now')}
        >
          <RefreshCw size={13} />
        </button>
      </header>
      {views.some((v) => v.accounts.length) ? (
        views.map((v) => <HarnessLimits key={v.harness} view={v} chatAccount={chatAccount(v)} />)
      ) : (
        <p>Sign in with a subscription plan to see its limits here.</p>
      )}
    </section>
  );
}
