// The support pages wired to the phone's data: the machine page for a Host, the troubleshoot run and the connection log; the old screens' hooks and rules stay underneath.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { MobileRuntime, MobileSnapshot } from '../../contracts';
import { DIRECT_ACTIONS, setupLine } from '../../../../shared/host/directWords.mjs';
import { MachineApprovals } from '../../components/MachineApprovals';
import { SheetFrame } from '../../components/SheetFrame';
import { useMacLink } from '../../macLink';
import { canSetUpDirect, reachLabel } from '../../remote/reach';
import { agentLine, type Machine } from '../../remote/machines';
import { useDirect, useDirectWatch } from '../../remote/useDirect';
import type { ChatListItem } from '../../components/ChatRow';
import { chatsOn, MachineChats } from '../../components/MachineChats';
import { useHardwareBack } from '../../useHardwareBack';
import { t, useLanguage } from './adapters';
import { connectionLog, type ConnectionLogStore } from './connectionLog';
import { ConnectionLogView } from './ConnectionLogView';
import { MachineView, type MachineViewModel } from './MachineView';
import { checksReport, machineNotice, runChecks, toLineMachine, type Check, type Diagnosis, type SupportInput } from './supportModel';
import { TroubleshootView } from './Troubleshoot';

/** The machine page for one Host, as MachineView draws it; the direct-access hooks are the old page's. */
export function MachineScreen({
  machine,
  back,
  runtime,
  chats,
  newChat,
}: {
  machine: Machine;
  back: () => void;
  runtime?: MobileRuntime;
  chats?: { list: ChatListItem[] | null; open: (chatId: string) => void };
  /** Opens New chat on this machine; offered only while the phone follows machine chats itself. */
  newChat?: () => void;
}) {
  useHardwareBack(back);
  const mac = useMacLink();
  const direct = useDirect(runtime);
  useDirectWatch(runtime);
  const enrolled = direct?.enrolled(machine.id) ?? false;
  const setup = direct?.setup(machine.id) ?? 'idle';
  const reach = machine.reach ?? 'none';
  const latest = useRef(direct);
  latest.current = direct;
  useEffect(() => {
    if (enrolled) void latest.current?.refresh(machine.id);
  }, [enrolled, machine.id]);
  const presence = (mac.pairId && runtime?.snapshot?.().presence[mac.pairId]?.state) || null;
  const vm: MachineViewModel = {
    name: machine.name,
    line: machine.line,
    tone: machine.tone,
    reach: reachLabel(reach, mac.name),
    keepRunning: machine.keepRunning,
    notice: machineNotice(
      {
        name: machine.name,
        state: 'connected',
        reach,
        waiting: machine.waiting ?? 0,
      },
      presence,
    ),
    waiting: machine.waiting ?? 0,
    newChat: newChat && machine.agents.some((a) => a.state === 'ready') ? newChat : null,
    agents: machine.agents.map((a) => ({
      id: a.id,
      label: a.label,
      line: agentLine(a),
    })),
    setup: {
      line: !enrolled && setup !== 'idle' ? setupLine(setup, machine.name) : null,
      action:
        direct && !enrolled && canSetUpDirect({ reach, setup })
          ? {
              title: setup === 'failed' ? DIRECT_ACTIONS.retry : DIRECT_ACTIONS.start,
              onPress: () => void direct.setUp(machine.id),
            }
          : null,
    },
  };
  return (
    <SheetFrame title={machine.name} onClose={back} back>
      <MachineView vm={vm}>
        {direct && enrolled ? (
          <MachineApprovals
            cards={direct.cards(machine.id)}
            machine={machine.name}
            answer={(cardId, optionId) => void direct.answer(machine.id, machine.name, cardId, optionId)}
          />
        ) : null}
        {enrolled && chats && runtime?.direct?.chat?.enabled() === true ? (
          <MachineChats chats={chatsOn(chats.list, machine.id)} open={chats.open} />
        ) : null}
      </MachineView>
    </SheetFrame>
  );
}

/** What the phone knows for the checklist, from the runtime's snapshot and its network. */
export function supportInput(state: MobileSnapshot, online: boolean, machine?: Machine): SupportInput {
  const pair = state.pairs.find((p) => p.pairId === (state.selectedPair ?? state.pairs[0]?.pairId));
  return {
    online,
    signedIn: !!state.user,
    relay: state.phase === 'error' ? 'down' : state.phase === 'online' || (pair && state.presence[pair.pairId]) ? 'ok' : 'unknown',
    mac: {
      name: pair?.name?.trim() || 'your Mac',
      paired: !!pair,
      presence: (pair && state.presence[pair.pairId]?.state) || null,
    },
    host: machine ? toLineMachine(machine) : null,
    hostName: machine?.name,
  };
}

const useLines = (log: ConnectionLogStore) => useSyncExternalStore(log.subscribe, log.lines);

/** Troubleshoot: the steps show one after another, the failing one named, and each run writes one line to the log. */
export function TroubleshootScreen({
  read,
  back,
  openLog,
  log = connectionLog,
  now = Date.now,
  stepMs = 250,
}: {
  read: () => SupportInput;
  back: () => void;
  openLog: () => void;
  log?: ConnectionLogStore;
  now?: () => number;
  stepMs?: number;
}) {
  useHardwareBack(back);
  useLanguage();
  const [shown, setShown] = useState<{
    checks: Check[];
    diagnosis: Diagnosis | null;
    running: boolean;
  }>({ checks: [], diagnosis: null, running: false });
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const { checks, diagnosis } = runChecks(read(), now());
    const step = (n: number) => {
      const done = n >= checks.length;
      setShown({
        checks: checks.slice(0, n),
        diagnosis: done ? diagnosis : null,
        running: !done,
      });
      if (done) log.add(diagnosis.kind === 'ok' ? 'ok' : 'bad', t('log.check', { text: diagnosis.title }));
      else timer.current = setTimeout(() => step(n + 1), stepMs);
    };
    step(1);
  }, [read, now, log, stepMs]);
  useEffect(() => {
    run();
    return () => void (timer.current && clearTimeout(timer.current));
  }, [run]);
  return (
    <SheetFrame title={t('troubleshoot.title')} onClose={back} back>
      <TroubleshootView
        checks={shown.checks}
        diagnosis={shown.diagnosis}
        running={shown.running}
        copied={copied}
        onRun={run}
        onOpenLog={openLog}
        onCopy={() => {
          void Clipboard.setStringAsync(checksReport(shown.checks)).then(() => setCopied(true));
        }}
      />
    </SheetFrame>
  );
}

/** The connection log page. */
export function ConnectionLogScreen({ back, log = connectionLog }: { back: () => void; log?: ConnectionLogStore }) {
  useHardwareBack(back);
  useLanguage();
  const lines = useLines(log);
  const [copied, setCopied] = useState(false);
  return (
    <SheetFrame title={t('log.title')} onClose={back} back>
      <ScrollView>
        <ConnectionLogView
          lines={lines}
          copied={copied}
          onCopy={() => void Clipboard.setStringAsync(log.report()).then(() => setCopied(true))}
        />
      </ScrollView>
    </SheetFrame>
  );
}
