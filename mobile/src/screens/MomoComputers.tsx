// MoMo's page, Computers (P7): this Mac and the machines it runs chats on, in the words Settings › Computers gives them, with the cards waiting on each, Check again and Add a computer.
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import type { MobileRuntime } from '../contracts';
import { explain } from '../remote/client';
import type { Machine } from '../remote/machines';
import { useTheme } from '../theme';
import { MachineGlyph } from './SettingsMachine';

/** "Checked at 3:05 PM": when the phone last read its machines, in the phone's own clock and locale. */
export const checkedWord = (at: number) => `Checked at ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

/** Check again: the phone reads its own paths to the Hosts now (a phone with none has nothing to read, and the check still finishes). */
export const recheck = (runtime: MobileRuntime) => (runtime.direct ? runtime.direct.probe() : Promise.resolve());

/** A machine row's second line: the machine's own words, and that it keeps running while the Mac is away when the Mac says so. */
export const computerLine = (m: Machine) =>
  [m.line, m.id !== 'local' && m.keepRunning === true ? 'Keeps running while your Mac is away' : null].filter(Boolean).join(' · ');

export function MomoComputers({
  machines,
  open,
  pair,
  check,
  now = Date.now,
}: {
  machines: Machine[];
  /** a machine's page (Settings), where its chats, agents and cards are */
  open: (machineId: string) => void;
  /** the existing pairing and Host flow */
  pair: () => void;
  /** reads the machines again over the phone's own paths */
  check: () => Promise<unknown>;
  now?: () => number;
}) {
  const theme = useTheme();
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function again() {
    setChecking(true);
    setError(null);
    try {
      await check();
      setCheckedAt(now());
    } catch (e) {
      setError(explain(e));
    } finally {
      setChecking(false);
    }
  }
  return (
    <>
      <GroupLabel>Computers</GroupLabel>
      <Group>
        {machines.map((m) => (
          <GroupItem
            key={m.id}
            title={m.name}
            icon={<MachineGlyph tone={m.tone} />}
            detail={computerLine(m)}
            value={m.waiting ? `${m.waiting} ${m.waiting === 1 ? 'needs' : 'need'} input` : undefined}
            // this Mac has no page of its own here: its state is the line
            end={m.id === 'local' ? 'none' : 'chevron'}
            onPress={m.id === 'local' ? undefined : () => open(m.id)}
          />
        ))}
        <GroupItem
          key="check"
          title={checking ? 'Checking…' : 'Check again'}
          detail={error ?? (checkedAt ? checkedWord(checkedAt) : undefined)}
          tone="link"
          onPress={checking ? undefined : () => void again()}
        />
        <GroupItem
          key="add"
          title="Add a computer"
          tone="link"
          icon={<Icon name="plus" glyph="+" size={18} color={theme.accent} />}
          onPress={pair}
        />
      </Group>
    </>
  );
}
