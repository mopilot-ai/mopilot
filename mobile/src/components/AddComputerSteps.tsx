// Add a computer, as Claude for iOS draws it: a laptop, the title and where to do it, a Mac | Host switch, the numbered steps in a card, and one button at the bottom. On the Mac tab the button opens the camera; on the Host tab it waits for the Mac to list the new machine.
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useMacLink, useMachines } from '../macLink';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { Segmented } from './Segmented';
import { Swap } from './Swap';
import { typo } from '../typography';

const MAC_STEPS = (account: string | null | undefined) => [
  account ? `Open MoPilot on your Mac, signed in as ${account}.` : 'Open MoPilot on your Mac, signed in with this account.',
  'Click Connect your phone in the sidebar, or open Settings › Connections › Control this Mac and click Add.',
  'Scan the code it shows.',
];
const HOST_STEPS = [
  'On your Mac, open Settings › Connections › Control other devices.',
  'Click Add a machine, and follow the steps there.',
  'Allow the new machine on your Mac.',
];

/** The steps in a white card with hairlines between them, as Claude's. */
function StepsCard({ steps }: { steps: string[] }) {
  const theme = useTheme();
  return (
    <View style={{ borderRadius: 22, backgroundColor: theme.surface, overflow: 'hidden' }}>
      {steps.map((step, i) => (
        <View
          key={step}
          style={{
            flexDirection: 'row',
            gap: 16,
            paddingHorizontal: 18,
            paddingVertical: 15,
            borderTopWidth: i ? 1 : 0,
            borderTopColor: theme.line,
            marginLeft: i ? 18 : 0,
            paddingLeft: i ? 0 : 18,
          }}
        >
          <Text style={{ ...typo.body, color: theme.ink2, minWidth: 14 }}>{i + 1}</Text>
          <Text style={{ flex: 1, ...typo.body, color: theme.ink }}>{step}</Text>
        </View>
      ))}
    </View>
  );
}

/** The black capsule at the bottom, as Claude's Look for my computer. */
function Primary({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 56,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.btn,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ ...typo.bodySemibold, color: theme.btnInk }}>{title}</Text>
    </Tap>
  );
}

/**
 * Waits for the Mac to list a machine it did not list when the person tapped: the list is pushed (machines.changed), never polled.
 * The snapshot is taken at the tap, and a Mac that lists no Host yet (null) counts as none, so the first Host is found too.
 */
function useNewMachine() {
  const machines = useMachines();
  const [known, setKnown] = useState<Set<string> | null>(null);
  const look = () => setKnown(new Set((machines ?? []).map((m) => m.id)));
  const found = (known && machines?.find((m) => m.id !== 'local' && !known.has(m.id))) || null;
  return { looking: known !== null, look, found };
}

export function AddComputerSteps({
  account,
  host,
  lookForMac,
  done,
}: {
  account?: string | null;
  /** The account can run chats on its own machines: the Host tab is offered. */
  host: boolean;
  /** The Mac tab's button: the camera opens, to scan the Mac's code. */
  lookForMac: () => void;
  done: () => void;
}) {
  const theme = useTheme();
  const [tab, setTab] = useState<'mac' | 'host'>('mac');
  const { looking, look, found } = useNewMachine();
  // a reconnect reads the list again: started while away, an old machine would read as new
  const { online } = useMacLink();
  const onHost = host && tab === 'host';
  return (
    <View style={{ flex: 1, gap: 22 }}>
      <View style={{ alignItems: 'center', gap: 6, paddingTop: 12 }}>
        <Icon name="laptopcomputer" glyph="▭" size={44} color={theme.ink} />
        <Text accessibilityRole="header" style={{ ...typo.title3Semibold, color: theme.ink, marginTop: 10 }}>
          Add a computer
        </Text>
        <Text style={{ ...typo.subhead, color: theme.ink2, textAlign: 'center' }}>Do this at the computer you want to add.</Text>
      </View>
      {host && (
        <Segmented
          selected={tab}
          items={[
            { key: 'mac', label: 'Mac', onPress: () => setTab('mac') },
            { key: 'host', label: 'Host', name: 'Host, a machine your Mac runs chats on', onPress: () => setTab('host') },
          ]}
        />
      )}
      <Swap id={onHost ? 'host' : 'mac'}>
        <StepsCard steps={onHost ? HOST_STEPS : MAC_STEPS(account)} />
      </Swap>
      <View style={{ flex: 1 }} />
      {onHost && looking && (
        <Text accessibilityLiveRegion="polite" style={{ ...typo.subhead, color: theme.ink2, textAlign: 'center' }}>
          {found ? `${found.name} is ready.` : 'Waiting for you to allow it on your Mac…'}
        </Text>
      )}
      {onHost ? (
        found ? (
          <Primary title="Done" onPress={done} />
        ) : (
          <Primary title="Look for my machine" disabled={looking || !online} onPress={look} />
        )
      ) : (
        <Primary title="Look for my computer" onPress={lookForMac} />
      )}
    </View>
  );
}
