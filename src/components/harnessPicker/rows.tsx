// Harness readiness rows and account/model choices for the selection flyout.
import { UpdateAvailable } from '../harness/UpdateAvailable';
import { useEffect, useState } from 'react';
import { ensureHarness, refreshHarnessModels } from '../../store/connection';
import { toast } from '../../store/core';
import { navigate } from '../../store/panes';
import { errorText } from '../../lib/ignored';
import { HARNESS_LABEL, type HarnessId, type HarnessModel } from '../../harness/types';
import {
  canPinChats,
  chooseAccount,
  chatAccountLabel,
  pinnedElsewhere,
  setChatAccount,
  useChatAccount,
  useHarnessModels,
  useModelsLoading,
} from '../../session/harness/select';
import type { Account } from '../../harness/accounts';
import { useAccountView } from '../../session/harness/useAccountView';
import { servingRow, standInRow } from '../../harness/accountView';
import { MenuRow } from '../ui/MenuList';
import { Check } from '../ui/icons';
import { PARTS } from '../harness/parts';
import { useAccountMenuUsageRefresh } from '../../harness/accountMenuUsage';
import { HarnessIcon, signInHarness } from './badges';
import { AccountChoiceRow, HarnessRowView, ModelRowsView } from './pickerViews';
import { automaticModel } from '../../harness/automaticModel';

export function HarnessRow({
  h,
  chatId,
  current,
  hovered,
  onHover,
  rowRef,
}: {
  h: HarnessId;
  chatId: string | null;
  current: boolean;
  hovered: boolean;
  /** byKey: opened from the keyboard, so the models list takes focus */
  onHover: (h: HarnessId, el: HTMLElement, byKey: boolean) => void;
  rowRef: (el: HTMLElement | null) => void;
}) {
  // listing Codex among the harnesses is its first use: start it if it was left idle at launch
  useEffect(() => void ensureHarness(h), [h]);
  const view = useAccountView(h);
  const ok = view.phase === 'ready';
  const disabled = !ok;
  // in a chat on this harness, the account that chat is on; the one it runs on now (a pinned one that lapsed is
  // told in the Accounts list), else the one new chats use
  const own = useChatAccount(h, chatId);
  // with Automatic on, an unpinned chat's next turn leaves a login that is out for the one with usage left (main's preflight)
  const [autoSwitch] = PARTS[h].useAutoSwitch();
  const serving = standInRow(view, servingRow(view, own?.serving), autoSwitch !== false, !!own?.pinned);
  const usage = serving?.short ?? null;
  let extra: React.ReactNode = null;
  if (view.phase === 'signed-out')
    extra = (
      <span className="hp-actions">
        <MenuRow bare className="hp-mini primary" aria-disabled={false} onClick={() => signInHarness(h, chatId)}>
          {PARTS[h].signInLabel}
        </MenuRow>
      </span>
    );
  else if (view.phase === 'missing') extra = <span className="menu-desc">{PARTS[h].missingHint}</span>;
  else if (view.phase === 'error') extra = <span className="menu-desc">{view.error}</span>;
  else if (view.empty?.hint) extra = <span className="menu-desc">{view.empty.hint}</span>;

  return (
    <HarnessRowView
      icon={<HarnessIcon h={h} size={18} />}
      title={HARNESS_LABEL[h]}
      badge={ok ? null : view.phaseLabel}
      usage={usage}
      usageKey={serving?.key}
      extra={extra}
      trailing={<UpdateAvailable kind={h} />}
      disabled={disabled}
      // Sign in stays pressable on a row whose choice is disabled: the row must not be aria-disabled around it
      actions={view.phase === 'signed-out'}
      current={current}
      hovered={hovered}
      onOpen={(row, byKey) => onHover(h, row, byKey)}
      rowRef={rowRef}
    />
  );
}

/**
 * The harness's accounts above its models. In a chat on this harness the pick is for that chat
 * ("Automatic" lets the pool decide, shown only when there is more than one account to move between); in a chat on another harness (`onSwitch`) a pick starts a switch to
 * it on that account and never changes what new chats use; otherwise it sets what new chats use: Automatic or one account.
 */
export function AccountList({
  h,
  chatId,
  busy,
  onSwitch,
  unavailable,
  allowAutomatic = true,
  pendingAccount,
  onKept,
}: {
  h: HarnessId;
  chatId: string | null;
  busy: boolean;
  onSwitch?: (a: Account | null) => void;
  /** why an account can't be picked here (MoMo's brain), shown as its line; null: it can */
  unavailable?: (a: Account) => string | null;
  allowAutomatic?: boolean;
  /** Account selected for a pending switch; null means automatic. */
  pendingAccount?: string | null;
  /** a pin or Automatic on this chat's own harness took effect: the caller drops a switch away from it that was still pending */
  onKept?: () => void;
}) {
  const view = useAccountView(h);
  const active = view.active?.account ?? null;
  const all = view.accounts;
  const own = useChatAccount(h, chatId);
  const [autoSwitch, setAutomatic] = PARTS[h].useAutoSwitch();
  const capable = canPinChats(h);
  const perChat = !!chatId && capable;
  // a chat only moves within its billing type: subscriptions with subscriptions (design: switching contract)
  const lane = (perChat ? all.find((r) => r.account.id === own?.id)?.account : null) ?? active;
  const accounts = perChat ? all.filter((r) => r.account.kind === (lane?.kind ?? 'subscription')) : all;
  useAccountMenuUsageRefresh(accounts.length, PARTS[h].refreshUsage);
  if (!accounts.length) return null;
  // one account leaves an unpinned chat nothing to choose: no Automatic row and no wait note, just that account,
  // checked; a pinned chat keeps Automatic so its pin (which the account row names) can be undone
  const laneCount = accounts.filter((r) => r.account.kind === (active?.kind ?? 'subscription')).length;
  const choice = allowAutomatic && (accounts.length > 1 || !!own?.pinned);
  const autoUnavailable = !capable
    ? 'Account switching is unavailable for this connection'
    : !perChat && laneCount < 2
      ? 'No other account of this kind'
      : null;
  const forNewChats = !chatId && !onSwitch;
  const automaticOn = autoSwitch && choice && !autoUnavailable;
  // the checked row, only ever one: in a switch list, only a pin the chat kept on this harness; for new chats,
  // Automatic while it is on, else the account in use; in the chat, its pin (none: Automatic), or its only account
  // when there is nothing to choose
  const pin = own?.pinned ? own.id : null;
  let current: string | null | undefined;
  if (onSwitch) current = pendingAccount !== undefined ? pendingAccount : perChat ? pin : active?.id;
  else if (!perChat) current = forNewChats && automaticOn ? null : active?.id;
  else current = choice ? pin : accounts[0].account.id;
  const automaticChecked = forNewChats ? automaticOn : current == null;
  const refusedAutomatic = (error: unknown) => toast(`Couldn't change automatic switching: ${errorText(error)}`, 'error');
  // an account replaces Automatic: off first, so the pool can't move away from the account just picked. Where Automatic
  // can't apply, only moving to another account can bring it back into effect, so picking the one in use leaves it be.
  const pickForNewChats = async (acct: Account) => {
    if (autoSwitch && choice && capable && (!autoUnavailable || acct.id !== active?.id)) {
      try {
        await setAutomatic(false);
      } catch (error) {
        return refusedAutomatic(error);
      }
    }
    return chooseAccount(acct);
  };
  // the Automatic row names no account of its own (the chat's status shows where it runs); it only says that a
  // pin the chat can't use right now is waiting
  const automaticNote =
    choice && pinnedElsewhere(own)
      ? chatAccountLabel(
          own,
          all.map((r) => r.account),
        )
      : null;
  // a pin for the chat that failed says why instead of leaving the menu as it was
  const keep = (done: Promise<unknown> | void) =>
    Promise.resolve(done).then(
      () => onKept?.(),
      (error) => toast(`Couldn't change the chat's account: ${errorText(error)}`, 'error'),
    );
  const pick = (acct: Account) => {
    // signed out: picking it signs it in again, wherever the list is
    if (acct.status !== 'ok') return chooseAccount(acct);
    if (onSwitch) return onSwitch(acct);
    if (perChat && !choice) return;
    if (!perChat) return pickForNewChats(acct);
    return keep(setChatAccount(h, chatId!, acct.id));
  };
  return (
    <>
      <div className="hp-head">{accounts.length > 1 ? 'Accounts' : 'Account'}</div>
      {choice && busy && !onSwitch && <div className="menu-desc hp-note">Wait for the current turn to finish to change it</div>}
      {choice && (
        <MenuRow
          className="has-desc"
          role="menuitemradio"
          aria-checked={automaticChecked}
          disabled={!!autoUnavailable || (busy && !onSwitch)}
          title={autoUnavailable ?? undefined}
          onClick={() => {
            if (onSwitch) onSwitch(null);
            else if (perChat) void keep(setChatAccount(h, chatId!, null));
            else if (!autoSwitch) void setAutomatic(true).catch(refusedAutomatic);
          }}
        >
          <span className="menu-label">
            <span className="menu-title">Automatic</span>
            <span className="menu-desc">
              {autoUnavailable ??
                (forNewChats
                  ? 'Automatic switching for all chats'
                  : (automaticNote ??
                    (autoSwitch
                      ? 'Moves to another account when one runs out'
                      : 'Uses the account in use; automatic switching is off in Settings')))}
            </span>
          </span>
          <span className="menu-check">{automaticChecked ? <Check size={15} strokeWidth={2} /> : null}</span>
        </MenuRow>
      )}
      {accounts.map((r) => {
        const why = unavailable?.(r.account) ?? null;
        return (
          <AccountChoiceRow
            key={r.key}
            rowKey={r.key}
            name={r.name}
            desc={why ?? [r.plan, r.status.text].filter(Boolean).join(' · ')}
            tone={why ? '' : r.status.tone}
            // signed out: dimmed, and picking it signs it in again
            dim={(perChat || !!onSwitch) && r.state === 'lapsed'}
            checked={r.account.id === current}
            // a switch picked during a turn waits for it (SwitchSheet), so only a pin for the chat waits here
            disabled={(perChat && choice && busy && !onSwitch) || !!why}
            onPick={() => pick(r.account)}
          />
        );
      })}
      <div className="menu-sep" role="separator" />
    </>
  );
}

/** How long an empty model list may read as loading before it says what to do instead. */
export const MODELS_LOADING_MS = 15_000;

/** `loading`, until it has lasted MODELS_LOADING_MS: then false, so the list stops spinning and says what to do. */
function useLoadingFor(loading: boolean) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    setOver(false);
    if (!loading) return;
    const t = setTimeout(() => setOver(true), MODELS_LOADING_MS);
    return () => clearTimeout(t);
  }, [loading]);
  return loading && !over;
}

export function ModelList({
  h,
  chatId = null,
  currentModel,
  automatic = false,
  allowAutomatic = true,
  onPick,
}: {
  h: HarnessId;
  /** the chat a sign-in from the empty list is for */
  chatId?: string | null;
  currentModel: string | null;
  automatic?: boolean;
  allowAutomatic?: boolean;
  onPick: (m: HarnessModel) => void;
}) {
  // a model released since the list was read shows up when the list opens: the harness is asked again
  useEffect(() => void refreshHarnessModels(h), [h]);
  const models = useHarnessModels(h);
  const auto = allowAutomatic ? automaticModel(models) : undefined;
  const choices = auto ? [auto, ...models] : models;
  const loading = useLoadingFor(useModelsLoading(h));
  const signedOut = useAccountView(h).phase === 'signed-out';
  // nothing listed: signed out, signing in lists them; signed in, the harness's page says why it lists none
  const empty = {
    text: signedOut ? 'Sign in to see models' : 'No models listed',
    action: signedOut ? PARTS[h].signInLabel : 'Settings',
    onAction: () => (signedOut ? signInHarness(h, chatId) : navigate({ name: 'settings', section: h })),
  };
  return (
    <ModelRowsView
      models={choices.map((m) => ({ id: m.id, label: m.label, description: m.description, more: m.more }))}
      current={automatic ? '' : currentModel}
      loading={loading}
      empty={empty}
      onPick={(m) => onPick(choices.find((x) => x.id === m.id)!)}
    />
  );
}
