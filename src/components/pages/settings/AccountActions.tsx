// Under a provider's accounts in Accounts & billing: Add account and Use an API key, the key form that opens in place,
// and the one switch for moving on when an account runs out. The same for every first-class harness (HarnessParts).
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { useState, type ReactNode } from 'react';
import { toastFailure } from '../../../store/core';
import { useAccountView } from '../../../session/harness/useAccountView';
import type { HarnessId } from '../../../harness/types';
import { PARTS } from '../../harness/parts';
import { Row, Toggle } from '../Settings';
import { KeyField } from './BillingRow';

/** The picker's Automatic row says the same: a chat moves on by itself when its account runs out. */
export const AUTO_SWITCH_TITLE = 'Switch automatically when one runs out';

/** `add`: the harness's own Add account button (or its sign-in in progress), shown first. */
export function AccountActions({ h, add }: { h: HarnessId; add: ReactNode }) {
  const billing = PARTS[h].useBilling();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <AutoSwitchRow h={h} />
      {editing && (
        <div className="acct-key-form">
          <KeyField
            placeholder={billing.keys.placeholder}
            urlPlaceholder={billing.keys.urlPlaceholder}
            official={billing.keys.official}
            onSave={async (k, u) => {
              await billing.onAddKey(k, u);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
      <div className="acct-add-row" data-harness={h}>
        {add}
        {/* no key yet: the form; a saved key not in use: switch to it (not every harness lists its key as a row) */}
        {billing.mode !== 'apiKey' && !editing && (
          <button
            type="button"
            className="acct-add"
            onClick={() => (billing.hasKey ? billing.onSwitch('apiKey').catch(toastFailure("Couldn't use the API key")) : setEditing(true))}
          >
            Use an API key
          </button>
        )}
      </div>
    </>
  );
}

/** Shown once there are two subscriptions to move between; an API key or credits never take over without asking. */
function AutoSwitchRow({ h }: { h: HarnessId }) {
  const [on, set] = PARTS[h].useAutoSwitch();
  const subscriptions = useAccountView(h).accounts.filter((r) => r.account.kind !== 'apiKey').length;
  if (subscriptions < 2) return null;
  return (
    <Row title={AUTO_SWITCH_TITLE}>
      <Toggle on={on} onChange={(v) => set(v).catch(toastFailure("Couldn't change automatic switching"))} />
    </Row>
  );
}
