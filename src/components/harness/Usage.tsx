// Accounts & billing, after each provider's accounts and billing: what only that provider has. An API key's
// billing note with its dashboard, Codex's credit balance (a row of its billing card) and each harness's
// usage-limit reset cards, folded away.
// The usage left on each account is on its row above, so it is not repeated here.

import { endpointLabel } from '../pages/HarnessSettings';
import { useClaudeKey } from '../../session/harness/billing';
import type { HarnessId } from '../../harness/types';
import { useEffect, useState } from 'react';
import { useStore } from '../../store/core';
import { refreshRateLimits } from '../../store/connection';
import { openLink } from '../../session/open';
import { Group, Row } from '../pages/Settings';
import { ClaudeResetCards, CodexResetCards } from './ResetCards';
import type { RateLimitSnapshot } from '../../protocol/v2/RateLimitSnapshot';

/** How a harness is billed right now, with the usage dashboard to check spend on API billing. */
function BillingNote({ h }: { h: HarnessId }) {
  const accounts = useStore((s) => s.accounts);
  const ck = useClaudeKey();
  const active = accounts.accounts.find((a) => a.id === accounts.active);
  const api = h === 'codex' ? active?.kind === 'apiKey' : ck?.mode === 'apiKey';
  const base = h === 'codex' ? active?.baseUrl : ck?.baseUrl;
  if (!api) return null;
  const own = h === 'codex' ? 'OpenAI' : 'Anthropic';
  const dash = base ? null : h === 'codex' ? 'https://platform.openai.com/usage' : 'https://console.anthropic.com/settings/usage';
  return (
    <Group
      title="Billing"
      desc={`Running on your ${endpointLabel(base, own)} API key. Usage is billed per token, so there are no plan limits to show.`}
    >
      <Row
        title="API usage"
        desc={dash ? 'Spend and token counts are on the provider’s dashboard.' : `Check spend with ${endpointLabel(base, own)}.`}
      >
        {dash && (
          <button className="btn-pill" onClick={() => openLink(dash)}>
            Open dashboard
          </button>
        )}
      </Row>
    </Group>
  );
}

/** A credit balance as people read money: grouped thousands, at most two decimals ("62,373.56"). */
export const creditsText = (c: { unlimited: boolean; balance: string | number | null }) =>
  c.unlimited ? 'Unlimited' : Number(c.balance ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Codex's credit balance, kept for when the plan's limits run out: a row of the OpenAI billing card. */
export function CodexCredits() {
  const rl = useStore((s) => s.rateLimits);
  useEffect(() => {
    // cannot reject: refreshRateLimits records each failed read and keeps the last reading
    void refreshRateLimits();
  }, []);
  const snap: RateLimitSnapshot | undefined = rl?.rateLimitsByLimitId
    ? (Object.values(rl.rateLimitsByLimitId)[0] as RateLimitSnapshot | undefined)
    : (rl?.rateLimits ?? undefined);
  if (!snap?.credits) return null;
  return (
    <Row title="Codex credits" desc="Used after your plan's limits run out">
      <span className="credits-balance">{creditsText(snap.credits)}</span>
      <button className="btn-pill" onClick={() => openLink('https://chatgpt.com/codex/settings/usage')}>
        Add more
      </button>
    </Row>
  );
}

/** What a provider adds after its accounts and billing: the API-key note and the reset cards. */
export function ProviderExtras({ h }: { h: HarnessId }) {
  const [expanded, setExpanded] = useState(false);
  const ck = useClaudeKey();
  const codexKey = useStore((s) => s.accounts.accounts.find((a) => a.id === s.accounts.active)?.kind === 'apiKey');
  const api = h === 'codex' ? codexKey : ck?.mode === 'apiKey';
  return (
    <>
      <BillingNote h={h} />
      {!api && (
        <details className="settings-disclosure provider-resets" onToggle={(e) => setExpanded(e.currentTarget.open)}>
          <summary>Usage limit resets</summary>
          {h === 'codex' ? <CodexResetCards expanded={expanded} /> : <ClaudeResetCards expanded={expanded} />}
        </details>
      )}
    </>
  );
}
