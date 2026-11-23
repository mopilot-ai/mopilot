// MoMo's brain chip (#2139): the harness and model MoMo's main chat runs on ("Claude Code · Opus"; its account is in the menu),
// and a menu that changes them from the model picker's own harness, account and model rows, with its More row and effort
// panel (EffortPanel.tsx) for the effort MoMo replies at. MoMo's Chat puts it in its composer's model picker slot.
import { useEffect, useRef, useState } from 'react';
import { native, type MomoBrain } from '../../lib/native';
import { toast, toastFailure, useStore } from '../../store/core';
import { effortLabel } from '../../lib/format';
import { HARNESS_LABEL, type HarnessId, type HarnessModel } from '../../harness/types';
import { HARNESS_TRAITS } from '../../harness/family';
import { isFirstTier, type HarnessKind } from '../../harness/adapter';
import { useEnabledHarnesses } from '../../lib/flags';
import { useHarnessModels } from '../../session/harness/select';
import { basicLabel } from '../../session/harness/acp';
import { momoUnavailable } from './settings/perUse';
import { brainChangeNote } from './settings/brainNotes';
import type { Account } from '../../harness/accounts';
import { Popover, useAnchor } from '../ui/Popover';
import { MenuList } from '../ui/MenuList';
import { ChevronDown } from '../ui/icons';
import { BasicHarnessIcon, HarnessIcon } from '../harnessPicker/badges';
import { BasicRows } from '../harnessPicker/BasicPicker';
import { AccountList, HarnessRow, ModelList } from '../harnessPicker/rows';
import { EffortPanel, MoreRow } from '../harnessPicker/EffortPanel';
import { useBrainEffort } from './brainEffort';
import { useComposerCommandOpen } from '../ui/useComposerCommandOpen';

type BrainPick = Pick<MomoBrain, 'harness' | 'account' | 'model'> & { modelLabel?: string | null; effort?: string | null };

/** The first-tier harness a brain's kind names, or null for a basic harness ('acp:<id>'). */
const firstTier = (kind: string): HarnessId | null => (isFirstTier(kind as HarnessKind) ? (kind as HarnessId) : null);
/** The basic harness a brain's kind names. */
const basicOf = (kind: string) => kind.slice('acp:'.length);

/** The chip's words, compact as Muse's: harness · model, as far as the brain names them; the account is in the menu. */
function FirstTierLabel({ h, brain }: { h: HarnessId; brain: MomoBrain }) {
  return (
    <>
      <HarnessIcon h={h} size={14} />
      <span className="model-name">
        <FirstTierName h={h} brain={brain} />
      </span>
    </>
  );
}

/** "Claude Code · Opus": the harness and, as far as the brain names it, its model. */
function FirstTierName({ h, brain }: { h: HarnessId; brain: MomoBrain }) {
  const models = useHarnessModels(h);
  const model = models.find((m) => m.id === brain.model)?.label ?? brain.modelLabel ?? brain.model;
  return <>{[HARNESS_LABEL[h], model].filter(Boolean).join(' · ')}</>;
}

/** MoMo's brain as main has it now, into `set` while the chip is still there. */
const readBrain = (alive: { current: boolean }, set: (b: MomoBrain | null) => void) =>
  native.momoChat.getBrain().then((b) => alive.current && set(b), toastFailure("Couldn't read MoMo's brain"));

/** A harness's accounts above its models, as the model picker's flyout shows them. */
function Flyout(p: {
  h: HarnessId;
  /** MoMo's chat when it runs on this harness: its login is marked, and only its billing lane is listed */
  chatId: string | null;
  byKey: boolean;
  currentModel: string | null;
  onBack: () => void;
  onAccount: (acct: Account, fallback: HarnessModel | null) => void;
  onModel: (m: HarnessModel) => void;
}) {
  const models = useHarnessModels(p.h);
  const fallback = HARNESS_TRAITS[p.h].everydayModel(models);
  return (
    <MenuList style={{ width: 280 }} label={HARNESS_LABEL[p.h]} autoFocus={p.byKey} onBack={p.onBack}>
      <AccountList
        h={p.h}
        chatId={p.chatId}
        busy={false}
        onSwitch={(acct) => {
          if (acct) p.onAccount(acct, fallback);
        }}
        allowAutomatic={false}
        unavailable={(acct) => momoUnavailable(p.h, acct)}
      />
      <div className="hp-head">{HARNESS_LABEL[p.h]} · Models</div>
      <ModelList h={p.h} currentModel={p.currentModel} onPick={p.onModel} />
    </MenuList>
  );
}

export function BrainChip() {
  const [brain, setBrain] = useState<MomoBrain | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const enabled = useEnabledHarnesses();
  const a = useAnchor<HTMLButtonElement>();
  const [hover, setHover] = useState<{ h: HarnessId; el: HTMLElement; byKey?: boolean } | null>(null);
  const rows = useRef<Record<string, HTMLElement | null>>({});
  // the latest change's answer wins: an earlier one settling late never shows an older brain
  const seq = useRef(0);
  const alive = useRef(true);
  // the menu opens on the harness list; More shows the effort panel in its place
  const [more, setMore] = useState(false);
  // the model-picker shortcut, and a limit note's "Change brain", open it in MoMo's composer (the model picker's slot)
  useComposerCommandOpen('open-model-picker', a);
  useEffect(() => {
    if (!a.open) setMore(false);
  }, [a.open]);
  const busy = useStore((s) => (chatId ? !!s.runtime[chatId]?.activeTurnId : false));
  const current = brain ? firstTier(brain.harness) : null;
  // an effort picked stays on the brain's harness, account and model; the slider moves before main answers
  const setEffort = (b: MomoBrain, effort: string) => {
    setBrain({ ...b, effort });
    apply({ harness: b.harness, account: b.account, model: b.model, modelLabel: b.modelLabel, effort }, false);
  };
  const effort = useBrainEffort(brain, current, chatId, setEffort);
  useEffect(() => {
    alive.current = true;
    // MoMo's chat first: its first start picks the default brain, which is read after it
    native.momoChat
      .mainChat()
      .then((r) => alive.current && setChatId(r.chatId), toastFailure("Couldn't open MoMo's chat"))
      .then(() => readBrain(alive, setBrain));
    // a change made in another window
    // (removed when the chip goes, so it only runs while the chip is there)
    const off = native.momoChat.onBrainChanged((b) => {
      setBrain(b);
      // a change that started a new main chat moved MoMo there
      native.momoChat.mainChat().then((r) => alive.current && setChatId(r.chatId), toastFailure("Couldn't open MoMo's chat"));
    });
    return () => {
      alive.current = false;
      off();
    };
  }, []);
  if (!brain) return null;

  /** A change sent to main; a pick from the lists closes the menu, an effort leaves the panel open. */
  function apply(next: BrainPick, close = true) {
    if (close) {
      a.close();
      setHover(null);
    }
    const mine = ++seq.current;
    native.momoChat.setBrain(next).then(
      (r) => {
        if (mine !== seq.current) return;
        setBrain(r.brain);
        // a new main chat (to or from a basic harness) is MoMo's from now
        if (r.chatId) setChatId(r.chatId);
        const note = brainChangeNote(r);
        if (note) toast(note.text, note.kind);
      },
      (e) => {
        toastFailure("Couldn't change MoMo's brain")(e);
        // what main has now, not what the chip showed before
        if (mine === seq.current) void readBrain(alive, setBrain);
      },
    );
  }
  const effortName = effort?.effort ? (effort.labelOf ?? effortLabel)(effort.effort) : '';
  const harnessLine = current ? (
    <>
      <HarnessIcon h={current} size={12} /> <FirstTierName h={current} brain={brain} />
    </>
  ) : (
    <>
      <BasicHarnessIcon id={basicOf(brain.harness)} size={12} /> {basicLabel(basicOf(brain.harness))}
    </>
  );
  // on the brain's own harness the other pick stays; on another one it starts on that harness's default model
  const pickAccount = (h: HarnessId, acct: Account, fallback: HarnessModel | null) =>
    apply(
      h === current
        ? { harness: h, account: acct.id, model: brain.model, modelLabel: brain.modelLabel }
        : { harness: h, account: acct.id, model: fallback?.id ?? null, modelLabel: fallback?.label ?? null },
    );
  const pickModel = (h: HarnessId, m: HarnessModel) =>
    apply({ harness: h, account: h === current ? brain.account : null, model: m.id, modelLabel: m.label });

  return (
    <>
      <button ref={a.ref} className={`model-btn ${a.open ? 'active' : ''}`} onClick={a.toggle} aria-label="MoMo's brain">
        {current ? (
          <FirstTierLabel h={current} brain={brain} />
        ) : (
          <>
            <BasicHarnessIcon id={basicOf(brain.harness)} size={14} />
            <span className="model-name">{basicLabel(basicOf(brain.harness))}</span>
          </>
        )}
        {effortName && <span className="model-effort">{effortName}</span>}
        <ChevronDown size={13} strokeWidth={2} className="model-chevron" />
      </button>
      <Popover anchor={a.anchor} open={a.open && more && !!effort} onClose={a.close} placement="top-end" className="picker picker-view">
        {effort && (
          <EffortPanel
            open={a.open && more}
            efforts={effort.efforts}
            effort={effort.effort}
            labelOf={effort.labelOf}
            noEffort=""
            onEffort={effort.pick}
            onReset={effort.defaultEffort ? () => effort.pick(effort.defaultEffort!) : undefined}
            onBack={() => setMore(false)}
            model={harnessLine}
          >
            {busy && <div className="menu-desc hp-note">Applies from the next message</div>}
            <div className="menu-desc hp-note">For MoMo's replies. Background work stays on Low.</div>
          </EffortPanel>
        )}
      </Popover>
      <Popover anchor={a.anchor} open={a.open && !more} onClose={a.close} placement="top-end" className="picker">
        <MenuList className="menu hp-harnesses" style={{ width: 300 }} label="MoMo's brain">
          {enabled.map((id) => (
            <HarnessRow
              key={id}
              h={id}
              chatId={id === current ? chatId : null}
              current={id === current}
              hovered={hover?.h === id}
              onHover={(h, el, byKey) => setHover({ h, el, byKey })}
              rowRef={(el) => (rows.current[id] = el)}
            />
          ))}
          <BasicRows
            momo
            current={current ? null : basicOf(brain.harness)}
            onPick={(b) => apply({ harness: `acp:${b}`, account: null, model: null })}
          />
          {effort && (
            <>
              <div className="menu-sep" role="separator" />
              <MoreRow desc={effortName || 'Effort'} onClick={() => setMore(true)} />
            </>
          )}
        </MenuList>
      </Popover>
      <Popover
        anchor={hover?.el ?? null}
        open={!!hover && a.open && !more}
        onClose={() => setHover(null)}
        placement="right-start"
        offset={8}
      >
        {hover && (
          <Flyout
            h={hover.h}
            chatId={hover.h === current ? chatId : null}
            byKey={!!hover.byKey}
            currentModel={hover.h === current ? brain.model : null}
            onBack={() => setHover(null)}
            onAccount={(acct, fallback) => pickAccount(hover.h, acct, fallback)}
            onModel={(m) => pickModel(hover.h, m)}
          />
        )}
      </Popover>
    </>
  );
}
