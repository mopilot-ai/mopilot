// The machine composer's model picker: This Mac's two-level picker (chip, effort panel, harness list, models beside it) fed by that machine's report and chat-scoped choices.
import { connectionsRoute } from '../../lib/connectionsRoute';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useHostAgentChoice } from '../../session/useHostAgentChoice';
import { useHostMachines } from '../../lib/hostMachines';
import { HostUpdateAction } from '../host/HostUpdateAction';
import { NoModelsNote } from './NoModelsNote';
import { useStore, set, toast } from '../../store/core';
import { native } from '../../lib/native';
import { startSignin } from '../../lib/hostSignin';
import { userError } from '../../../shared/userError.mjs';
import { chatBasicHarness } from '../../store/chats';
import { setChatConfig } from '../../store/projects';
import { navigate } from '../../store/panes';
import { hostFamilyOfHarness } from '../../../shared/host/chatIds.mjs';
import { agentLabel } from '../../../shared/host/agentReadiness.mjs';
import { hostModelSelection, modelDefaultEffort, type HostModelPick } from '../../../shared/host/models.mjs';
import { newChatEffortOf } from '../../harness/newChatEffort';
import { effortLabel } from '../../lib/format';
import { needsSignin, shownWithWanted } from '../../lib/machineAgents';
import {
  accountSigninAction,
  activeLogin,
  agentRow,
  effortWord,
  loginRows,
  machineChoices,
  type MachineChoice,
} from '../../lib/machinePicker';
import { agentOfKind, dropMachineSwitch, switchMachineChat } from '../../store/machineChatSwitch';
import { setSession, useSessionField } from '../../store/session/useSession';
import { Popover, useAnchor } from '../ui/Popover';
import { MenuList, MenuRow } from '../ui/MenuList';
import { ChevronDown, ChevronRight } from '../ui/icons';
import { EffortPanel } from '../harnessPicker/EffortPanel';
import { BasicBadge, BasicHarnessIcon, HarnessIcon } from '../harnessPicker/badges';
import { HostMissingFix } from './HostMissingFix';
import { useComposerCommandOpen } from '../ui/useComposerCommandOpen';
import { AccountChoiceRow, HarnessRowView, ModelRowsView } from '../harnessPicker/pickerViews';
import { HostPickerSignin, useHostPickerSignin } from './HostPickerSignin';

/** An agent's mark: Claude Code's and Codex's own, any other agent's logo or initial. */
function AgentIcon({ id, size }: { id: string; size: number }) {
  // the agents the app runs itself have their own marks: the id the app names a machine chat's agent by says which
  const own = hostFamilyOfHarness(`host-${id}`);
  return own ? <HarnessIcon h={own} size={size} /> : <BasicHarnessIcon id={id} size={size} />;
}

type PickerOwner = { threadId: string | null; hostId: string };

export function HostModelPicker(props: PickerOwner) {
  return <MachinePicker key={JSON.stringify([props.threadId, props.hostId])} {...props} />;
}

function MachinePicker({ threadId, hostId }: PickerOwner) {
  const draft = useHostAgentChoice();
  const { machines } = useHostMachines();
  const machine = machines.find((m) => m.id === hostId);
  const renewal = useHostPickerSignin(hostId, machine);
  const basic = useStore((s) => (threadId ? chatBasicHarness(threadId, s) : null));
  const saved = useStore((s) => (threadId ? s.chatConfig[threadId]?.hostSelection : s.newChatHost?.selection));
  // a chat the Host moved to another agent: the one it said, else the one the chat's id names
  const moved = useStore((s) => (threadId ? agentOfKind(s.chatConfig[threadId]?.hostAgent) : null));
  const harness = threadId ? (moved ?? hostFamilyOfHarness(basic ?? '') ?? basic ?? '') : (draft?.choice?.harness ?? draft?.want ?? '');
  const pending = useSessionField(threadId, (x) => x.pendingSwitch);
  const [refused, setRefused] = useState<string | null>(null);
  const name = machine?.name ?? draft?.pick.name ?? hostId;
  // a chat on a machine can move to any other agent there: the Host holds the choice until the next message (D13). Ready ones first.
  // the agent the chat is on (or a new chat wants) is listed even when the machine lacks it, with its fix
  const wanted = threadId ? harness : (draft?.want ?? '');
  const agents = shownWithWanted(machine?.agents ?? [], wanted ? { id: wanted, label: agentLabel(wanted) } : null).sort(
    (x, y) => Number(y.state === 'ready') - Number(x.state === 'ready'),
  );
  const agent = machine?.agents.find((a) => a.id === harness);
  const models = agent?.models ?? [];
  // a new chat starts on the effort a new local chat of that harness shows (the one resolver the local picker uses: the remembered pick, then Codex's config file) when this machine's model offers it; a started chat keeps its own pick
  const remembered = useStore((s) => (threadId ? null : newChatEffortOf(harness, s)));
  const selected = hostModelSelection(models, saved, hostId, harness, remembered);
  const names = machineChoices(models, name);
  const chipLabel = selected.unavailable
    ? selected.model
      ? 'Effort unavailable'
      : 'Model unavailable'
    : (names.labelOf(selected.model?.id) ?? agentLabel(harness));
  const effort = selected.unavailable ? null : effortWord(selected.effort, effortLabel);
  const login = agent ? activeLogin(agent) : null;
  const a = useAnchor();
  const [list, setList] = useState(false);
  // once the harness list has shown, the effort panel coming back is a change of view, not a fresh open (popovers.css, .picker-view)
  const [viewed, setViewed] = useState(false);
  useEffect(() => {
    if (list) setViewed(true);
    else if (!a.open) setViewed(false);
  }, [list, a.open]);
  // the model-picker shortcut opens this picker as a click on its chip does
  const listFirst = !selected.model || selected.unavailable;
  useComposerCommandOpen('open-model-picker', {
    anchor: a.anchor,
    setOpen: (open) => {
      setList(listFirst);
      a.setOpen(open);
    },
  });
  const [hover, setHover] = useState<{ id: string; el: HTMLElement; byKey?: boolean } | null>(null);
  const rows = useRef<Record<string, HTMLElement | null>>({});
  useEffect(() => {
    if (!list) setHover(null);
    else if (agent?.state === 'ready' && rows.current[harness]) setHover({ id: harness, el: rows.current[harness]! });
  }, [list, harness, agent?.state]);
  const save = (pick: HostModelPick) => {
    if (threadId) setChatConfig(threadId, { hostSelection: pick });
    else set((s) => (s.newChatHost?.id === hostId ? { newChatHost: { ...s.newChatHost, agent: pick.harness, selection: pick } } : {}));
  };
  // A new chat whose effort is not the Host's own default (the remembered one, or the shared rule for a Host that reports none): keep it as the pick, so the Host runs what the chip says.
  const fallbackEffort = selected.model && !saved && selected.effort !== selected.model.defaultEffort ? selected.effort : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: save only writes the new-chat pick, and the model's id stands for the model
  useEffect(() => {
    if (!threadId && fallbackEffort && selected.model && agent?.state === 'ready')
      save({ hostId, harness, model: selected.model.id, effort: fallbackEffort });
  }, [threadId, fallbackEffort, selected.model?.id, agent?.state, hostId, harness]);
  /** Another agent for this chat: the Host agrees first, and the chip above the composer shows the choice. `pick` names no model for an agent the machine reports none for (its own default). */
  const moveTo = (chatId: string, pick: Parameters<typeof switchMachineChat>[1]) =>
    void switchMachineChat(chatId, pick, name).then((line) => {
      setRefused(line);
      if (!line) setList(false);
    });
  /** An installed agent that is signed out: the Host signs it in from here (the page opens on this Mac); a new chat follows it so its sign-in card shows the progress. */
  /** Ask every machine again now: the Host re-reads an agent it could not check. */
  const recheck = async () => {
    try {
      await native.host.check();
    } catch (e) {
      toast(userError(e), 'error');
    }
  };
  const signIn = (id: string, label: string) => {
    if (!threadId) set((s) => (s.newChatHost?.id === hostId ? { newChatHost: { ...s.newChatHost, agent: id, selection: undefined } } : {}));
    // a started chat has no card that follows the agent, so the closing list would show nothing: say what began
    else toast(`Signing in to ${label}…`);
    void startSignin(hostId, id).catch((e) => toast(userError(e), 'error'));
    a.close();
  };
  const choose = (id: string, c: MachineChoice) => {
    const m = c.model;
    const effort = id === harness && selected.effort && m.efforts.includes(selected.effort) ? selected.effort : modelDefaultEffort(m);
    if (threadId && id !== harness) {
      moveTo(threadId, { agent: id, model: m.id, modelLabel: c.label, effort: effort ?? undefined });
      return;
    }
    // the chat's own agent again takes back a choice made earlier
    if (threadId && pending) {
      void setSession(threadId, { pendingSwitch: null });
      void dropMachineSwitch(threadId, harness);
    }
    setRefused(null);
    save({ hostId, harness: id, model: m.id, effort });
    setList(false);
  };
  const flyout = hover ? agents.find((x) => x.id === hover.id && x.state === 'ready') : undefined;
  const flyoutNames = flyout ? machineChoices(flyout.models ?? [], name) : null;
  const accounts = flyout ? loginRows(flyout) : [];
  const signin = flyout && machine?.status !== 'offline' ? accountSigninAction(flyout) : null;
  const head = `${agentLabel(harness)} · ${chipLabel}`;
  return (
    <>
      <button
        ref={a.ref}
        className={`model-btn ${a.open ? 'active' : ''}`}
        aria-label="Select model"
        title={`${head}${login ? ` · ${login.label}` : ''} on ${name}`}
        onClick={() => {
          setList(listFirst);
          a.toggle();
        }}
      >
        <AgentIcon id={harness} size={14} />
        <span className="model-name">{chipLabel}</span>
        {effort && <span className="model-effort">{effort}</span>}
        <ChevronDown size={13} strokeWidth={2} className="model-chevron" />
      </button>
      <Popover
        anchor={a.anchor}
        open={a.open && !list}
        onClose={a.close}
        placement="top-end"
        className={viewed ? 'picker picker-view' : 'picker'}
      >
        <EffortPanel
          open={a.open && !list}
          efforts={selected.model?.efforts ?? []}
          effort={selected.effort}
          model={
            <>
              <AgentIcon id={harness} size={12} /> {head}
            </>
          }
          modelTitle={head}
          noEffort="This model has no effort levels"
          onBack={() => setList(true)}
          onEffort={(e) => selected.model && save({ hostId, harness, model: selected.model.id, effort: e })}
          onReset={() => selected.model && save({ hostId, harness, model: selected.model.id, effort: modelDefaultEffort(selected.model) })}
        >
          {threadId && <div className="menu-desc hp-note">Applies from the next message</div>}
          {login && (
            <>
              <div className="menu-sep" role="separator" />
              <button
                type="button"
                className="menu-item hp-account"
                aria-haspopup="menu"
                aria-label={`Account: ${login.label}`}
                title={login.label}
                onClick={() => setList(true)}
              >
                <span className="hp-account-name">{login.label}</span>
                <span className="hp-account-note">{loginRows(agent!).find((r) => r.rowKey === login.id)?.desc}</span>
                <ChevronRight size={12} className="hp-account-chevron" />
              </button>
            </>
          )}
        </EffortPanel>
      </Popover>
      <Popover anchor={a.anchor} open={a.open && list} onClose={a.close} placement="top-end" className="picker picker-view">
        <MenuList
          className="menu hp-harnesses"
          style={{ width: 300 }}
          label="Harness"
          onBack={selected.model && !selected.unavailable ? () => setList(false) : undefined}
        >
          {selected.model && !selected.unavailable && (
            <MenuRow bare className="hp-head hp-back" onClick={() => setList(false)}>
              ‹ Harness
            </MenuRow>
          )}
          {refused && (
            <div className="menu-desc hp-note" role="alert">
              {refused}
              <HostUpdateAction hostId={hostId} text={refused} />
            </div>
          )}
          {agents.map((x) => {
            const row = agentRow(x, name);
            return (
              <HarnessRowView
                key={x.id}
                icon={<AgentIcon id={x.id} size={18} />}
                title={x.label}
                titleBadge={hostFamilyOfHarness(`host-${x.id}`) ? null : <BasicBadge id={x.id} />}
                badge={row.badge}
                usage={row.usage}
                usageTone={row.usageTone}
                extra={
                  <>
                    {row.why && <span className="menu-desc">{row.why}</span>}
                    {x.state === 'missing' && machine && (
                      <HostMissingFix machine={machine} agentId={x.id} label={x.label} onTerminal={a.close} />
                    )}
                    {x.unsure && (
                      <span className="hp-actions">
                        <MenuRow
                          bare
                          className="hp-mini"
                          aria-disabled={false}
                          aria-label={`Check ${x.label} again`}
                          onClick={() => void recheck()}
                        >
                          Retry
                        </MenuRow>
                      </span>
                    )}
                    {needsSignin(x) && (
                      <span className="hp-actions">
                        <MenuRow
                          bare
                          className="hp-mini primary"
                          aria-disabled={false}
                          aria-label={`Sign in to ${x.label}`}
                          onClick={() => signIn(x.id, x.label)}
                        >
                          Sign in
                        </MenuRow>
                      </span>
                    )}
                  </>
                }
                disabled={row.disabled}
                actions={x.state === 'missing' || needsSignin(x) || x.unsure === true}
                current={x.id === harness}
                hovered={hover?.id === x.id}
                onOpen={(el, byKey) => setHover({ id: x.id, el, byKey })}
                rowRef={(el) => (rows.current[x.id] = el)}
              />
            );
          })}
          {!agents.length && <NoModelsNote machine={machine} hostId={hostId} name={name} />}
          <div className="menu-sep" role="separator" />
          <MenuRow
            onClick={() => {
              a.close();
              navigate(connectionsRoute('other'));
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
        open={!!hover && list && a.open}
        onClose={() => setHover(null)}
        placement="right-start"
        offset={8}
      >
        {hover && flyout && flyoutNames && (
          <MenuList style={{ width: 280 }} label={flyout.label} autoFocus={!!hover.byKey} onBack={() => setHover(null)}>
            {accounts.length > 0 && (
              <>
                <div className="hp-head">{accounts.length > 1 ? 'Accounts' : 'Account'}</div>
                {accounts.map((r) => (
                  <Fragment key={r.rowKey}>
                    <AccountChoiceRow {...r} />
                    {signin?.id === r.rowKey && (
                      <MenuRow
                        aria-label={`${signin.label} to ${flyout.label}`}
                        disabled={!renewal.available(flyout.id)}
                        onClick={() => {
                          a.close();
                          renewal.open(flyout.id);
                        }}
                      >
                        {signin.label}
                      </MenuRow>
                    )}
                  </Fragment>
                ))}
                <div className="menu-sep" role="separator" />
              </>
            )}
            <div className="hp-head">Models</div>
            {flyoutNames.choices.length ? (
              <ModelRowsView
                models={flyoutNames.choices}
                current={flyout.id === harness ? flyoutNames.currentOf(selected.model?.id) : null}
                onPick={(m) => choose(flyout.id, flyoutNames.choices.find((c) => c.id === m.id)!)}
              />
            ) : (
              <div>
                {!threadId && (
                  <MenuRow
                    role="menuitemradio"
                    aria-checked={harness === flyout.id}
                    onClick={() => {
                      set((s) =>
                        s.newChatHost?.id === hostId ? { newChatHost: { ...s.newChatHost, agent: flyout.id, selection: undefined } } : {},
                      );
                      a.close();
                    }}
                  >
                    Use {flyout.label} default
                  </MenuRow>
                )}
                {threadId && flyout.id !== harness && (
                  <MenuRow role="menuitem" onClick={() => moveTo(threadId, { agent: flyout.id, modelLabel: flyout.label })}>
                    Switch to {flyout.label} (its default model)
                  </MenuRow>
                )}
                <NoModelsNote machine={machine} hostId={hostId} name={name} what={flyout.label} />
              </div>
            )}
          </MenuList>
        )}
      </Popover>
      {renewal.dialog && <HostPickerSignin {...renewal.dialog} />}
    </>
  );
}
