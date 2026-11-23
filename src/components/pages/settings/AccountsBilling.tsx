// Settings → Accounts & billing: the one place for sign-ins, keys and credits, one block per provider (MoPilot
// credits first): its accounts with Add account and Use an API key, then, under Advanced, how it pays and what
// happens when every account runs out; then your own providers and model configs (ProvidersModels); last, what the recorded
// requests would cost (EstimatedCost). Harness pages only link here.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { visiblePoll } from '../../../lib/visiblePoll';
import { useEffect, type ReactNode } from 'react';
import { useStore } from '../../../store/core';
import { accountRowOf } from '../../../lib/settingsNav';
import { ClaudeAccount, AccountsSettings, RefreshClaudeButton, RefreshCodexButton } from '../../accounts/Accounts';
import { PROVIDER_LABEL, type ProviderId } from '../../../lib/providers';
import { HarnessBilling } from '../HarnessSettings';
import { MoPilotAccountSettings } from '../MoPilotSettings';
import { hasMoPilotService } from '../../../lib/mopilotService';
import { CodexCredits, ProviderExtras } from '../../harness/Usage';
import { RouteUsageNote } from '../../harness/RouteNotice';
import { HARNESS_LABEL } from '../../../harness/types';
import { AccountActions } from './AccountActions';
import { EstimatedCost } from './EstimatedCost';
import { ProvidersModels } from './ProvidersModels';

/** A provider's heading: its name (never a harness's) and its own buttons. */
function ProviderHead({ id, children }: { id: ProviderId; children?: ReactNode }) {
  return (
    <div className="provider-head">
      <div className="provider-head-text">
        <h2 className="provider-name">{PROVIDER_LABEL[id]}</h2>
      </div>
      {children}
    </div>
  );
}

/** What a provider's block keeps out of the way until asked: Pay with, the provider URL and the rule for running out. */
function Advanced({ children }: { children: ReactNode }) {
  return (
    <details className="settings-disclosure acct-advanced">
      <summary>Advanced</summary>
      {children}
    </details>
  );
}

/** Scrolls to the account row a link named (/logout, Log Out) and marks it for a moment. The rows load after the page, so it looks for a while. */
function useFocusRow() {
  const row = useStore((s) => (s.route.name === 'settings' ? accountRowOf(s.route.tab) : null));
  useEffect(() => {
    if (!row) return;
    let tries = 0;
    let off: ReturnType<typeof setTimeout> | undefined;
    const look = visiblePoll(
      'accounts-focus-row',
      100,
      () => {
        const el = Array.from(
          // the page's own rows: menus and cards mark the same account with the same key
          document.querySelectorAll<HTMLElement>('.acct-row[data-account]'),
        ).find((e) => e.dataset.account === row);
        if (!el && ++tries < 30) return;
        look();
        if (!el) return;
        el.scrollIntoView({ block: 'center' });
        el.classList.add('acct-focus');
        off = setTimeout(() => el.classList.remove('acct-focus'), 2500);
      },
      { wake: false },
    );
    return () => (look(), clearTimeout(off));
  }, [row]);
}

export function AccountsBilling() {
  useFocusRow();
  return (
    <>
      {hasMoPilotService() && (
        <>
          <ProviderHead id="mopilot" />
          <MoPilotAccountSettings />
        </>
      )}
      <ProviderHead id="anthropic">
        <RefreshClaudeButton />
      </ProviderHead>
      <ClaudeAccount footer={(add) => <AccountActions h="claude" add={add} />} />
      <RouteUsageNote harness="claude" label={HARNESS_LABEL.claude} />
      <ProviderExtras h="claude" />
      <Advanced>
        <HarnessBilling h="claude" />
      </Advanced>
      <ProviderHead id="openai">
        <RefreshCodexButton />
      </ProviderHead>
      <AccountsSettings only="codex" footer={(add) => <AccountActions h="codex" add={add} />} />
      <RouteUsageNote harness="codex" label={HARNESS_LABEL.codex} />
      <ProviderExtras h="codex" />
      <Advanced>
        <HarnessBilling h="codex">
          <CodexCredits />
        </HarnessBilling>
      </Advanced>
      <ProvidersModels />
      <EstimatedCost />
    </>
  );
}
