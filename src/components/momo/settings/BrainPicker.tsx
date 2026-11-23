// MoMo's brain picker (#2139, #2527), the one setup's Change and Settings › MoMo › Brain open: a button saying the harness, model and account ("Codex · GPT-5.5 · team") or a plain Change, and a menu built from the model picker's own harness and model rows, with the harness's accounts and what each has left (the brain's own marked, only its billing lane once it has one, per-use ones badged). A pick is handed back, never applied to new chats or another chat.
import { useState } from 'react';
import type { MomoRoleBrain } from '../../../../shared/momoPrefs.mjs';
import { HARNESS_LABEL, type HarnessId, type HarnessModel } from '../../../harness/types';
import { HARNESS_TRAITS } from '../../../harness/family';
import { isFirstTier, type HarnessKind } from '../../../harness/adapter';
import { useEnabledHarnesses } from '../../../lib/flags';
import { useHarnessModels } from '../../../session/harness/select';
import { useAccountView } from '../../../session/harness/useAccountView';
import { basicLabel } from '../../../session/harness/acp';
import type { Account } from '../../../harness/accounts';
import { chooseAccount } from '../../../session/harness/select';
import { brainAccountState, momoUnavailable, perUse } from './perUse';
import { Popover, useAnchor } from '../../ui/Popover';
import { MenuList, MenuRow } from '../../ui/MenuList';
import { Check, ChevronDown } from '../../ui/icons';
import { BasicHarnessIcon, HarnessIcon } from '../../harnessPicker/badges';
import { BasicRows } from '../../harnessPicker/BasicPicker';
import { HarnessRow, ModelList } from '../../harnessPicker/rows';

/** The first-tier harness a brain names, or null for a basic harness ('acp:<id>'). */
export const firstTierOf = (kind: string): HarnessId | null => (isFirstTier(kind as HarnessKind) ? (kind as HarnessId) : null);
const basicOf = (kind: string) => kind.slice('acp:'.length);
const noRef = () => {
  /* the rows need no ref here */
};

/** The words for a brain on a first-tier harness: harness · model · account, as far as it names them. */
function FirstTierLabel({ h, brain }: { h: HarnessId; brain: MomoRoleBrain }) {
  const models = useHarnessModels(h);
  const view = useAccountView(h);
  const model = models.find((m) => m.id === brain.model)?.label ?? brain.modelLabel ?? brain.model;
  const account = view.accounts.find((r) => r.account.id === brain.account)?.name ?? null;
  return (
    <>
      <HarnessIcon h={h} size={14} />
      <span className="select-label">{[HARNESS_LABEL[h], model, account].filter(Boolean).join(' · ')}</span>
    </>
  );
}

/** A brain as its picker button says it. */
export function BrainLabel({ brain, unset = 'Default' }: { brain: MomoRoleBrain | null; unset?: string }) {
  if (!brain) return <span className="select-label">{unset}</span>;
  const h = firstTierOf(brain.harness);
  if (h) return <FirstTierLabel h={h} brain={brain} />;
  return (
    <>
      <BasicHarnessIcon id={basicOf(brain.harness)} size={14} />
      <span className="select-label">{basicLabel(basicOf(brain.harness))}</span>
    </>
  );
}

/** The accounts a role can run on here: its own marked, only its billing lane once it has one; a signed-out one signs in again. */
function RoleAccounts({ h, current, onPick }: { h: HarnessId; current: string | null; onPick: (acct: Account) => void }) {
  const view = useAccountView(h);
  // a role moves within its billing type, as a chat does: subscriptions with subscriptions
  const own = view.accounts.find((r) => r.account.id === current);
  const rows = own ? view.accounts.filter((r) => perUse(r) === perUse(own)) : view.accounts;
  if (!rows.length) return null;
  return (
    <>
      <div className="hp-head">{HARNESS_LABEL[h]} · Accounts</div>
      {rows.map((r) => {
        const why = momoUnavailable(h, r.account);
        return (
          <MenuRow
            key={r.key}
            data-account={r.key}
            className="has-desc"
            role="menuitemradio"
            aria-checked={r.account.id === current}
            disabled={!!why}
            onClick={() => (r.account.status === 'ok' ? onPick(r.account) : chooseAccount(r.account))}
          >
            <span className="menu-label">
              <span className="menu-title acct-email">
                {r.name}
                {perUse(r) && (
                  <>
                    {' '}
                    <span className="hp-badge">Billed per use</span>
                  </>
                )}
              </span>
              <span className={`menu-desc acct-status ${why ? '' : r.status.tone}`}>{why ?? brainAccountState(r)}</span>
            </span>
            <span className="menu-check">{r.account.id === current ? <Check size={15} strokeWidth={2} /> : null}</span>
          </MenuRow>
        );
      })}
      <div className="menu-sep" role="separator" />
    </>
  );
}

function Flyout(p: {
  h: HarnessId;
  currentAccount: string | null;
  currentModel: string | null;
  /** opened from the keyboard: the list takes focus */
  byKey: boolean;
  onBack: () => void;
  onAccount: (acct: Account, fallback: HarnessModel | null) => void;
  onModel: (m: HarnessModel) => void;
}) {
  const models = useHarnessModels(p.h);
  // a harness the brain moves to starts on its everyday model, not the strongest
  const fallback = HARNESS_TRAITS[p.h].everydayModel(models);
  return (
    <MenuList style={{ width: 280 }} label={HARNESS_LABEL[p.h]} autoFocus={p.byKey} onBack={p.onBack}>
      <RoleAccounts h={p.h} current={p.currentAccount} onPick={(acct) => p.onAccount(acct, fallback)} />
      <div className="hp-head">{HARNESS_LABEL[p.h]} · Models</div>
      <ModelList h={p.h} currentModel={p.currentModel} onPick={p.onModel} />
    </MenuList>
  );
}

/**
 * `onPick(null)` is Default (offered when `unset` names it). On the brain's own harness an account pick keeps the model
 * and a model pick keeps the account; on another harness it starts on that harness's default model and its own account.
 */
export function BrainPicker(
  props: {
    label: string;
    brain: MomoRoleBrain | null;
    /** what the button says with no brain yet (the Default row's name, when there is one) */
    unsetLabel?: string;
    disabled?: boolean;
    /** the button: the brain in words (Settings), or a plain Change (setup) */
    trigger?: 'brain' | 'change';
  } & (
    | { /** the Default row's name */ unset: string; onPick: (brain: MomoRoleBrain | null) => void }
    | { /** no Default row */ unset?: undefined; onPick: (brain: MomoRoleBrain) => void }
  ),
) {
  const { label, brain, unset, unsetLabel = unset, disabled, trigger = 'brain' } = props;
  const enabled = useEnabledHarnesses();
  const a = useAnchor<HTMLButtonElement>();
  const [hover, setHover] = useState<{ h: HarnessId; el: HTMLElement; byKey: boolean } | null>(null);
  const current = brain ? firstTierOf(brain.harness) : null;
  /** The brain when it is on `h`. */
  const on = (h: HarnessId) => (h === current ? brain : null);
  const close = () => {
    a.close();
    setHover(null);
  };
  const pick = (next: MomoRoleBrain) => {
    close();
    props.onPick(next);
  };
  const pickAccount = (h: HarnessId, acct: Account, fallback: HarnessModel | null) => {
    const own = on(h);
    pick(
      own
        ? { ...own, account: acct.id }
        : { harness: h, account: acct.id, model: fallback?.id ?? null, modelLabel: fallback?.label ?? null },
    );
  };
  const pickModel = (h: HarnessId, m: HarnessModel) =>
    pick({ harness: h, account: on(h)?.account ?? null, model: m.id, modelLabel: m.label });
  return (
    <>
      {trigger === 'change' ? (
        <button
          ref={a.ref}
          className="btn-pill"
          onClick={a.toggle}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={a.open}
          disabled={disabled}
        >
          Change
        </button>
      ) : (
        <button ref={a.ref} className="select-btn momo-brain-btn" onClick={a.toggle} aria-label={label} disabled={disabled}>
          <BrainLabel brain={brain} unset={unsetLabel} />
          <ChevronDown size={14} strokeWidth={2} />
        </button>
      )}
      <Popover anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end" className="picker">
        <MenuList className="menu hp-harnesses" style={{ width: 300 }} label={label}>
          {props.unset !== undefined && (
            <MenuRow role="menuitemradio" aria-checked={!brain} onClick={() => (close(), props.onPick(null))}>
              <span className="menu-label">
                <span className="menu-title">{unset}</span>
              </span>
              <span className="menu-check">{!brain ? <Check size={15} strokeWidth={2} /> : null}</span>
            </MenuRow>
          )}
          {enabled.map((id) => (
            <HarnessRow
              key={id}
              h={id}
              chatId={null}
              current={id === current}
              hovered={hover?.h === id}
              onHover={(h, el, byKey) => setHover({ h, el, byKey })}
              rowRef={noRef}
            />
          ))}
          <BasicRows
            momo
            current={brain && !current ? basicOf(brain.harness) : null}
            onPick={(b) => pick({ harness: `acp:${b}`, account: null, model: null, modelLabel: null })}
          />
        </MenuList>
      </Popover>
      <Popover anchor={hover?.el ?? null} open={!!hover && a.open} onClose={() => setHover(null)} placement="right-start" offset={8}>
        {hover && (
          <Flyout
            h={hover.h}
            currentAccount={on(hover.h)?.account ?? null}
            currentModel={on(hover.h)?.model ?? null}
            byKey={hover.byKey}
            onBack={() => setHover(null)}
            onAccount={(acct, fallback) => pickAccount(hover.h, acct, fallback)}
            onModel={(m) => pickModel(hover.h, m)}
          />
        )}
      </Popover>
    </>
  );
}
