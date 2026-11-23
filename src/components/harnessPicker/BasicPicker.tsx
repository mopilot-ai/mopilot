// Admitted ACP harness choices, session-provided configuration menus, and leaving a basic-harness chat for another harness.
import { UpdateAvailable } from '../harness/UpdateAvailable';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../store/session/useSession';
import { ownsComposerCommand } from '../../lib/shortcutFocus';
import { useStore, toast } from '../../store/core';
import { pickNewChatHarness, chatKind } from '../../store/chats';
import { acpModelName, basicLabel, optionValues, useFreshBasics } from '../../session/harness/acp';
import { chooseBasicConfig, useBasicSelection } from '../../session/acpControls';
import type { AcpConfigOption } from '../../lib/native';
import { useEnabledHarnesses } from '../../lib/flags';
import { HARNESS_LABEL, type HarnessId } from '../../harness/types';
import { basicAccountView } from '../../harness/accountView';
import { Popover, useAnchor } from '../ui/Popover';
import { MenuList, MenuRow } from '../ui/MenuList';
import { Check, ChevronDown } from '../ui/icons';
import { BasicBadge, BasicHarnessIcon, HarnessIcon } from './badges';
import type { NewChatTarget } from '../../session/harness/switch';
import { isFirstTier } from '../../harness/adapter';
import { setSelection } from '../../session/harness/select';
import { applySwitch, switchModel } from './applySwitch';
import { clearPendingSwitch } from './SwitchChip';
import { AcpSwitchSheet } from './AcpSwitchSheet';

/** What a basic harness's row says when it can't run MoMo (#2278). */
export const UNCONFINED = "Can't run MoMo: its own tools can't be turned off";

/**
 * Basic harnesses that passed admission, for a new chat. The rest are only in Settings → Other harnesses. `momo`: MoMo's
 * brain menu, where one whose quirks can't confine it is shown off, with why.
 */
export function BasicRows({ current, onPick, momo = false }: { current: string | null; onPick: (id: string) => void; momo?: boolean }) {
  // one installed since the app last looked shows up when the menu opens
  useFreshBasics();
  const all = useStore((s) => s.basicHarnesses);
  const list = all.filter((h) => h.state === 'admitted');
  if (!list.length) return null;
  return (
    <>
      <div className="menu-sep" role="separator" />
      {list.map((h) => {
        // MoMo's menu: one its quirks can't confine, or one that can't run MoMo now, is off with why
        const why = momo ? (h.isolates ? h.momoBlocked : UNCONFINED) : null;
        const off = !!why;
        return (
          <MenuRow
            key={h.id}
            className="has-desc hp-row"
            data-harness={h.id}
            role="menuitemradio"
            aria-checked={current === h.id}
            disabled={off}
            onClick={() => onPick(h.id)}
          >
            <span className="menu-icon hp-icon">
              <BasicHarnessIcon id={h.id} size={18} />
            </span>
            <span className="menu-label">
              <span className="menu-title hp-title">
                {basicLabel(h.id)} <BasicBadge id={h.id} />
              </span>
              <span className="menu-desc" data-account={`acp:${h.id}`}>
                {why || basicAccountView({ ...h, label: h.label ?? basicLabel(h.id) }).line}
              </span>
              <UpdateAvailable kind={`acp:${h.id}`} />
            </span>
            <span className="menu-check">{current === h.id ? <Check size={15} strokeWidth={2} /> : null}</span>
          </MenuRow>
        );
      })}
    </>
  );
}

/** More values than this scroll in their own list (opencode lists every model of every provider). */
const LONG_LIST = 8;

/** One select option's values as radio rows; a long list scrolls, with the current value in view when it opens. */
function OptionValues({ o, onPick }: { o: AcpConfigOption; onPick: (value: unknown) => void }) {
  const values = optionValues(o);
  const list = useRef<HTMLDivElement>(null);
  // a block body: scrollIntoView may return a promise, which React would take for a cleanup
  useEffect(() => {
    list.current?.querySelector('[aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const rows = values.map((v) => (
    <MenuRow key={String(v.value)} role="menuitemradio" aria-checked={v.value === o.currentValue} onClick={() => onPick(v.value)}>
      <span className="menu-label">
        <span className="menu-title">{v.name}</span>
      </span>
      <span className="menu-check">{v.value === o.currentValue ? <Check size={15} strokeWidth={2} /> : null}</span>
    </MenuRow>
  ));
  return values.length > LONG_LIST ? (
    <div ref={list} className="menu-scroll acp-values">
      {rows}
    </div>
  ) : (
    <>{rows}</>
  );
}

/** The first-tier harnesses, then the admitted basic ones: `onPick` gets the one chosen. */
function HarnessList({ current, onPick }: { current: string; onPick: (t: NewChatTarget) => void }) {
  const enabledHarnesses = useEnabledHarnesses();
  return (
    <>
      <div className="hp-head">Harness</div>
      {enabledHarnesses.map((h) => (
        <MenuRow key={h} className="hp-row" onClick={() => onPick({ family: h })}>
          <span className="menu-icon hp-icon">
            <HarnessIcon h={h} size={18} />
          </span>
          <span className="menu-label">
            <span className="menu-title hp-title">{HARNESS_LABEL[h]}</span>
          </span>
          <span className="menu-check" />
        </MenuRow>
      ))}
      <BasicRows current={current} onPick={(b) => onPick({ family: 'acp', basic: b })} />
    </>
  );
}

/**
 * The composer's compact model button on a basic harness: its full identity in the menu, its own options (model, effort,
 * … but not its mode, which has a separate menu), and the harness list. Before a chat's session opens the options are the
 * harness's catalog on the defaults new chats start with, and a choice there sets that default. For a new chat a
 * harness simply becomes the one it starts on; in a chat the next message continues on the chosen harness.
 */
export function BasicPicker({ threadId, id }: { threadId: string | null; id: string }) {
  const a = useAnchor();
  const [sheet, setSheet] = useState<NewChatTarget | null>(null);
  const label = basicLabel(id);
  const pending = useSession(threadId).pendingSwitch;
  // the harness's own config options (model, thought level, …), each as it named them
  const sel = useBasicSelection(threadId, id);
  const config = pending ? [] : sel.options;
  const modelName = acpModelName(config);
  // Provider-qualified display names stay in the menu and tooltip; opaque model values are never rewritten.
  const compactName = modelName?.split('/').pop()?.trim() || modelName || label;
  const fullName = modelName ? `${label} · ${modelName}` : label;
  // cannot reject: a value the harness refuses is said in a toast and the old one stays
  const choose = (configId: string, value: unknown) => void chooseBasicConfig(threadId, id, sel, configId, value);
  const pick = (t: NewChatTarget) => {
    a.close();
    if (!threadId) return pickNewChatHarness('basic' in t ? `acp:${t.basic}` : t.family);
    // the harness the chat is on already
    const target = 'basic' in t ? (`acp:${t.basic}` as const) : t.family;
    if (target === chatKind(threadId)) return clearPendingSwitch(threadId);
    setSheet(t);
  };
  // the model-picker shortcut opens this menu: it always has the harness list, with the harness's options when it lists any
  useEffect(() => {
    const open = (event: Event) => {
      if (ownsComposerCommand(event, a.anchor)) a.setOpen(true);
    };
    window.addEventListener('open-model-picker', open);
    return () => window.removeEventListener('open-model-picker', open);
  }, [a]);
  return (
    <>
      <button
        ref={a.ref}
        title={fullName}
        className={`model-btn acp-model-trigger ${a.open ? 'active' : ''}`}
        onClick={a.toggle}
        aria-label="Select model"
      >
        <BasicHarnessIcon id={id} size={14} />
        <span className="model-name">{compactName}</span>
        <ChevronDown size={13} strokeWidth={2} className="model-chevron" />
      </button>
      <Popover anchor={a.anchor} open={a.open} onClose={a.close} placement="top-end" className="picker">
        <MenuList className={`menu hp-harnesses${config.length ? ' acp-config' : ''}`} style={{ width: 300 }} label={label}>
          {pending && <div className="menu-desc hp-note">The session's model and settings apply when the next message switches.</div>}
          <div className="acp-picker-heading">
            <BasicHarnessIcon id={id} size={18} />
            <span>{label}</span>
            <BasicBadge id={id} />
          </div>
          {config.length ? (
            <>
              {config.map((o) => (
                <div key={o.id} role="group" aria-label={o.name}>
                  <div className="hp-head">{o.name}</div>
                  {o.type === 'boolean' ? (
                    <MenuRow role="menuitemcheckbox" aria-checked={!!o.currentValue} onClick={() => choose(o.id, !o.currentValue)}>
                      <span className="menu-label">
                        <span className="menu-title">{o.description ?? o.name}</span>
                      </span>
                      <span className="menu-check">{o.currentValue ? <Check size={15} strokeWidth={2} /> : null}</span>
                    </MenuRow>
                  ) : (
                    <OptionValues o={o} onPick={(v) => choose(o.id, v)} />
                  )}
                </div>
              ))}
              <div className="menu-desc hp-note">{threadId ? 'Applies from the next message' : `New ${label} chats start with these`}</div>
              <div className="menu-sep" role="separator" />
            </>
          ) : null}
          <HarnessList current={id} onPick={pick} />
        </MenuList>
      </Popover>
      {threadId && sheet && (
        <Popover anchor={a.anchor} open onClose={() => setSheet(null)} placement="top-end" className="picker">
          <AcpSwitchSheet
            threadId={threadId}
            target={'basic' in sheet ? `acp:${sheet.basic}` : sheet.family}
            onCancel={() => setSheet(null)}
            onConfirm={(choices) => {
              const target = 'basic' in sheet ? (`acp:${sheet.basic}` as const) : sheet.family;
              const model = switchModel(target);
              // only a first-tier harness lists models to wait for (a basic one starts on its own default)
              if (!model) return toast(`${HARNESS_LABEL[target as HarnessId]} is still loading its models`);
              setSheet(null);
              void applySwitch(threadId, { target, model }, choices, (effort) => {
                if (isFirstTier(target)) setSelection(target, { model: model.id || null, effort });
              });
            }}
          />
        </Popover>
      )}
    </>
  );
}
