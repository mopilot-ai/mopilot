// Settings → Accounts & billing → Providers & models: the user's own providers for Claude Code. A key per provider, kept encrypted on this Mac (shown only as saved, never again), and named model configs: a provider and model, the models Claude Code's model families get, and providers to fall back on. Choosing one is Pay with → Your own provider.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { useState } from 'react';
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import { claudeRoutable, reloadRouting, useRouting } from '../../../lib/routing';
import type { ClaudeTier, ModelConfig, RoutingProvider } from '../../../lib/native/routing';
import { Group, Row, Select } from '../Settings';

const TIERS: { id: ClaudeTier; label: string }[] = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

/** A change that fails says why, and the form keeps what was typed. */
async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
  let ok = true;
  try {
    await fn();
  } catch (e) {
    toast(errorText(e), 'error');
    ok = false;
  }
  // what main has now, whether or not the change was kept
  void reloadRouting();
  return ok;
}

/** One provider's key: saved or not, with Add, Replace and Remove; a key typed is never shown again. */
function ProviderKeyRow({ p, disabled }: { p: RoutingProvider; disabled: boolean }) {
  const [typing, setTyping] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    if (await attempt(fn)) setTyping(null);
    setBusy(false);
  };
  return (
    <Row title={p.label} desc={p.hasKey ? 'Key saved on this Mac' : 'No key saved'}>
      {typing !== null ? (
        <span className="hs-list">
          <input
            className="text-input slim wide"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-label={`${p.label} key`}
            placeholder={`${p.label} key`}
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
          />
          <button
            className="btn-pill primary"
            disabled={busy || !typing.trim()}
            onClick={() => void run(() => native.routing.setKey(p.id, typing.trim()))}
          >
            Save
          </button>
          <button className="btn-pill" disabled={busy} onClick={() => setTyping(null)}>
            Cancel
          </button>
        </span>
      ) : (
        <span className="hs-list">
          <button className="btn-pill" disabled={disabled} onClick={() => setTyping('')}>
            {p.hasKey ? 'Replace key' : 'Add key'}
          </button>
          {p.hasKey && (
            <button className="btn-pill" disabled={disabled || busy} onClick={() => void run(() => native.routing.clearKey(p.id))}>
              Remove
            </button>
          )}
        </span>
      )}
    </Row>
  );
}

let rows = 0;
/** A fallback row's key in the form. */
const nextRow = () => ++rows;

interface Draft {
  id?: string;
  name: string;
  provider: string;
  baseUrl: string;
  /** a key for the user's own server, saved for its URL; blank keeps the one saved (or none) */
  serverKey: string;
  model: string;
  tiers: Partial<Record<ClaudeTier, string>>;
  /** each with the row's own key, so a removed row takes its own field with it */
  fallbacks: { row: number; provider: string; model: string }[];
}

const draftOf = (c: ModelConfig | null, provider: string): Draft =>
  c
    ? {
        id: c.id,
        name: c.name,
        provider: c.provider,
        baseUrl: c.baseUrl ?? '',
        serverKey: '',
        model: c.model,
        tiers: { ...c.tierModels },
        fallbacks: c.fallbacks.map((f) => ({ row: nextRow(), ...f })),
      }
    : { name: '', provider, baseUrl: '', serverKey: '', model: '', tiers: {}, fallbacks: [] };

/** A model config's form: what it sends to, the models Claude Code's families get, and its fallbacks in order. */
function ConfigEditor({ config, providers, onDone }: { config: ModelConfig | null; providers: RoutingProvider[]; onDone: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(config, providers[0].id));
  const [busy, setBusy] = useState(false);
  const own = providers.find((p) => p.id === d.provider)?.customBase === true;
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const options = providers.map((p) => ({ value: p.id, label: p.label }));
  // another server of your own is the config's own server, so it is offered only in a config for one
  const fallbackOptions = options.filter((o) => own || !providers.find((p) => p.id === o.value)?.customBase);
  const save = async () => {
    setBusy(true);
    const ok = await attempt(async () => {
      const tierModels = Object.fromEntries(Object.entries(d.tiers).filter(([, m]) => m?.trim()));
      await native.routing.saveConfig({
        ...(d.id ? { id: d.id } : {}),
        name: d.name,
        provider: d.provider,
        ...(own ? { baseUrl: d.baseUrl } : {}),
        model: d.model,
        tierModels,
        fallbacks: d.fallbacks.filter((f) => f.model.trim()).map(({ provider, model }) => ({ provider, model })),
      });
      if (own && d.serverKey.trim()) await native.routing.setKey(d.provider, d.serverKey.trim(), d.baseUrl);
    });
    setBusy(false);
    if (ok) onDone();
  };
  const field = (label: string, value: string, onChange: (v: string) => void, placeholder = '', type = 'text') => (
    <label className="hs-field">
      <span className="hs-field-label">{label}</span>
      <input
        className="text-input slim wide"
        type={type}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
  return (
    <div className="settings-row routing-editor">
      <span className="hs-key-form">
        {field('Name', d.name, (v) => set({ name: v }), 'Work, Local Llama…')}
        <label className="hs-field">
          <span className="hs-field-label">Provider</span>
          <Select label="Provider" value={d.provider} options={options} onChange={(v) => set({ provider: v })} />
        </label>
        {own && field('Server URL', d.baseUrl, (v) => set({ baseUrl: v }), 'http://localhost:11434/v1')}
        {own && field('Server key (optional)', d.serverKey, (v) => set({ serverKey: v }), 'Leave blank if it takes none', 'password')}
        {field('Model', d.model, (v) => set({ model: v }), 'gpt-5.5, deepseek-chat, anthropic/claude-sonnet-4.5…')}
        {TIERS.map((t) =>
          field(
            `${t.label} model (optional)`,
            d.tiers[t.id] ?? '',
            (v) => set({ tiers: { ...d.tiers, [t.id]: v } }),
            `When Claude Code asks for ${t.label}`,
          ),
        )}
        {d.fallbacks.map((f, i) => (
          <span className="hs-list" key={f.row}>
            <Select
              label={`Fallback ${i + 1} provider`}
              value={f.provider}
              options={fallbackOptions}
              onChange={(v) => set({ fallbacks: d.fallbacks.map((x, j) => (j === i ? { ...x, provider: v } : x)) })}
            />
            <input
              className="text-input slim"
              aria-label={`Fallback ${i + 1} model`}
              placeholder="Model"
              spellCheck={false}
              value={f.model}
              onChange={(e) => set({ fallbacks: d.fallbacks.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)) })}
            />
            <button className="link-btn" onClick={() => set({ fallbacks: d.fallbacks.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </span>
        ))}
        <button
          type="button"
          className="text-link hs-field-more"
          onClick={() => set({ fallbacks: [...d.fallbacks, { row: nextRow(), provider: fallbackOptions[0].value, model: '' }] })}
        >
          Add a fallback
        </button>
        <span className="hs-list">
          <button className="btn-pill primary" disabled={busy || !d.name.trim() || !d.model.trim()} onClick={() => void save()}>
            Save
          </button>
          <button className="btn-pill" disabled={busy} onClick={onDone}>
            Cancel
          </button>
        </span>
      </span>
    </div>
  );
}

/** What a config sends to, in a line: its provider and model, then its fallbacks. */
function configLine(c: ModelConfig, providers: RoutingProvider[]) {
  const label = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  const first = `${c.provider === 'custom' && c.baseUrl ? c.baseUrl : label(c.provider)} · ${c.model}`;
  return c.fallbacks.length ? `${first} · then ${c.fallbacks.map((f) => `${label(f.provider)} ${f.model}`).join(', ')}` : first;
}

export function ProvidersModels() {
  const r = useRouting();
  /** the config being edited: its id, 'new', or none */
  const [editing, setEditing] = useState<string | null>(null);
  const routable = r.providers.filter(claudeRoutable);
  const locked = r.state === 'unreadable';
  return (
    <Group
      id="providers-models"
      title="Providers & models"
      desc="Run Claude Code on a provider of your own: save its key, then a model config, and choose Your own provider under Pay with. Keys stay encrypted on this Mac and are never shown again. Chats on your other machines keep their own sign-in."
    >
      {r.keys === 'unreadable' && (
        <Row
          title="Saved keys can't be read"
          desc="MoPilot kept the file as it is and changes nothing in it. Remove host-api-keys.json in MoPilot's data folder to start again."
        />
      )}
      {r.providers
        .filter((p) => !p.customBase)
        .map((p) => (
          <ProviderKeyRow key={p.id} p={p} disabled={r.keys === 'unreadable'} />
        ))}
      {locked && (
        <Row
          title="Saved model configs can't be read"
          desc="These are the ones last read. MoPilot kept a copy beside llm-configs.json and changes nothing until the file can be read again or is removed."
        />
      )}
      {r.configs.map((c) =>
        editing === c.id ? (
          <ConfigEditor key={c.id} config={c} providers={routable} onDone={() => setEditing(null)} />
        ) : (
          <Row key={c.id} title={c.name} desc={configLine(c, r.providers)}>
            <span className="hs-list">
              <button className="btn-pill" disabled={locked} onClick={() => setEditing(c.id)}>
                Edit
              </button>
              <button className="btn-pill" disabled={locked} onClick={() => void attempt(() => native.routing.removeConfig(c.id))}>
                Remove
              </button>
            </span>
          </Row>
        ),
      )}
      {editing === 'new' ? (
        <ConfigEditor config={null} providers={routable} onDone={() => setEditing(null)} />
      ) : (
        <Row title="Model configs" desc={r.configs.length ? 'Claude Code uses the one chosen under Pay with.' : 'None saved yet.'}>
          <button className="btn-pill" disabled={locked || !routable.length} onClick={() => setEditing('new')}>
            Add model config
          </button>
        </Row>
      )}
    </Group>
  );
}
