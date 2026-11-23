// Proposal-only model, effort and permission controls reuse the current harness's catalogs without changing the parent chat.
import { firstTierKind } from '../../harness/ownership';
import type { HarnessId } from '../../harness/types';
import { useEffectiveSelection, useHarnessModels } from '../../session/harness/select';
import { appPermission } from '../../../shared/permissionMenu.mjs';
import { PERMISSION_LABEL, PERMISSION_ORDER } from '../../harness/permissionsMenu';
import { useSession } from '../../store/session/useSession';
import { effortLabel } from '../../lib/format';
import type { PermissionMode } from '../../store/types';
import type { StartChoice } from './StartOptions';

type Props = { parentId: string; choice: StartChoice; onChange: (next: StartChoice) => void };

/** A catalog refresh cannot make a retained user choice look like "As proposed"; it stays visible and can be cleared. */
function ChoiceSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value?: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  const stale = !!value && !options.some((option) => option.value === value);
  return (
    <label className="start-option">
      {label}
      <select
        aria-label={`Session ${label.toLowerCase()}`}
        value={value ?? ''}
        disabled={!options.length && !stale}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">As proposed</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {stale && (
          <option value={value!} disabled>
            {value} (unavailable)
          </option>
        )}
      </select>
    </label>
  );
}

function FirstTierOptions({ harness, parentId, choice, onChange }: Props & { harness: HarnessId }) {
  const models = useHarnessModels(harness);
  const inherited = useEffectiveSelection(harness, parentId);
  const picked = models.find((m) => m.id === choice.model) ?? inherited.model;
  const efforts = picked?.efforts ?? [];
  const parent = useSession(parentId);
  const native = appPermission(parent.permission);
  const permission = parent.plan || native === 'plan' ? null : native;
  const rank = PERMISSION_ORDER.indexOf(permission as PermissionMode);
  const modes = PERMISSION_ORDER.filter((_, index) => index <= rank);
  return (
    <>
      <ChoiceSelect
        label="Model"
        value={choice.model}
        options={models.map((model) => ({ value: model.id, label: model.label }))}
        onChange={(model) => onChange({ ...choice, model, effort: null })}
      />
      <ChoiceSelect
        label="Effort"
        value={choice.effort}
        options={efforts.map((effort) => ({ value: effort, label: effortLabel(effort) }))}
        onChange={(effort) => onChange({ ...choice, effort })}
      />
      <ChoiceSelect
        label="Permissions"
        value={choice.permission}
        options={modes.map((mode) => ({ value: mode, label: PERMISSION_LABEL[mode] }))}
        onChange={(permission) => onChange({ ...choice, permission })}
      />
      {!models.length && <span className="start-options-note">Models are unavailable until this harness lists them.</span>}
      {!modes.length && (
        <span className="start-options-note">
          {parent.plan || native === 'plan'
            ? 'Permissions follow the parent’s plan mode.'
            : 'Permissions are inherited until the parent session is read.'}
        </span>
      )}
    </>
  );
}

export function StartConfigOptions({ kind, ...props }: Props & { kind: string }) {
  const harness = firstTierKind(kind);
  if (!harness)
    return (
      <>
        {['Model', 'Effort', 'Permissions'].map((label) => (
          <label className="start-option" key={label}>
            {label}
            <select aria-label={`Session ${label.toLowerCase()}`} disabled>
              <option>Set by harness</option>
            </select>
          </label>
        ))}
        <span className="start-options-note">This harness sets its own model, effort and permissions.</span>
      </>
    );
  return <FirstTierOptions harness={harness} {...props} />;
}
