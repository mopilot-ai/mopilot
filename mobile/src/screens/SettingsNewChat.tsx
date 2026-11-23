// Settings › a machine › New chat (#4603): a chat started on a machine the phone reaches itself, with the Mac away: an agent its Host says is ready, an optional folder, and the first message.
import { useState } from 'react';
import { View } from 'react-native';
import type { MobileRuntime } from '../contracts';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { SheetFrame } from '../components/SheetFrame';
import { Button, Field } from '../components/ui';
import { useMacLink } from '../macLink';
import { lastFolder, rememberFolder } from '../remote/lastFolders';
import { agentLine, type Machine } from '../remote/machines';
import { useHardwareBack } from '../useHardwareBack';

export function SettingsNewChat({
  machine,
  runtime,
  back,
  opened,
}: {
  machine: Machine;
  runtime: MobileRuntime;
  back: () => void;
  /** The chat started: the page closes and the chat opens. */
  opened: (chatId: string) => void;
}) {
  useHardwareBack(back);
  const { pairId } = useMacLink();
  const [harness, setHarness] = useState<string | null>(machine.agents.find((a) => a.state === 'ready')?.id ?? null);
  const [folder, setFolder] = useState(lastFolder(pairId, machine.id) ?? '');
  const [text, setText] = useState('');
  const ready = harness !== null && text.trim() !== '';
  // the chat opens at once with its first message sending: the machine's answer (or its refusal, with Retry) is shown in the chat
  const start = () => {
    const kit = runtime.direct?.chat;
    if (!kit || !harness) return;
    const chatId = kit.launch(machine.id, kit.begin(harness), { text: text.trim(), cwd: folder.trim() });
    if (folder.trim()) rememberFolder(pairId, machine.id, folder.trim());
    opened(chatId);
  };
  return (
    <SheetFrame title="New chat" onClose={back} back>
      <GroupLabel>{`Agent on ${machine.name}`}</GroupLabel>
      <Group>
        {machine.agents.map((agent) => (
          <GroupItem
            key={agent.id}
            title={agent.label}
            detail={agent.state === 'ready' ? undefined : agentLine(agent)}
            end={harness === agent.id ? 'check' : 'none'}
            onPress={agent.state === 'ready' ? () => setHarness(agent.id) : undefined}
          />
        ))}
      </Group>
      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        <Field
          placeholder={`Folder on ${machine.name} (optional)`}
          value={folder}
          onChangeText={setFolder}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field placeholder="What should it do?" value={text} onChangeText={setText} multiline />
        <Button title="Start" onPress={start} disabled={!ready} />
      </View>
    </SheetFrame>
  );
}
