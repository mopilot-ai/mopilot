// New cloud machine (host.cloud; Remote Run X6), from the Host chip's menu or Settings › Machines: Provider (the key, the first time only), Machine (name, size with the provider's price per hour when it publishes one, region, network), Create (a step card: Create the machine, Start the Host, Connect, Pair; Cancel deletes what was made) and Done (Start a chat on it). The key is typed once, kept by main and never shown again.
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { Check, Spinner } from '../../ui/icons';
import { native } from '../../../lib/native';
import type { CloudOptions, CloudProvider, CloudStepId } from '../../../lib/native/host';
import { cloudOn } from '../../../lib/hostCloud';
import { ignoring } from '../../../lib/ignored';
import { navigate } from '../../../store/panes';
import { pickNewChatHost } from '../../../store/projects';
import { userError } from '../../../../shared/userError.mjs';

type Step = 'provider' | 'machine' | 'create' | 'done';
type StepState = 'running' | 'done' | 'failed';
type KeyState = 'idle' | 'checking' | 'refused' | { error: string };
type Network = 'full' | 'limited';

/** The steps of a creation, in the order they run. */
export const CREATE_STEPS: { id: CloudStepId; label: string }[] = [
  { id: 'create', label: 'Create the machine' },
  { id: 'start', label: 'Start the Host' },
  { id: 'connect', label: 'Connect' },
  { id: 'pair', label: 'Pair' },
];

/** "about $0.09/hour" for a published price, nothing when the provider publishes none. */
export function priceWords(price: number | null, currency: string): string {
  if (price === null || !Number.isFinite(price)) return '';
  const n = price >= 0.01 ? String(Math.round(price * 100) / 100) : price.toPrecision(1);
  return `about ${currency === 'USD' ? `$${n}` : `${n} ${currency}`}/hour`;
}

const sizeWords = (z: CloudOptions['sizes'][number]) => `${z.label} · ${z.cpus} CPU · ${z.memoryGb} GB`;

/** One fixed-order list of the creation's steps, each running, done or failed. */
function CreateSteps({ states }: { states: Partial<Record<CloudStepId, StepState>> }) {
  return (
    <ol className="host-install-steps cloud-steps" aria-label="Creation steps">
      {CREATE_STEPS.map((s) => {
        const state = states[s.id];
        return (
          <li key={s.id} className={`host-step ${state ?? 'waiting'}`} data-state={state ?? 'waiting'}>
            <span className="host-step-label">{s.label}</span>{' '}
            {state === 'running' ? (
              <span role="img" aria-label="Running">
                <Spinner size={12} />
              </span>
            ) : state === 'done' ? (
              <span role="img" aria-label="Done">
                <Check size={12} strokeWidth={2} />
              </span>
            ) : state === 'failed' ? (
              <span role="img" aria-label="Failed">
                ✕
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function NewCloudMachineSheet({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<CloudProvider[] | null>(null);
  const [providerId, setProviderId] = useState('');
  const [step, setStep] = useState<Step>('provider');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pem, setPem] = useState('');
  const [keyState, setKeyState] = useState<KeyState>('idle');
  const [options, setOptions] = useState<CloudOptions | null>(null);
  const [optionsError, setOptionsError] = useState('');
  const [name, setName] = useState('');
  const [size, setSize] = useState('');
  const [region, setRegion] = useState('');
  const [network, setNetwork] = useState<Network>('full');
  const [states, setStates] = useState<Partial<Record<CloudStepId, StepState>>>({});
  const [failure, setFailure] = useState('');
  const [ready, setReady] = useState<{ id: string; name: string } | null>(null);
  // the creation this sheet follows: its id once main names it, and whether it was cancelled
  const run = useRef({ waiting: false, launch: '', cancelled: false, n: 0 });
  const on = cloudOn();
  const provider = providers?.find((p) => p.id === providerId) ?? null;

  useEffect(() => {
    if (!on) return;
    let live = true;
    native.host.cloudProviders().then(
      (list) => {
        if (!live) return;
        setProviders(list);
        const first = list[0];
        if (!first) return;
        setProviderId(first.id);
        // the key is asked for the first time only
        setStep(first.hasKey ? 'machine' : 'provider');
      },
      (e) => live && setKeyState({ error: userError(e) }),
    );
    return () => {
      live = false;
    };
  }, [on]);
  useEffect(
    () =>
      on
        ? native.host.onCloud((e) => {
            const r = run.current;
            if (e.kind === 'launch' && r.waiting) {
              r.waiting = false;
              r.launch = e.launch;
            } else if (e.kind === 'step' && r.launch && e.launch === r.launch) {
              setStates((cur) => ({ ...cur, [e.step]: e.state }));
              if (e.state === 'failed' && e.error) setFailure(e.error);
            }
          })
        : undefined,
    [on],
  );
  // the Machine step reads what the provider offers, again when the region changes
  useEffect(() => {
    if (!on || step !== 'machine' || !providerId) return;
    let live = true;
    setOptionsError('');
    native.host.cloudOptions(providerId, region || undefined).then(
      (o) => {
        if (!live) return;
        setOptions(o);
        setRegion((cur) => (o.regions.some((r) => r.id === cur) ? cur : (o.regions[0]?.id ?? '')));
        setSize((cur) => (o.sizes.some((z) => z.id === cur) ? cur : (o.sizes[0]?.id ?? '')));
        if (!o.flags.limitedNetwork) setNetwork('full');
      },
      (e) => live && setOptionsError(userError(e)),
    );
    return () => {
      live = false;
    };
  }, [on, step, providerId, region]);

  /** Keeps the key, then asks the provider once whether it is accepted; a refused key is not kept. */
  const saveKey = async () => {
    // the form renders only for a provider
    const chosen = provider as NonNullable<typeof provider>;
    setKeyState('checking');
    try {
      await native.host.cloudSetKey(chosen.id, { ...fields, privateKeyPem: pem });
    } catch (e) {
      return setKeyState({ error: userError(e) });
    }
    const checked = await native.host
      .cloudCheck(chosen.id)
      .catch((e: unknown) => ({ ok: false as const, code: 'failed', message: userError(e) }));
    if (!checked.ok) {
      native.host.cloudRemoveKey(chosen.id).catch(ignoring('forget a refused cloud key'));
      return setKeyState('refused');
    }
    // the key is kept by main and is shown no more
    setPem('');
    setFields({});
    setKeyState('idle');
    setProviders((list) => (list as NonNullable<typeof list>).map((p) => (p.id === chosen.id ? { ...p, hasKey: true } : p)));
    setStep('machine');
  };

  const create = async () => {
    const r = run.current;
    r.n += 1;
    const mine = r.n;
    r.waiting = true;
    r.launch = '';
    r.cancelled = false;
    setStates({});
    setFailure('');
    setStep('create');
    const named = name.trim();
    try {
      const out = await native.host.cloudLaunch({ provider: providerId, name: named, size, region, network });
      if (r.n === mine && !r.cancelled) {
        setReady({ id: out.id, name: named });
        setStep('done');
      }
    } catch (e) {
      // a cancelled creation is not a failure: Cancel already went back to the Machine step
      if (r.n === mine && !r.cancelled) setFailure((cur) => cur || userError(e));
    }
  };
  const cancel = async () => {
    const r = run.current;
    r.cancelled = true;
    r.waiting = false;
    const launch = r.launch;
    setStep('machine');
    if (launch) await native.host.cloudCancel(launch).catch(ignoring('cancel a cloud machine'));
  };

  if (!on) return null;
  const failed = CREATE_STEPS.some((s) => states[s.id] === 'failed') || !!failure;
  const limitedOff = options ? !options.flags.limitedNetwork : false;
  const keyReady = !!provider && provider.fields.every((f) => fields[f]?.trim()) && !!pem.trim() && keyState !== 'checking';
  const machineReady = !!name.trim() && !!size && !!region && !!options;

  return (
    <Modal title="New cloud machine" onClose={onClose}>
      <div className="machine-sheet cloud-sheet">
        {providers && providers.length > 1 && step !== 'create' && step !== 'done' && (
          <select className="text-input" aria-label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        {step === 'provider' && provider && (
          <>
            <p className="machine-sheet-lede">{provider.label} key. It is kept on this Mac and not shown again.</p>
            {provider.fields.map((f) => (
              <input
                key={f}
                className="text-input"
                autoComplete="off"
                placeholder={f}
                aria-label={f}
                value={fields[f] ?? ''}
                onChange={(e) => setFields((cur) => ({ ...cur, [f]: e.target.value }))}
              />
            ))}
            <textarea
              className="text-input cloud-pem"
              autoComplete="off"
              rows={5}
              placeholder="Private key"
              aria-label="Private key"
              value={pem}
              onChange={(e) => setPem(e.target.value)}
            />
            {keyState === 'checking' && <div role="status">Checking the key…</div>}
            {keyState === 'refused' && (
              <div className="machine-sheet-error" role="alert">
                That key was refused.
              </div>
            )}
            {typeof keyState === 'object' && (
              <div className="machine-sheet-error" role="alert">
                {keyState.error}
              </div>
            )}
            <div className="machine-sheet-actions">
              <button className="btn-pill soft" onClick={onClose}>
                Cancel
              </button>
              <button className="btn-pill primary" disabled={!keyReady} onClick={() => void saveKey()}>
                Save key
              </button>
            </div>
          </>
        )}
        {step === 'machine' && (
          <>
            <input
              className="text-input"
              placeholder="Name"
              aria-label="Name"
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {optionsError && (
              <div className="machine-sheet-error" role="alert">
                {optionsError}
              </div>
            )}
            {options && (
              <>
                <div className="cloud-options" role="radiogroup" aria-label="Size">
                  {options.sizes.map((z) => (
                    <label key={z.id} className="cloud-option">
                      <input type="radio" name="cloud-size" checked={size === z.id} onChange={() => setSize(z.id)} />
                      <span>{sizeWords(z)}</span>
                      {z.pricePerHour !== null && <span className="cloud-price">{priceWords(z.pricePerHour, z.currency)}</span>}
                    </label>
                  ))}
                </div>
                <select className="text-input" aria-label="Region" value={region} onChange={(e) => setRegion(e.target.value)}>
                  {options.regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <div className="cloud-options" role="radiogroup" aria-label="Network">
                  <label className="cloud-option">
                    <input type="radio" name="cloud-network" checked={network === 'full'} onChange={() => setNetwork('full')} />
                    <span>Full</span>
                  </label>
                  <label className="cloud-option" title={limitedOff ? options.reasons.limitedNetwork : undefined}>
                    <input
                      type="radio"
                      name="cloud-network"
                      disabled={limitedOff}
                      checked={network === 'limited'}
                      onChange={() => setNetwork('limited')}
                    />
                    <span>Limited</span>
                    {limitedOff && options.reasons.limitedNetwork && <span className="cloud-price">{options.reasons.limitedNetwork}</span>}
                  </label>
                </div>
              </>
            )}
            <div className="machine-sheet-actions">
              <button className="btn-pill soft" onClick={onClose}>
                Cancel
              </button>
              <button className="btn-pill primary" disabled={!machineReady} onClick={() => void create()}>
                Create
              </button>
            </div>
          </>
        )}
        {step === 'create' && (
          <div className="host-install">
            <CreateSteps states={states} />
            {failed && (
              <div className="host-install-reason" role="alert">
                {failure}
                <button type="button" className="btn-pill soft" onClick={() => void create()}>
                  Try again
                </button>
              </div>
            )}
            <div className="host-install-reason">
              <span>Cancel deletes what was made.</span>
              <button type="button" className="btn-pill soft" onClick={() => void cancel()}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {step === 'done' && ready && (
          <div className="host-install">
            <div className="host-install-line" role="status">
              <Check size={12} strokeWidth={2} /> {ready.name} is ready
            </div>
            <div className="host-install-reason">
              <button
                type="button"
                className="btn-pill soft"
                onClick={() => {
                  pickNewChatHost({ id: ready.id, name: ready.name });
                  navigate({ name: 'home' });
                  onClose();
                }}
              >
                Start a chat on it
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
