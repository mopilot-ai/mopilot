// Settings › Computers › a Host the Mac runs chats on: its state in the Mac's own words, its agents and where each one's sign-in lives; the phone only reads.
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { MobileRuntime } from '../contracts';
import { DIRECT_ACTIONS, downLine, removeLine, setupLine } from '../../../shared/host/directWords.mjs';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { Icon } from '../components/Icon';
import { MachineApprovals } from '../components/MachineApprovals';
import { chatsOn, MachineChats } from '../components/MachineChats';
import type { ChatListItem } from '../components/ChatRow';
import { SheetFrame } from '../components/SheetFrame';
import { useMacLink } from '../macLink';
import { canSetUpDirect, reachLabel } from '../remote/reach';
import { useDirect, useDirectWatch } from '../remote/useDirect';
import { agentLine, type Machine, type MachineTone } from '../remote/machines';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';
import { typo } from '../typography';
import { supportV2 } from '../ui/support/adapters';
import { MachineScreen } from '../ui/support/screens';

/** The colour of a machine's state, from the Mac's tone: green when it is fine, amber when it needs something, gray when it is away. */
export function useToneColor() {
  const theme = useTheme();
  return (tone: MachineTone) => (tone === 'ok' ? theme.ok : tone === 'warn' ? theme.warn : theme.ink3);
}

/** A Host's glyph with its tone dot, as a Mac's laptop carries its own. */
export function MachineGlyph({ tone }: { tone: MachineTone }) {
  const theme = useTheme();
  const color = useToneColor();
  return (
    <View>
      <Icon name="server.rack" glyph="▤" size={18} color={tone === 'off' ? theme.ink3 : theme.ink} />
      <View
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{ position: 'absolute', right: -3, bottom: -2, width: 8, aspectRatio: 1, borderRadius: 4, backgroundColor: color(tone) }}
      />
    </View>
  );
}

/** A machine's agents, each with where its sign-in lives; nothing here signs in, a sign-in that is missing points at the Mac. */
export function AgentsGroup({ machine }: { machine: Machine }) {
  if (!machine.agents.length) return null;
  return (
    <>
      <GroupLabel>Agents</GroupLabel>
      <Group>
        {machine.agents.map((agent) => (
          <GroupItem key={agent.id} title={agent.label} detail={agentLine(agent, machine.name)} />
        ))}
      </Group>
    </>
  );
}

type MachineProps = {
  machine: Machine;
  back: () => void;
  runtime?: MobileRuntime;
  /** The Mac's chat list and how a chat opens (the page closes first); the page lists this machine's chats while the phone follows them itself. */
  chats?: { list: ChatListItem[] | null; open: (chatId: string) => void };
  /** Opens New chat on this machine; offered only while the phone follows machine chats itself. */
  newChat?: () => void;
};

/** The new machine page behind the phone v2 flag, else the page below. */
export const SettingsMachine = (props: MachineProps) => (supportV2() ? <MachineScreen {...props} /> : <ClassicMachine {...props} />);

function ClassicMachine({ machine, back, runtime, chats, newChat }: MachineProps) {
  useHardwareBack(back);
  const theme = useTheme();
  const color = useToneColor();
  const mac = useMacLink();
  const direct = useDirect(runtime);
  // the page keeps the cards current: one another client answered turns to its receipt, not a button that does nothing
  useDirectWatch(runtime);
  const enrolled = direct?.enrolled(machine.id) ?? false;
  const setup = direct?.setup(machine.id) ?? 'idle';
  const reach = machine.reach ?? 'none';
  // its own path: the Host's waiting cards are read whenever the page opens, with the Mac asleep or not (the view changes with every read, so the read keys on the machine only)
  const latest = useRef(direct);
  latest.current = direct;
  useEffect(() => {
    if (enrolled) void latest.current?.refresh(machine.id);
  }, [enrolled, machine.id]);
  const down = machine.directDown === true && enrolled;
  const word = reachLabel(reach, mac.name, down);
  const [confirming, setConfirming] = useState(false);
  // the Mac listing the machine as up is what makes a repair possible: it introduces the phone to the Host again
  const macUp = mac.online && machine.status === 'online';
  return (
    <SheetFrame title={machine.name} onClose={back} back>
      <Group>
        <GroupItem
          title="Status"
          trailing={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
              <View style={{ width: 8, aspectRatio: 1, borderRadius: 4, backgroundColor: color(machine.tone) }} />
              <Text numberOfLines={2} style={{ ...typo.callout, color: theme.ink2, flexShrink: 1 }}>
                {machine.line}
              </Text>
            </View>
          }
        />
        {word !== null && <GroupItem key="reach" title="Reach" value={word} detail={down ? downLine(machine.name, macUp) : undefined} />}
        {machine.keepRunning !== null && <GroupItem key="keep" title="Keep running" value={machine.keepRunning ? 'On' : 'Off'} />}
      </Group>
      {direct && enrolled && (
        <MachineApprovals
          cards={direct.cards(machine.id)}
          machine={machine.name}
          answer={(cardId, optionId) => void direct.answer(machine.id, machine.name, cardId, optionId)}
        />
      )}
      {enrolled && chats && runtime?.direct?.chat?.enabled() === true && (
        <>
          {newChat && machine.agents.some((a) => a.state === 'ready') && (
            <Group>
              <GroupItem title="New chat" tone="link" onPress={newChat} />
            </Group>
          )}
          <MachineChats chats={chatsOn(chats.list, machine.id, runtime.direct.chat.startedOn(machine.id))} open={chats.open} />
        </>
      )}
      {direct && !enrolled && (canSetUpDirect({ reach, setup }) || setup !== 'idle') && (
        <Group>
          {setup !== 'idle' && <GroupItem key="setup" title={setupLine(setup, machine.name)} />}
          {canSetUpDirect({ reach, setup }) && (
            <GroupItem
              key="start"
              title={setup === 'failed' ? DIRECT_ACTIONS.retry : DIRECT_ACTIONS.start}
              tone="link"
              onPress={() => void direct.setUp(machine.id)}
            />
          )}
        </Group>
      )}
      {direct && enrolled && (down || setup !== 'idle') && (
        <Group>
          {setup !== 'idle' && <GroupItem key="repair-state" title={setupLine(setup, machine.name)} />}
          {down && macUp && setup !== 'working' && (
            <GroupItem key="repair" title={DIRECT_ACTIONS.repair} tone="link" onPress={() => void direct.setUp(machine.id)} />
          )}
        </Group>
      )}
      <AgentsGroup machine={machine} />
      {direct && enrolled && (
        <>
          {confirming && (
            <Text style={{ ...typo.subhead, color: theme.ink2, paddingHorizontal: 16, paddingBottom: 8 }}>{removeLine(machine.name)}</Text>
          )}
          <Group>
            {confirming ? (
              [
                <GroupItem
                  key="confirm"
                  title={DIRECT_ACTIONS.confirmRemove}
                  tone="danger"
                  onPress={() => {
                    setConfirming(false);
                    void direct.remove(machine.id).then(back, back);
                  }}
                />,
                <GroupItem key="keep" title={DIRECT_ACTIONS.keep} onPress={() => setConfirming(false)} />,
              ]
            ) : (
              <GroupItem key="remove" title={DIRECT_ACTIONS.remove} tone="danger" onPress={() => setConfirming(true)} />
            )}
          </Group>
        </>
      )}
      <Text style={{ ...typo.footnote, color: theme.ink2, paddingHorizontal: 16 }}>Change this machine on your Mac.</Text>
    </SheetFrame>
  );
}
