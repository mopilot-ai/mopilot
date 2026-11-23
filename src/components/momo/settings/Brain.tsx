// Settings › MoMo › Brain (#2139, #2527): the one brain every kind of MoMo's work runs on (its main chat, routines, Quick ask) and what it does when that brain's account is at its limit. The brain is the main chat's own (window.native.momoChat, #2183); the picker is the one setup's Change opens.
import { useEffect, useRef, useState } from 'react';
import { effectiveAtLimit, type MomoAtLimit, type MomoRoleBrain } from '../../../../shared/momoPrefs.mjs';
import { saveMomoPref, useMomoPrefs } from '../../../session/momoPrefs';
import { useAccountView } from '../../../session/harness/useAccountView';
import type { HarnessId } from '../../../harness/types';
import { momoChatBridge, type MomoChatBridge } from '../../../lib/momoBridges';
import { toast, toastFailure } from '../../../store/core';
import { Group, Row, Select, Toggle } from '../../pages/settings/Controls';
import { BrainPicker, firstTierOf } from './BrainPicker';
import { perUse } from './perUse';
import { brainChangeNote } from './brainNotes';

const LIMIT_TEXT: Record<MomoAtLimit, string> = { nextAccount: 'Next account', pause: 'Pause', skip: 'Skip this run' };
const LIMITS: MomoAtLimit[] = ['nextAccount', 'pause', 'skip'];

/** The choice itself; Next account only when there is another account to move to. */
function LimitSelect({ noOther }: { noOther: boolean }) {
  const p = useMomoPrefs();
  const options = LIMITS.filter((v) => !noOther || v !== 'nextAccount').map((v) => ({ value: v, label: LIMIT_TEXT[v] }));
  return (
    <Select<MomoAtLimit>
      label="Brain at limit"
      value={effectiveAtLimit(p.atLimit, noOther)}
      options={options}
      width={130}
      onChange={(v) => void saveMomoPref('atLimit', v)}
    />
  );
}

/** On a first-tier harness: another account in the brain's billing lane (the one new chats use when it names none). */
function FirstTierLimit({ h, brain }: { h: HarnessId; brain: MomoRoleBrain }) {
  const view = useAccountView(h);
  const own = view.accounts.find((r) => r.account.id === brain.account) ?? view.active;
  const lane = own ? view.accounts.filter((r) => perUse(r) === perUse(own)) : view.accounts;
  return <LimitSelect noOther={lane.length < 2} />;
}

/** At a limit: the choices for the brain; a harness with one sign-in has no next account. */
function AtLimit({ brain }: { brain: MomoRoleBrain | null }) {
  const h = brain ? firstTierOf(brain.harness) : null;
  if (brain && h) return <FirstTierLimit h={h} brain={brain} />;
  return <LimitSelect noOther={!!brain} />;
}

/** MoMo's brain, read from and changed through MoMo's main chat (until it is in this build, the row says so). */
function BrainRow() {
  const bridge = momoChatBridge();
  if (bridge) return <LiveBrain bridge={bridge} />;
  return (
    <Row title="Brain" desc="Not available in this build">
      <AtLimit brain={null} />
    </Row>
  );
}

/** The latest change or read wins. */
function LiveBrain({ bridge }: { bridge: MomoChatBridge }) {
  const [brain, setBrain] = useState<MomoRoleBrain | null>(null);
  const [ready, setReady] = useState(false);
  // bumped by every change: a read or a change that settles after a newer one never shows an older brain
  const gen = useRef(0);
  useEffect(() => {
    let alive = true;
    const mine = gen.current;
    bridge.getBrain().then(
      (b) => {
        if (!alive || mine !== gen.current) return;
        setBrain(b);
        setReady(true);
      },
      (e) => {
        // a brain heard since says more than the failed read
        if (!alive || mine !== gen.current) return;
        toastFailure("Couldn't read MoMo's brain")(e);
        // a pick still goes to main, which has the brain
        setReady(true);
      },
    );
    const off = bridge.onBrainChanged((b) => {
      gen.current++;
      setBrain(b);
      setReady(true);
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);
  const pick = (next: MomoRoleBrain) => {
    const mine = ++gen.current;
    bridge.setBrain(next).then((r) => {
      if (mine === gen.current) setBrain(r.brain);
      const note = brainChangeNote(r);
      if (note) toast(note.text, note.kind);
    }, toastFailure("Couldn't change MoMo's brain"));
  };
  return (
    <Row title="Brain" desc="Everything MoMo does runs on it">
      <BrainPicker label="Brain" brain={brain} unsetLabel="Not set" disabled={!ready} onPick={pick} />
      <AtLimit brain={brain} />
    </Row>
  );
}

/** Off until the user allows it: a paired phone reads the brain, and changes it only with this on. */
function PhoneBrainRow() {
  const p = useMomoPrefs();
  return (
    <Row title="Let my phone change the brain" desc="Your paired phone can pick MoMo's harness, account and model.">
      <Toggle on={p.remote.brainChange} onChange={(v) => saveMomoPref('remote.brainChange', v)} />
    </Row>
  );
}

export function BrainSettings() {
  return (
    <Group title="Brain" desc="The harness, account and model MoMo thinks with.">
      <BrainRow />
      <PhoneBrainRow />
    </Group>
  );
}
