// Codex/Claude model, effort and speed selection with cross-harness handoff state.
import { ownsComposerCommand } from '../../lib/shortcutFocus';
import { useEffect, useRef, useState } from 'react';
import { useStore, toast } from '../../store/core';
import { defaultHarness, pickNewChatHarness, chatFamily, chatBasicHarness, newChatHarness } from '../../store/chats';
import { navigate } from '../../store/panes';
import { useSession } from '../../store/session/useSession';
import { useChatCaps } from '../../store/session/useCaps';
import { modelHeader } from '../../harness/modelHeader';
import { COPY } from '../../harness/copy';
import { effortLabel } from '../../lib/format';
import { useEnabledHarnesses } from '../../lib/flags';
import { HARNESS_LABEL, type HarnessId, type HarnessModel, type PendingSwitch } from '../../harness/types';
import { firstTierOf } from '../../harness/family';
import { SwitchSheet } from './SwitchSheet';
import { AcpSwitchSheet } from './AcpSwitchSheet';
import {
  canPinChats,
  composerSelect,
  setSelection,
  useEffectiveSelection,
  useHarnessAccounts,
  useHarnessStatus,
} from '../../session/harness/select';
import { fastBillingNote, type Account } from '../../harness/accounts';
import { Popover, Tooltip, useAnchor } from '../ui/Popover';
import { MenuList, MenuRow } from '../ui/MenuList';
import { Check, ChevronDown, Zap } from '../ui/icons';
import { EffortPanel } from './EffortPanel';
import { PARTS } from '../harness/parts';
import { HarnessIcon } from './badges';
import { BasicRows } from './BasicPicker';
import { HarnessRow, AccountList, ModelList } from './rows';
import { clearPendingSwitch } from './SwitchChip';
import { applySwitch, switchModel } from './applySwitch';
import { AccountRow } from './AccountRow';
import { RouteMark } from './RouteMark';
import { headerProvider, useHarnessRoute } from '../../harness/routes';

/** The account a pending switch to `target` will use: null is Automatic, undefined none chosen. */
function pendingAccountOf(pending: PendingSwitch | null | undefined, target: HarnessId) {
  return pending?.harness === target ? (pending.automaticAccount ? null : (pending.account ?? undefined)) : undefined;
}

/** The first-tier picker for `h`, the composer's resolved first-tier harness (ModelPicker draws it only when there is one). */
export function FirstTierPicker({ threadId, h }: { threadId: string | null; h: HarnessId }) {
  const enabledHarnesses = useEnabledHarnesses();
  useStore((s) => newChatHarness(s));
  const pending = useSession(threadId).pendingSwitch;
  useStore((s) => (threadId ? s.segments[threadId] : null));
  const busy = useStore((s) => (threadId ? !!s.runtime[threadId]?.activeTurnId || s.pending.some((p) => p.threadId === threadId) : false));
  // the first-tier harness this chat is actually on (h may be a pending switch target, and the chat may be on a basic harness: null)
  const onHarness = threadId ? firstTierOf(chatFamily(threadId)) : h;
  // account: picked in another harness's Accounts list, for this chat only (never the harness's default)
  const [sheet, setSheet] = useState<{ target: HarnessId; model: HarnessModel; account?: string | null } | null>(null);
  // ACP uses the same chat, with its native settings supplied when the session opens.
  const [basicSheet, setBasicSheet] = useState<string | null>(null);
  const { modelId, model, automatic, efforts, effort, fast, tiers, tier, fastUnavailable, fastHidden } = useEffectiveSelection(h, threadId);
  // a new chat's draft keeps what is picked here over Settings' fixed default (session/newChatStart.ts)
  const select = (patch: Parameters<typeof composerSelect>[1]) => composerSelect(h, patch, threadId);
  const allowAutomatic = useStore((s) => !threadId || !s.momoModels?.[threadId]);
  const hStatus = useHarnessStatus(h);
  const a = useAnchor();
  const l1 = useAnchor<HTMLButtonElement>();
  const [hover, setHover] = useState<{ h: HarnessId; el: HTMLElement; byKey?: boolean } | null>(null);
  const rows = useRef<Record<string, HTMLElement | null>>({});
  useEffect(() => {
    const open = (event: Event) => {
      if (ownsComposerCommand(event, a.anchor)) a.setOpen(true);
    };
    window.addEventListener('open-model-picker', open);
    return () => window.removeEventListener('open-model-picker', open);
  }, [a]);
  useEffect(() => {
    if (!a.open) l1.close();
  }, [a.open, l1]);
  useEffect(() => {
    if (!l1.open) setHover(null);
    else if (rows.current[h]) setHover({ h, el: rows.current[h]! });
  }, [l1.open, h]);
  // Once the harness list has shown, the effort panel coming back is a change of view, not a fresh open: its
  // sections slide in (popovers.css, .picker-view) instead of the whole picker popping open again.
  const [viewed, setViewed] = useState(false);
  useEffect(() => {
    if (l1.open) setViewed(true);
    else if (!a.open) setViewed(false);
  }, [l1.open, a.open]);

  const choose = (target: HarnessId, m: HarnessModel, mapped?: string | null) => {
    const cur = target === h ? effort : null;
    const eff = mapped !== undefined ? mapped : cur && m.efforts.includes(cur) ? cur : m.defaultEffort;
    // Fast (or a tier) stays only where the new model offers it
    const keepTier = target === h && tier ? !!m.tiers?.some((t) => t.id === tier) : m.fast;
    const patch = { model: m.id || null, effort: eff, ...(keepTier ? {} : { fast: false }) };
    // a switch confirmed in an existing chat is no new chat's pick, even when it names no chat
    if (!threadId) composerSelect(target, patch, null);
    else setSelection(target, patch, target === onHarness ? threadId : null);
  };
  const pick = (target: HarnessId, m: HarnessModel) => {
    l1.close();
    if (threadId && target !== onHarness) {
      // another harness in an existing chat: confirm the handoff first (design §05)
      a.close();
      const account = pendingAccountOf(pending, target);
      setSheet({ target, model: m, account });
      return;
    }
    if (threadId && pending) clearPendingSwitch(threadId);
    // another harness in a new chat is this draft's: the saved default changes only in Settings → New chats use
    if (!threadId && target !== defaultHarness().kind) pickNewChatHarness(target);
    choose(target, m);
  };
  /**
   * Another harness's account picked in an existing chat: a switch to that harness on that account, confirmed
   * in the sheet like a model pick (design-v2 conflicts[15]), on the model the harness would use.
   */
  const pickAccount = (target: HarnessId, acct: Account | null) => {
    const m = switchModel(target);
    if (!m) return toast(`${HARNESS_LABEL[target]} is still loading its models`);
    l1.close();
    a.close();
    // without per-chat accounts there the chat runs on the one in use, which the sheet names
    setSheet({ target, model: m, account: canPinChats(target) ? (acct?.id ?? null) : undefined });
  };
  const fastNote = fastBillingNote(h, useHarnessAccounts(h).active);
  const fastTip =
    fastUnavailable ?? [PARTS[h].fastTip ?? (fast ? 'Disable fast mode' : 'Enable fast mode'), fastNote].filter(Boolean).join(' · ');
  const label = (model?.id === modelId ? model?.label : null) ?? modelId ?? 'Model';
  const caps = useChatCaps(threadId && h === onHarness ? threadId : null, { kind: h, model: modelId ?? undefined });
  // a provider MoPilot chose for the chat is its route; otherwise the harness's own config may set one
  const route = useHarnessRoute(h);
  const header = modelHeader({ harness: HARNESS_LABEL[h], provider: headerProvider(caps.provider, route), model: label });

  return (
    <>
      <button ref={a.ref} className={`model-btn ${a.open ? 'active' : ''}`} onClick={a.toggle} aria-label="Select model">
        <HarnessIcon h={h} size={14} />
        {fast && <Zap size={13} className="fast-icon" fill="currentColor" />}
        <span className="model-name">{label}</span>
        {effort && <span className="model-effort">{effortLabel(effort)}</span>}
        <RouteMark harness={h} label={HARNESS_LABEL[h]} hidden={!!caps.provider && !caps.provider.firstParty} />
        <ChevronDown size={13} strokeWidth={2} className="model-chevron" />
      </button>
      {hStatus.state === 'apikey' && (
        <Tooltip label={`Billed per token to your API key. Switch back in Settings → ${HARNESS_LABEL[h]}.`}>
          <span className="api-chip">API</span>
        </Tooltip>
      )}
      <Popover
        anchor={a.anchor}
        open={a.open && !l1.open}
        onClose={a.close}
        placement="top-end"
        className={viewed ? 'picker picker-view' : 'picker'}
      >
        <EffortPanel
          open={a.open && !l1.open}
          efforts={efforts}
          effort={effort}
          noEffort={model ? 'This model has no effort levels' : ''}
          onEffort={(e) => select({ effort: e })}
          // only the effort, to the model's own default: the model and speed stay as chosen
          onReset={() => select({ effort: model?.defaultEffort ?? null })}
          // the title row leads to the harness list, with each harness's models beside it
          onBack={l1.toggle}
          titleRef={l1.ref}
          titleExpanded={l1.open}
          model={
            <>
              <HarnessIcon h={h} size={12} /> {header}
            </>
          }
          lead={
            fastHidden ? undefined : (
              <Tooltip label={fastTip}>
                <button
                  className={`effort-icon-btn ${fast ? 'on' : ''}`}
                  disabled={!!fastUnavailable}
                  onClick={() => select(tiers.length ? { tier: fast ? null : tiers[0].id } : { fast: !fast })}
                  aria-label="Toggle fast mode"
                >
                  <Zap size={16} strokeWidth={1.7} fill={fast ? 'currentColor' : 'none'} />
                </button>
              </Tooltip>
            )
          }
        >
          {tiers.length > 1 && !fastUnavailable && (
            <div className="hp-tiers" role="radiogroup" aria-label={COPY.fast.speed}>
              {[{ id: null as string | null, name: COPY.fast.standard, description: COPY.fast.standardNote }, ...tiers].map((t) => (
                <button
                  type="button"
                  key={t.id ?? 'standard'}
                  className="menu-item has-desc"
                  role="radio"
                  aria-checked={tier === t.id}
                  onClick={() => select({ tier: t.id })}
                >
                  <span className="menu-label">
                    <span className="menu-title">{t.name}</span>
                    {t.description && <span className="menu-desc">{t.description}</span>}
                  </span>
                  <span className="menu-check">{tier === t.id ? <Check size={15} strokeWidth={2} /> : null}</span>
                </button>
              ))}
            </div>
          )}
          {busy && <div className="menu-desc hp-note">Applies from the next message</div>}
          {/* the account is named here, never on the model button */}
          <AccountRow h={h} chatId={threadId} onOpen={l1.toggle} />
        </EffortPanel>
      </Popover>
      {/* Replaces the effort popover (never shown together); the Models flyout opens beside it. */}
      <Popover anchor={a.anchor} open={l1.open && a.open} onClose={a.close} placement="top-end" className="picker picker-view">
        <MenuList className="menu hp-harnesses" style={{ width: 300 }} label="Harness" onBack={l1.close}>
          <MenuRow bare className="hp-head hp-back" onClick={l1.close}>
            ‹ Harness
          </MenuRow>
          {enabledHarnesses.map((id) => (
            <HarnessRow
              key={id}
              h={id}
              chatId={threadId && id === onHarness ? threadId : null}
              current={id === h}
              hovered={hover?.h === id}
              onHover={(hh, el, byKey) => setHover({ h: hh, el, byKey })}
              rowRef={(el) => (rows.current[id] = el)}
            />
          ))}
          <BasicRows
            current={null}
            onPick={(b) => {
              a.close();
              if (threadId && chatBasicHarness(threadId) === b) clearPendingSwitch(threadId);
              else if (threadId) setBasicSheet(b);
              else pickNewChatHarness(`acp:${b}`);
            }}
          />
          <div className="menu-sep" role="separator" />
          <MenuRow
            onClick={() => {
              a.close();
              navigate({ name: 'settings', section: 'harnesses' });
            }}
          >
            <span className="menu-label">
              <span className="menu-title hp-more">Manage harnesses…</span>
            </span>
          </MenuRow>
        </MenuList>
      </Popover>
      <Popover
        anchor={hover?.el ?? null}
        open={!!hover && l1.open && a.open}
        onClose={() => setHover(null)}
        placement="right-start"
        offset={8}
      >
        {hover && (
          <MenuList style={{ width: 280 }} label={HARNESS_LABEL[hover.h]} autoFocus={!!hover.byKey} onBack={() => setHover(null)}>
            <AccountList
              h={hover.h}
              chatId={threadId}
              busy={busy}
              onSwitch={threadId && hover.h !== onHarness ? (acct) => pickAccount(hover.h, acct) : undefined}
              pendingAccount={pendingAccountOf(pending, hover.h)}
              // choosing this chat's own harness while a switch away from it waits cancels that switch, as a model pick does
              onKept={threadId && pending && hover.h === onHarness ? () => clearPendingSwitch(threadId) : undefined}
            />
            <div className="hp-head">Models</div>
            <ModelList
              h={hover.h}
              chatId={threadId}
              currentModel={hover.h === h ? modelId : null}
              automatic={hover.h === h && automatic}
              allowAutomatic={allowAutomatic}
              onPick={(m) => pick(hover.h, m)}
            />
          </MenuList>
        )}
      </Popover>
      {threadId && basicSheet && (
        <Popover anchor={a.anchor} open onClose={() => setBasicSheet(null)} placement="top-end" className="picker">
          <AcpSwitchSheet
            threadId={threadId}
            target={`acp:${basicSheet}`}
            onCancel={() => setBasicSheet(null)}
            onConfirm={(choices) => {
              const target = `acp:${basicSheet}` as const;
              setBasicSheet(null);
              void applySwitch(threadId, { target, model: switchModel(target)! }, choices, () => undefined);
            }}
          />
        </Popover>
      )}
      {threadId && sheet && (
        <Popover anchor={a.anchor} open={!!sheet} onClose={() => setSheet(null)} placement="top-end" className="picker">
          {onHarness ? (
            <SwitchSheet
              threadId={threadId}
              from={onHarness}
              target={sheet.target}
              model={sheet.model}
              account={sheet.account}
              onCancel={() => setSheet(null)}
              onConfirm={(c) => {
                const picked = sheet;
                setSheet(null);
                void applySwitch(threadId, picked, c, (effort) => choose(picked.target, picked.model, effort));
              }}
            />
          ) : (
            <AcpSwitchSheet
              threadId={threadId}
              target={sheet.target}
              onCancel={() => setSheet(null)}
              onConfirm={(choices) => {
                const picked = sheet;
                setSheet(null);
                void applySwitch(threadId, picked, choices, (effort) => choose(picked.target, picked.model, effort));
              }}
            />
          )}
        </Popover>
      )}
    </>
  );
}
