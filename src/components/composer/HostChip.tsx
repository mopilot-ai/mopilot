// The chat's one Run on picker: in a started chat a status dot and laptop icon between + and the permission picker, in a new chat the context bar's where-it-runs chip (look 'ctx', with Codex Cloud as one more group when the agent has it). Its menu only picks a machine (this Mac and the user's machines from the registry, each with at most one short line: its state or the one thing it can't do; Add machine…, which opens the add sheet in place, and Switch host… which opens the dialog that continues the chat elsewhere; in a started chat another machine's row opens that dialog with it picked). Signing in to an agent on a machine happens in the chat's sign-in card and in Settings, never here.
import { Fragment, lazy, type ReactNode, Suspense, useCallback, useRef, useState } from 'react';
import { Laptop } from 'lucide-react';
import { ArrowLeftRight, Check, Plus } from '../ui/icons';
import { MenuList, MenuRow } from '../ui/MenuList';
import { Popover, Tooltip, useAnchor } from '../ui/Popover';
import { useHostAccess } from '../../lib/host';
import { useFlag } from '../../lib/flags';
import { capabilityNote } from '../../../shared/host/capabilityNote.mjs';
import { useHostMachines } from '../../lib/hostMachines';
import { machineReason, machineReasonTitle, type NoteAgent } from '../../lib/hostNote';
import { switchHostReason, targetsFor } from '../../lib/hostSwitch';
import { SwitchHostDialog, type CarryPlan, type ContinueRequest } from './SwitchHostDialog';
import { HostFolderPicker } from './HostFolderPicker';
import type { MachineAgent } from '../../lib/hostMachines';
import { cloudOn, useCloudLines } from '../../lib/hostCloud';
// loaded when the sheet is first opened: the chip stays light, and the flag off never loads it
const NewCloudMachineSheet = lazy(() =>
  import('../pages/settings/NewCloudMachineSheet').then((m) => ({ default: m.NewCloudMachineSheet })),
);
// Add machine… opens the Settings sheet here, so adding a machine never leaves the chat
const AddMachineSheet = lazy(() => import('../pages/settings/AddMachineSheet').then((m) => ({ default: m.AddMachineSheet })));

/** green: online; grey: offline; amber: needs attention (not signed in, a harness not installed). */
export type HostStatus = 'online' | 'offline' | 'attention';

/** One machine a chat can run on, as the registry reports it; `note` is the one-line reason ("SSH · Codex, Claude", "Offline"). */
export type HostMachine = {
  id: string;
  name: string;
  status: HostStatus;
  note: string;
  capabilities?: { iab?: boolean; cu?: boolean };
  /** the installed but signed-out agent that can be signed in from here */
  signin?: string | null;
  /** the agents its Host installs itself, so Switch host can offer the install */
  installable?: string[];
  /** what each agent on it is called, so a reason that names one reads by that name, and what it is ready for when the registry said */
  agents?: (NoteAgent & { state?: MachineAgent['state']; reason?: string })[];
  /** a cloud machine's provider record (host.cloud) */
  cloud?: { provider: string };
};

/** The row's second line, only when it matters: Offline, what needs doing (Codex needs sign-in), else the one thing an online machine can't do (No computer use); empty when everything works. */
export const machineNote = (m: HostMachine): string => {
  if (m.status === 'offline') return 'Offline';
  if (m.status === 'attention') return machineReason(m.note, m.agents) || 'Needs attention';
  return m.capabilities ? capabilityNote(m.capabilities) : '';
};

/** This Mac can do everything; the registry adds the user's other machines after it. */
const THIS_MAC: HostMachine = { id: 'local', name: 'This Mac', status: 'online', note: '' };

const STATUS_LABEL: Record<HostStatus, string> = { online: 'Online', offline: 'Offline', attention: 'Needs attention' };

function Dot({ status }: { status: HostStatus }) {
  return <span className={`host-dot ${status}`} role="img" aria-label={STATUS_LABEL[status]} />;
}

/** A cut name narrower than this many ems shows at most a letter and its "…". */
const SLIVER_EM = 2.5;

/**
 * The composer cuts the machine's name before any other chip's label (composer-controls.css), so the name can be left
 * a sliver: a stray letter or a bare "…". Such a name is marked to be hidden, which keeps its box, so hiding it never
 * moves another chip nor changes what is measured. A new `name` is a new ref, so a renamed machine measures again.
 */
function useSliver(name: string): [(el: HTMLElement | null) => void, boolean] {
  const [sliver, setSliver] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the name's text is what a new ref measures
  const ref = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el) return;
      const measure = () =>
        setSliver(el.scrollWidth > el.clientWidth && el.clientWidth < Number.parseFloat(getComputedStyle(el).fontSize) * SLIVER_EM);
      measure();
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    },
    [name],
  );
  return [ref, sliver];
}

/**
 * The chat's host. A new chat (no `chatId`) picks its machine here: a row is the next chat's machine, and one picked
 * reachable with no folder used there yet opens its folder picker. A chat that has started never re-picks it: another
 * machine's row opens the dialog that continues the chat there with that machine picked (when switching is off right now,
 * the click says why on the row), its own row and a machine that can't take it are inert, and Switch host… opens the
 * dialog with nothing picked.
 * `ownerId` is the chat's host, or the machine picked for the new chat (absent: this Mac). A machine that left the
 * list is still the owner, shown offline, never swapped for another one under the user.
 */
export function HostChip({
  machines,
  ownerId = 'local',
  turnRunning = false,
  queued = false,
  chatId = null,
  ownerKnown = true,
  agent,
  project = '',
  onContinue,
  onPlan,
  onAddMachine,
  onPick,
  onFolder,
  look = 'chip',
  elsewhere = null,
  extra,
}: {
  /** the machines to show; absent: this Mac, then the registry's */
  machines?: HostMachine[];
  ownerId?: string;
  turnRunning?: boolean;
  /** a message is on its way to the chat's host, or waits behind a turn */
  queued?: boolean;
  /** the chat (absent: a new chat, which picks its machine here and has nothing to continue) and its project folder */
  chatId?: string | null;
  project?: string;
  /** main has said which host holds the chat; until then Switch host… waits */
  ownerKnown?: boolean;
  /** the agent the chat runs on (its id): a machine that cannot take it is not offered, and its row says why */
  agent?: string;
  /** what carrying the chat's uncommitted changes would send, asked before the continue */
  onPlan?: (req: { chatId: string; targetHostId: string; cwd: string }) => Promise<{ plan: CarryPlan | null } | null>;
  /** continues the chat on another machine (main); a refusal rejects with its `code` */
  onContinue?: (req: ContinueRequest) => Promise<unknown>;
  /** open where a machine is added instead of the add sheet in place */
  onAddMachine?: () => void;
  /** a new chat's machine picked (store/projects.ts pickNewChatHost): the pick with its folder ('' none yet), null for this Mac */
  onPick?: (m: HostMachine) => { path: string } | null;
  /** the folder picked on that machine for the new chat */
  onFolder?: (m: HostMachine, path: string) => void;
  /** 'ctx': drawn as a context-bar chip that always names where the chat runs; 'chip': the composer's compact host chip */
  look?: 'chip' | 'ctx';
  /** the new chat runs off every machine (a Codex Cloud environment): the chip names it and no machine row is checked */
  elsewhere?: { label: string; icon: ReactNode } | null;
  /** one more group of rows after the machines (Codex Cloud's environments), given how to close the menu */
  extra?: (close: () => void) => ReactNode;
}) {
  const allowed = useHostAccess();
  // `host.unattended`: the menu is "Run on" in groups, This Mac then My machines (Cloud and the background Host join when their lanes land)
  const grouped = useFlag('host.unattended');
  const live = useHostMachines();
  const a = useAnchor();
  // the chat the dialog is open for: a different chat closes it
  const [switchingFor, setSwitchingFor] = useState<{ chatId: string | null; target: string | null } | null>(null);
  // the started chat's row clicked while switching is off: it says why in place of its second line
  const [said, setSaid] = useState<string | null>(null);
  // the machine whose folder picker is open for the new chat
  const [browsing, setBrowsing] = useState<HostMachine | null>(null);
  const [newCloud, setNewCloud] = useState(false);
  // the add sheet stays mounted once opened, so an install under way keeps its progress and ssh's questions while it is closed
  const [adding, setAdding] = useState<boolean | null>(null);
  // stable: the sheet reopens itself through onOpen on every render while ssh asks a question, so a new function each render would undo Close
  const openSheet = useCallback(() => setAdding(true), []);
  const closeSheet = useCallback(() => setAdding(false), []);
  const shown = machines ?? [THIS_MAC, ...live.machines];
  // host.cloud: the cloud machines are their own group, each with its line from main
  const cloudIn = cloudOn();
  const cloudRows = cloudIn ? shown.filter((m) => m.cloud) : [];
  const lines = useCloudLines(cloudRows.map((m) => m.id));
  // until every machine has answered once the list says so, rather than showing a grey dot that may turn green
  const resolving = machines === undefined && !live.resolved;
  const owner = shown.find((m) => m.id === ownerId);
  const current =
    owner ??
    (ownerId === 'local' || shown.length === 0
      ? THIS_MAC
      : { id: ownerId, name: ownerId, status: 'offline' as const, note: 'Not in your machines' });
  // a chat whose host cannot be reached may be continued elsewhere without it
  const lost = current.status === 'offline' && current.id !== 'local' && (owner === undefined || !resolving);
  const targets = targetsFor(shown, current.id, lost, agent);
  const reason = switchHostReason({ turnRunning, queued, hasChat: !!chatId && !!onContinue, ownerKnown, targets: targets.length });
  const name = elsewhere?.label ?? current.name;
  const [nameRef, sliver] = useSliver(name);
  // closed alpha: nothing of Host renders unless the account was invited (electron/host/access.cjs)
  if (!allowed) return null;
  // the first machine that is not this Mac opens the My machines group
  const mine = [...(owner ? [] : [current]), ...shown].filter((m) => !cloudRows.includes(m));
  /** A new chat's machine picked: one with no folder used there yet opens its folder picker. */
  const pickMachine = (m: HostMachine) => {
    const pick = onPick?.(m);
    if (pick && !pick.path && m.status !== 'offline') setBrowsing(m);
  };
  // nothing is checked while the chat runs off every machine
  const checked = (m: HostMachine) => !elsewhere && m.id === current.id;
  const row = (m: HostMachine, groupHead = false) => {
    // a started chat: only a machine that can take it is a row to click, and the click says why when switching is off
    const target = chatId ? targets.find((t) => t.id === m.id && !t.reason) : undefined;
    const why = target ? reason : null;
    // a cloud machine in one of the cloud states says that line and takes its dot
    const cloud = lines.get(m.id);
    const state = cloud?.line ? cloud : null;
    const dot: HostStatus = state ? (state.dot === 'warn' ? 'attention' : 'offline') : m.status;
    // an online cloud machine says how long it may idle after its ordinary line
    const note = why && said === m.id ? why : (state?.line ?? [machineNote(m), cloud?.idle].filter(Boolean).join(' · '));
    return (
      <Fragment key={m.id}>
        {groupHead && (
          <div className="menu-section-label" role="presentation">
            My machines
          </div>
        )}
        <MenuRow
          className={`${note ? 'has-desc ' : ''}perm-item`}
          role="menuitemradio"
          aria-checked={checked(m)}
          disabled={!!chatId && !target}
          title={why ?? (m.status === 'online' ? undefined : machineReasonTitle(m.note, m.agents))}
          onClick={() => {
            if (why) return setSaid(m.id);
            a.close();
            if (target) return setSwitchingFor({ chatId, target: m.id });
            pickMachine(m);
          }}
        >
          <span className="menu-icon">
            <Dot status={dot} />
          </span>
          <span className="menu-label">
            <span className="menu-title">{m.name}</span>
            {note && <span className="menu-desc">{note}</span>}
          </span>
          <span className="menu-check">{checked(m) ? <Check size={16} strokeWidth={2} /> : null}</span>
        </MenuRow>
      </Fragment>
    );
  };
  return (
    <>
      <Tooltip label={look === 'ctx' ? 'Run on' : 'Host'}>
        <button
          ref={a.ref}
          className={look === 'ctx' ? `ctx-btn host-ctx ${a.open ? 'active' : ''}` : `host-chip ${a.open ? 'active' : ''}`}
          onClick={() => {
            setSaid(null);
            a.toggle();
          }}
          aria-label={
            elsewhere
              ? `Run on: ${elsewhere.label}`
              : `${look === 'ctx' ? 'Run on' : 'Host'}: ${current.name}, ${STATUS_LABEL[current.status].toLowerCase()}`
          }
        >
          {elsewhere ? (
            elsewhere.icon
          ) : (
            <>
              <Dot status={current.status} />
              <Laptop size={15} strokeWidth={look === 'ctx' ? 1.7 : 1.8} aria-hidden="true" />
            </>
          )}
          {(look === 'ctx' || shown.length > 1) && (
            <span ref={nameRef} className="host-name" data-sliver={sliver ? '' : undefined}>
              {name}
            </span>
          )}
        </button>
      </Tooltip>
      <Popover anchor={a.anchor} open={a.open} onClose={a.close} placement="top-start">
        <div className="menu perm-menu host-menu" style={{ width: 264 }}>
          <div className="perm-menu-head">
            <span>{grouped ? 'Run on' : 'My machines'}</span>
          </div>
          <MenuList className="perm-list" label="My machines">
            {mine.map((m, i) => row(m, grouped && m.id !== 'local' && mine.findIndex((x) => x.id !== 'local') === i))}
            {cloudIn && (
              <>
                <div className="menu-section-label" role="presentation">
                  Cloud
                </div>
                {cloudRows.map((m) => row(m))}
                <MenuRow
                  className="perm-item"
                  onClick={() => {
                    a.close();
                    setNewCloud(true);
                  }}
                >
                  <span className="menu-icon">
                    <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  <span className="menu-label">
                    <span className="menu-title">New cloud machine…</span>
                  </span>
                </MenuRow>
              </>
            )}
            {extra?.(a.close)}
            {resolving && (
              <MenuRow className="perm-item" disabled aria-busy="true">
                <span className="menu-icon" />
                <span className="menu-label">
                  <span className="menu-title">Checking machines…</span>
                </span>
              </MenuRow>
            )}
            <div className="menu-sep" role="separator" />
            <MenuRow
              className="perm-item"
              onClick={() => {
                a.close();
                if (onAddMachine) onAddMachine();
                else setAdding(true);
              }}
            >
              <span className="menu-icon">
                <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className="menu-label">
                <span className="menu-title">Add machine…</span>
              </span>
            </MenuRow>
            <MenuRow
              className="perm-item"
              disabled={!!reason}
              title={reason ?? undefined}
              onClick={() => {
                a.close();
                setSwitchingFor({ chatId, target: null });
              }}
            >
              <span className="menu-icon">
                <ArrowLeftRight size={16} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className="menu-label">
                <span className="menu-title">Switch host…</span>
                {reason && <span className="menu-desc">{reason}</span>}
              </span>
            </MenuRow>
          </MenuList>
        </div>
      </Popover>
      {newCloud && (
        <Suspense fallback={null}>
          <NewCloudMachineSheet onClose={() => setNewCloud(false)} />
        </Suspense>
      )}
      {adding !== null && (
        <Suspense fallback={null}>
          <AddMachineSheet
            open={adding}
            onOpen={openSheet}
            onClose={closeSheet}
            onCloud={cloudIn ? () => (setAdding(false), setNewCloud(true)) : undefined}
            // a new chat runs on the machine just added, in a folder picked there; a started chat leaves for a new one (the sheet's own Start a chat)
            onStartChat={
              chatId ? undefined : (m) => (setAdding(false), pickMachine({ id: m.id, name: m.name, status: 'online', note: '' }))
            }
          />
        </Suspense>
      )}
      {browsing && (
        <HostFolderPicker
          hostId={browsing.id}
          name={browsing.name}
          onClose={() => setBrowsing(null)}
          onPick={(path) => {
            onFolder?.(browsing, path);
            setBrowsing(null);
          }}
        />
      )}
      {chatId && switchingFor?.chatId === chatId && onContinue && (
        <SwitchHostDialog
          chatId={chatId}
          project={project}
          ownerId={current.id}
          ownerLost={lost}
          machines={shown}
          initialTarget={switchingFor.target}
          turnRunning={turnRunning}
          queued={queued}
          agent={agent}
          onContinue={onContinue}
          onPlan={onPlan}
          onClose={() => setSwitchingFor(null)}
        />
      )}
    </>
  );
}
