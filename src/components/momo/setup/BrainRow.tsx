// Setup's brain (#2139, #2527, #2607): the brain MoMo starts on, chosen for the user (the account with the most remaining capacity on its harness's everyday model, defaultBrain.ts) and said only in the Meet screen's footnote; Settings › MoMo › Brain changes it. Here too: what setup says when none can run MoMo.
import { useCallback, useEffect, useState } from 'react';
import { noteIgnored } from '../../../lib/ignored';
import { momoChatBridge } from '../../../lib/momoBridges';
import type { MomoRoleBrain } from '../../../../shared/momoPrefs.mjs';
import type { HarnessId } from '../../../harness/types';
import { HARNESS_LABEL } from '../../../harness/types';
import { HARNESS_TRAITS } from '../../../harness/family';
import { useAccountView } from '../../../session/harness/useAccountView';
import { useHarnessModels } from '../../../session/harness/select';
import { basicAccountView, type HarnessAccountView } from '../../../harness/accountView';
import { basicLabel } from '../../../session/harness/acp';
import { useEnabledHarnesses } from '../../../lib/flags';
import { navigate } from '../../../store/panes';
import { useStore } from '../../../store/core';
import { brainAccountUse, momoUnavailable } from '../settings/perUse';
import { firstTierOf } from '../settings/BrainPicker';
import { defaultBrain, type BrainCandidate } from './defaultBrain';

/** How long Start waits for the default's model list. */
export const MODELS_WAIT_MS = 3000;
/** How long Start waits for a harness still detecting its login, so the default is chosen over every signed-in one. */
export const DETECT_WAIT_MS = 10_000;

/** A harness that is signed in, or left idle until its first use (D-66): its accounts are known either way. */
const SIGNED_IN = new Set(['ready', 'not-started', 'checking']);

/** What one first-tier harness offers: its candidate (null: nothing MoMo can run on now) and whether an account of it is at its limit. */
function offerOf(h: HarnessId, view: HarnessAccountView, models: { id: string; label: string; isDefault?: boolean }[]) {
  // still detecting with no account known yet: it may well be the better default, so setup waits for it
  const detecting = view.phase === 'checking' && view.accounts.length === 0;
  if (!SIGNED_IN.has(view.phase) || detecting) return { candidate: null, limited: false, loading: false, detecting };
  const offered = view.accounts.filter((r) => brainAccountUse(r) === 'offered');
  const limited = view.accounts.some((r) => brainAccountUse(r) === 'at-limit');
  if (!offered.length) return { candidate: null, limited, loading: false };
  const model = HARNESS_TRAITS[h].everydayModel(models);
  return {
    candidate: {
      harness: h,
      label: HARNESS_LABEL[h],
      accounts: offered.map((r) => ({ id: r.account.id, name: r.name, left: r.account.left, units: HARNESS_TRAITS[h].planUnits(r.plan) })),
      model: model && { id: model.id, label: model.label },
      multi: true,
    } satisfies BrainCandidate,
    limited,
    /** its models are not listed yet: the everyday one can't be named, and Start waits for them */
    loading: models.length === 0,
    detecting: false,
  };
}

type Offer = ReturnType<typeof offerOf>;

/** One turned-on first-tier harness: its offer reported as its accounts and models change, and null once it goes. */
function FirstTierSource({ h, onOffer }: { h: HarnessId; onOffer: (h: HarnessId, offer: Offer | null) => void }) {
  const offer = offerOf(h, useAccountView(h), useHarnessModels(h));
  // by content: a new view with the same accounts reports nothing
  const key = JSON.stringify(offer);
  useEffect(() => onOffer(h, JSON.parse(key)), [h, key, onOffer]);
  useEffect(() => () => onOffer(h, null), [h, onOffer]);
  return null;
}

/** A harness signed in with API keys only that MoMo can't run on (#2308): setup says why rather than leave it out unsaid. */
function KeyOnly({ h }: { h: HarnessId }) {
  const view = useAccountView(h);
  const why = view.accounts.map((r) => momoUnavailable(h, r.account)).find(Boolean);
  return why && !view.accounts.some((r) => brainAccountUse(r) !== null) ? <p className="momo-setup-note">{why}</p> : null;
}

/**
 * The brain setup starts MoMo on. `probes` reads each harness and goes in the page;
 * `shown` is the brain MoMo has (setup run again, or one picked before), else the default (null: nothing signed
 * in can run MoMo). `ready`: MoMo's brain is read and the default's model is known, or has been waited for long enough.
 */
export function useSetupBrain() {
  const enabled = useEnabledHarnesses();
  const [offers, setOffers] = useState<Partial<Record<HarnessId, Offer>>>({});
  // a brain MoMo already has (setup run again from Settings, or one picked before) is kept, never chosen over for the user;
  // undefined: not read yet
  const [current, setCurrent] = useState<MomoRoleBrain | null | undefined>(undefined);
  useEffect(() => {
    const bridge = momoChatBridge();
    if (!bridge) return setCurrent(null);
    let alive = true;
    bridge.getBrain().then(
      (b) => alive && setCurrent(b),
      (e) => {
        noteIgnored("read MoMo's brain for setup", e);
        if (alive) setCurrent(null);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  // a model list that never comes (a harness with none) is waited for a few seconds, not for ever
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), MODELS_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  // a harness that never finishes detecting is waited for longer, but not for ever
  const [detectWaited, setDetectWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDetectWaited(true), DETECT_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  const onOffer = useCallback(
    (h: HarnessId, offer: Offer | null) =>
      setOffers((prev) => {
        const next = { ...prev };
        if (offer) next[h] = offer;
        else delete next[h];
        return next;
      }),
    [],
  );
  const basics = useStore((s) => s.basicHarnesses);
  const first = enabled.flatMap((h) => offers[h]?.candidate ?? []);
  const basic: BrainCandidate[] = basics
    // one whose own tools can't be turned off never runs MoMo (#2278)
    .filter((b) => b.state === 'admitted' && b.isolates && !b.momoBlocked)
    .map((b) => {
      const v = basicAccountView({ ...b, label: b.label ?? basicLabel(b.id) });
      return {
        harness: `acp:${b.id}`,
        label: v.label,
        accounts: [{ id: null, name: v.managedBy, left: null, units: null }],
        model: null,
        multi: false,
      };
    });
  const fallback = defaultBrain([...first, ...basic]);
  const probes = [
    ...enabled.map((h) => <FirstTierSource key={h} h={h} onOffer={onOffer} />),
    ...enabled.map((h) => <KeyOnly key={`key-only-${h}`} h={h} />),
  ];
  const shown = current ?? fallback;
  const harness = shown ? enabled.find((h) => h === shown.harness) : undefined;
  // the default is only chosen once every turned-on harness reported what it offers (a brain MoMo already has needs no choice)
  const settled = current != null || detectWaited || enabled.every((h) => offers[h] && !offers[h].detecting);
  return {
    probes,
    shown,
    ready: current !== undefined && settled && (waited || !(harness && shown && !shown.model && offers[harness]?.loading)),
    /** signed in, but every account is at its limit until one resets */
    allLimited: !fallback && enabled.some((h) => offers[h]?.limited),
  };
}

/** What setup says when no brain can run MoMo: why, and the way to sign in. */
export function NoBrain({ allLimited }: { allLimited: boolean }) {
  return (
    <div className="momo-setup-empty">
      <p>{allLimited ? 'All your accounts are at their limit until one resets.' : 'Sign in to an agent first, then come back.'}</p>
      <button type="button" className="btn-pill" onClick={() => navigate({ name: 'settings', section: 'accounts' })}>
        Open Accounts and billing
      </button>
    </div>
  );
}

/** The brain in the footnote's words: its harness and, when it names one, its model ("Claude Code · Sonnet 5.5"). */
export function brainText(brain: MomoRoleBrain): string {
  const h = firstTierOf(brain.harness);
  const harness = h ? HARNESS_LABEL[h] : basicLabel(brain.harness.slice('acp:'.length));
  return brain.modelLabel ? `${harness} · ${brain.modelLabel}` : harness;
}
