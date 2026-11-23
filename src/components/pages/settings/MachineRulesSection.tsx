// A machine page's Rules: what the owner's document says every chat on the machine may do and when it asks, written whole through the owner's policy and drawn from what main kept. A key the organization fixes is shown disabled with "Managed by <organization>".
import { useState } from 'react';
import { toast } from '../../../store/core';
import { isLocked, obj, saveOwnerDoc, type MachineManaged, type MachineRules, type OwnerDoc } from '../../../lib/machinePageData';
import { userError } from '../../../../shared/userError.mjs';
import { Group, Row, Select, Toggle } from './Controls';

const CEILING = [
  { value: 'read-only', label: 'Read only' },
  { value: 'default', label: 'Ask first' },
  { value: 'auto-review', label: 'Auto-review' },
  { value: 'full-access', label: 'Full access' },
] as const;
const PAUSE = [5, 10, 30, 60, 120, 360, 720];
const pauseLabel = (m: number) => (m >= 60 ? `${m / 60} h` : `${m} min`);
const DETAIL = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'tool', label: 'Tool' },
  { value: 'full', label: 'Full' },
] as const;

export function MachineRulesSection({
  doc,
  rules,
  managed,
  onSaved,
}: {
  doc: OwnerDoc;
  rules: MachineRules;
  managed?: MachineManaged;
  onSaved: (doc: OwnerDoc) => void;
}) {
  const [busy, setBusy] = useState(false);
  // a control writes its own key and shows what the Host kept, never the value it was given
  const write = async (edit: (copy: OwnerDoc) => void) => {
    setBusy(true);
    try {
      onSaved(await saveOwnerDoc(doc, edit));
    } catch (e) {
      toast(userError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const lock = (key: string) => (isLocked(managed, key) ? `Managed by ${managed!.org}` : undefined);
  const off = (key: string) => busy || isLocked(managed, key);
  const n = rules.notify;
  const notify = (key: 'needsYou' | 'done' | 'paused', title: string) => (
    <Row title={title} desc={lock('notify')}>
      <Toggle
        label={title}
        on={n[key]}
        disabled={off('notify')}
        onChange={(on) => write((c) => void (c.notify = { ...obj(c.notify), [key]: on }))}
      />
    </Row>
  );
  return (
    <Group title="Rules">
      <Row title="Most a chat may do" desc={lock('permissionMax')}>
        <Select
          label="Most a chat may do"
          value={rules.permissionMax}
          options={CEILING.map((o) => ({ ...o }))}
          onChange={(v) => !off('permissionMax') && void write((c) => void (c.permissionMax = v))}
        />
      </Row>
      <Row title="Pause a run after" desc={lock('approvals')}>
        <Select
          label="Pause a run after"
          value={String(rules.pauseMinutes)}
          options={[...new Set([...PAUSE, rules.pauseMinutes])]
            .sort((a, b) => a - b)
            .map((m) => ({ value: String(m), label: pauseLabel(m) }))}
          onChange={(v) => !off('approvals') && void write((c) => void (c.approvals = { ...obj(c.approvals), pauseMinutes: Number(v) }))}
        />
      </Row>
      {notify('needsYou', 'Notify when a chat needs you')}
      {notify('done', 'Notify when a run is done')}
      {notify('paused', 'Notify when a run pauses')}
      <Row title="Show in notifications" desc={lock('notify')}>
        <Select
          label="Show in notifications"
          value={n.detail}
          options={DETAIL.map((o) => ({ ...o }))}
          onChange={(v) => !off('notify') && void write((c) => void (c.notify = { ...obj(c.notify), detail: v }))}
        />
      </Row>
      <Row title="Quiet hours" desc={n.quiet ? `${n.quiet.start} to ${n.quiet.end}` : lock('notify')}>
        <Toggle
          label="Quiet hours"
          on={!!n.quiet}
          disabled={off('notify')}
          onChange={(on) =>
            write(
              (c) =>
                void (c.notify = {
                  ...obj(c.notify),
                  quiet: on ? { start: '22:00', end: '07:00', tz: Intl.DateTimeFormat().resolvedOptions().timeZone } : null,
                }),
            )
          }
        />
      </Row>
    </Group>
  );
}
