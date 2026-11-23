// A machine page's Spending: "About $4.20 today", a bar against the daily limit, and the two limits the owner's document holds. A limit is a whole new document through the owner's policy; one the organization fixes is disabled with its name.
import { useState } from 'react';
import { toast } from '../../../store/core';
import { isLocked, obj, saveOwnerDoc, type MachineManaged, type MachineSpend, type OwnerDoc } from '../../../lib/machinePageData';
import { usdText } from '../../../../shared/host/machineLine.mjs';
import { userError } from '../../../../shared/userError.mjs';
import { Group, Row, Select } from './Controls';

const LIMITS = ['none', '5', '10', '20', '50', '100'];
const limitLabel = (v: string) => (v === 'none' ? 'None' : `$${v}`);

/** The bar's fill, 0 to 1 of the daily limit; none without a limit. */
export const spendShare = (s: MachineSpend): number | null => (s.dayLimitUsd ? Math.min(1, s.dayUsd / s.dayLimitUsd) : null);

export function MachineSpendingSection({
  doc,
  spend,
  managed,
  onSaved,
}: {
  doc: OwnerDoc | undefined;
  spend: MachineSpend;
  managed?: MachineManaged;
  onSaved: (doc: OwnerDoc) => void;
}) {
  const [busy, setBusy] = useState(false);
  const share = spendShare(spend);
  const lock = isLocked(managed, 'spend') ? `Managed by ${managed!.org}` : undefined;
  const set = async (key: 'dayUsd' | 'chatUsd', v: string) => {
    if (!doc) return;
    setBusy(true);
    try {
      onSaved(await saveOwnerDoc(doc, (c) => void (c.spend = { ...obj(c.spend), [key]: v === 'none' ? undefined : Number(v) })));
    } catch (e) {
      toast(userError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const control = (key: 'dayUsd' | 'chatUsd', title: string, current: number | null) => (
    <Row title={title} desc={lock}>
      <Select
        label={title}
        value={current === null ? 'none' : String(current)}
        options={[...new Set([...LIMITS, ...(current === null ? [] : [String(current)])])].map((v) => ({ value: v, label: limitLabel(v) }))}
        onChange={(v) => !busy && !lock && void set(key, v)}
      />
    </Row>
  );
  return (
    <Group title="Spending">
      <Row title={`About ${usdText(spend.dayUsd)} today`} desc={spend.unpriced ? 'Leaves out a model with no price.' : undefined}>
        {share !== null && (
          <div
            className="spend-bar"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
            aria-label="Spent today"
          >
            <div className="spend-bar-fill" style={{ width: `${share * 100}%` }} />
          </div>
        )}
      </Row>
      {control('dayUsd', 'Daily limit', spend.dayLimitUsd)}
      {control('chatUsd', 'Limit per chat', spend.chatLimitUsd)}
    </Group>
  );
}
