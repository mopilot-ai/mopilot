// The "Pay with" row each harness's billing group uses: which credential it runs on, and a switch
// between them that keeps both; and the API key form it shares with the accounts list's Use an API key.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { useState } from 'react';
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import { Row, Segmented, Select } from '../Settings';
import { isEnter } from '../../../lib/focus';
import { openMoPilotPage } from '../../../session/open';

/** Inline form for an API key and, behind "Use another provider", the URL of another provider it belongs to. */
export function KeyField({
  placeholder,
  urlPlaceholder,
  official,
  onSave,
  onCancel,
}: {
  placeholder: string;
  urlPlaceholder: string;
  official: string;
  onSave: (key: string, baseUrl: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [key, setKey] = useState('');
  const [base, setBase] = useState('');
  const [other, setOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(key, base);
    } catch (e) {
      toast(errorText(e), 'error');
      setBusy(false);
    }
  };
  return (
    <span className="hs-key-form">
      <label className="hs-field">
        <span className="hs-field-label">API key</span>
        <input
          className="text-input slim wide"
          type="password"
          placeholder={placeholder}
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => isEnter(e) && save()}
        />
      </label>
      {other ? (
        <label className="hs-field">
          <span className="hs-field-label">Provider URL</span>
          <input
            className="text-input slim wide"
            placeholder={urlPlaceholder}
            value={base}
            onChange={(e) => setBase(e.target.value)}
            onKeyDown={(e) => isEnter(e) && save()}
          />
          <span className="hs-field-hint">{base.trim() ? `Requests go to ${base.trim()}.` : `Leave blank to use ${official}.`}</span>
        </label>
      ) : (
        <button type="button" className="text-link hs-field-more" onClick={() => setOther(true)}>
          Use another provider
        </button>
      )}
      <span className="hs-list">
        <button className="btn-pill primary" disabled={!key.trim() || busy} onClick={save}>
          Save
        </button>
        <button className="btn-pill" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </span>
  );
}

/** "OpenAI", or the host of another provider's URL ("openrouter.ai"). */
export function endpointLabel(baseUrl: string | null | undefined, own: string) {
  if (!baseUrl) return own;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export type Mode = 'subscription' | 'apiKey' | 'mopilot' | 'routed';
const MODES: { value: Mode; label: string }[] = [
  { value: 'subscription', label: 'Subscription' },
  { value: 'apiKey', label: 'API key' },
  { value: 'mopilot', label: 'MoPilot credits' },
  { value: 'routed', label: 'Your own provider' },
];

/** Your own provider: the saved model configs (once read), the one chosen (null: none yet; one not listed was removed) and how to choose one. */
export interface RoutedChoice {
  loaded: boolean;
  configs: { id: string; name: string }[];
  configId: string | null;
  onChoose: (id: string) => Promise<void>;
}

/** What a harness pays with and how to change it (HarnessParts.useBilling). */
export interface BillingProps {
  /** the harness's API key form: placeholders and the name of its own provider */
  keys: { placeholder: string; urlPlaceholder: string; official: string };
  mode: Mode;
  desc: string;
  hasKey: boolean;
  hasSubscription: boolean;
  /** offer MoPilot credits; signedIn=false means choosing it starts sign-in */
  credits?: { signedIn: boolean };
  /** offer Your own provider (a model config) */
  routed?: RoutedChoice;
  onSwitch: (m: Mode) => Promise<void>;
  onAddKey: (key: string, baseUrl: string) => Promise<void>;
  onRemoveKey: () => Promise<void>;
  onSignIn: () => void;
}

/** One row per harness: which credential it runs on, and a switch between them that keeps both. */
export function BillingRow({
  keys,
  mode,
  desc,
  hasKey,
  hasSubscription,
  credits,
  routed,
  onSwitch,
  onAddKey,
  onRemoveKey,
  onSignIn,
}: BillingProps) {
  const [editing, setEditing] = useState(false);
  // a switch the user asked for that fails says why
  const run = (fn: () => Promise<void>): void => {
    fn().catch((e) => toast(errorText(e), 'error'));
  };
  return (
    <Row title="Pay with" desc={desc}>
      {editing ? (
        <KeyField
          placeholder={keys.placeholder}
          urlPlaceholder={keys.urlPlaceholder}
          official={keys.official}
          onSave={async (k, u) => {
            await onAddKey(k, u);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span className="hs-list">
          <Segmented
            value={mode}
            options={MODES.filter((o) => (o.value !== 'mopilot' || credits) && (o.value !== 'routed' || routed))}
            onChange={(m) => {
              if (m === mode) return;
              if (m === 'routed') {
                // offered only with `routed`: the config chosen before, else the first saved; none saved yet says where to make one
                const r = routed!;
                const pick = r.configs.find((c) => c.id === r.configId) ?? r.configs[0];
                if (!r.loaded) toast('Your model configs are still being read. Try again in a moment.', 'info');
                else if (!pick) toast('Save a model config under Providers & models first.', 'info');
                else run(() => r.onChoose(pick.id));
                return;
              }
              // sign in, then carry on to credits; a failed or cancelled sign-in says why and stays put (D-81)
              if (m === 'mopilot' && !credits?.signedIn)
                run(async () => {
                  const r = await native.mopilot.signIn();
                  if (r.ok) await onSwitch('mopilot');
                  else if (r.error) toast(r.error, 'error');
                });
              else if (m === 'apiKey' && !hasKey) setEditing(true);
              else if (m === 'subscription' && !hasSubscription) onSignIn();
              else run(() => onSwitch(m));
            }}
          />
          {mode === 'routed' && routed ? (
            <Select
              label="Model config"
              value={routed.configId ?? ''}
              options={[
                ...routed.configs.map((c) => ({ value: c.id, label: c.name })),
                ...(routed.configs.some((c) => c.id === routed.configId)
                  ? []
                  : [{ value: routed.configId ?? '', label: 'Removed config' }]),
              ]}
              onChange={(id) => id && id !== routed.configId && run(() => routed.onChoose(id))}
            />
          ) : mode === 'mopilot' ? (
            <button className="btn-pill" onClick={() => openMoPilotPage('/credits')}>
              Buy credits
            </button>
          ) : (
            <button className="btn-pill" onClick={() => setEditing(true)}>
              {hasKey ? 'Replace key' : 'Add key'}
            </button>
          )}
          {hasKey && mode !== 'mopilot' && mode !== 'routed' && (
            <button className="btn-pill" onClick={() => run(onRemoveKey)}>
              Remove key
            </button>
          )}
        </span>
      )}
    </Row>
  );
}
