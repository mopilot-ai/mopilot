// The frame every first-class harness page shares: its three sections, and its defaults (new chats, models, and
// the row that points at Accounts & billing, where accounts and keys live and nowhere else).
import { navigate } from '../../../store/panes';
import { useBilling, type BillingMode } from '../../../session/harness/billing';
import { useState } from 'react';
import { useHarnessModels } from '../../../session/harness/select';
import { groupModels } from '../../../harness/modelGroups';
import { HARNESS_LABEL, type HarnessId } from '../../../harness/types';
import { HARNESS_TABS, type HarnessTab } from '../../../lib/settingsNav';
import { Group, Row, Segmented } from '../Settings';
import { NewChatsUseRow } from '../../harness/AllHarnesses';
import { RouteNotice } from '../../harness/RouteNotice';

const MODE_LABEL: Record<BillingMode, string> = {
  subscription: 'Subscription',
  apiKey: 'API key',
  mopilot: 'MoPilot credits',
  routed: 'Your own provider',
};

export function HarnessTabs({ value, onChange }: { value: HarnessTab; onChange: (t: HarnessTab) => void }) {
  return (
    <div className="settings-tabs">
      <Segmented value={value} onChange={onChange} options={HARNESS_TABS.map((t) => ({ value: t.id, label: t.label }))} />
    </div>
  );
}

/**
 * A harness's defaults: whether new chats start on it, the models it offers, and which credential it runs on.
 * Changing the credential happens in Accounts & billing.
 */
export function ModelsAndBilling({ h }: { h: HarnessId }) {
  const billing = useBilling(h);
  const models = useHarnessModels(h);
  const { main, more } = groupModels(models);
  // the other versions, as the picker's "More versions": counted, and listed on request
  const [all, setAll] = useState(false);
  return (
    <Group title="Defaults">
      <RouteNotice harness={h} label={HARNESS_LABEL[h]} variant="card" />
      {/* one choice for every harness, as on All harnesses (#1880) */}
      <NewChatsUseRow own={h} />
      <Row
        title="Models"
        desc={
          models.length ? (
            <span className="model-chips">
              {(all ? models : main).map((m) => (
                <span key={m.id} className="model-chip">
                  {m.label}
                </span>
              ))}
              {more.length > 0 && (
                <button
                  className="model-chip model-chip-more"
                  aria-expanded={all}
                  title={all ? undefined : more.map((m) => m.label).join(', ')}
                  onClick={() => setAll((x) => !x)}
                >
                  {all ? 'Show less' : `+${more.length} more`}
                </button>
              )}
            </span>
          ) : (
            'None yet'
          )
        }
      />
      <Row title="Pay with" desc={billing ? `${MODE_LABEL[billing.mode]}` : 'Checking…'}>
        <button className="btn-pill" onClick={() => navigate({ name: 'settings', section: 'accounts' })}>
          Accounts & billing
        </button>
      </Row>
    </Group>
  );
}
