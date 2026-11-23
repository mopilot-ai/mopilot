// A card per computer at the bottom of the home, as Claude for iOS's Sessions ends: the Mac and each Host the Mac reports, with its name, the Mac's own line for it, and "N need input" counted from the chats on it; a card opens the computers in Settings.
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useMacLink } from '../macLink';
import { attentionReason, type Machine } from '../remote/machines';
import { reachLabel } from '../remote/reach';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { typo } from '../typography';
import { useLargeText } from '../useLargeText';

type CountedChat = { state?: string; hostId?: string };

/** Chats waiting for the person on each computer (a chat with no host runs on the Mac, id "local"). */
export function needInput(chats: CountedChat[] | null, offline: boolean): Map<string, number> {
  const counts = new Map<string, number>();
  if (offline) return counts;
  for (const chat of chats ?? [])
    if (chat.state === 'waiting') counts.set(chat.hostId ?? 'local', (counts.get(chat.hostId ?? 'local') ?? 0) + 1);
  return counts;
}

function Card({ name, line, count, onPress }: { name: string; line: string; count: number; onPress?: () => void }) {
  const theme = useTheme();
  const waiting = count ? `${count} need input` : null;
  // at a large text size the count would take the whole row and leave the name no width: the words wrap, and the count goes under them
  const large = useLargeText();
  const lines = large ? undefined : 1;
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={[name, line, waiting].filter(Boolean).join(', ')}
      accessibilityHint="Opens your computers in Settings"
      disabled={!onPress}
      onPress={onPress}
      style={{
        minHeight: 64,
        borderRadius: 22,
        paddingHorizontal: 18,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        backgroundColor: theme.surface,
      }}
    >
      <Icon name="laptopcomputer" glyph="▭" size={18} color={theme.ink2} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={lines} style={{ ...typo.body, color: theme.ink }}>
          {name}
        </Text>
        <Text numberOfLines={lines} style={{ ...typo.footnote, color: theme.ink2 }}>
          {line}
        </Text>
        {large && waiting && <Text style={{ ...typo.subheadMedium, color: theme.warn }}>{waiting}</Text>}
      </View>
      {!large && waiting && <Text style={{ ...typo.subheadMedium, color: theme.warn }}>{waiting}</Text>}
      {onPress && <Icon name="chevron.right" glyph="›" size={13} color={theme.ink3} />}
    </Tap>
  );
}

/** The Mac's card from its link (Connected, Asleep or Offline, as Settings words it), then each Host with the line the Mac gives it. */
export function ComputerCards({
  machines,
  chats,
  offline,
  onPress,
  openMachine,
}: {
  machines: Machine[] | null;
  chats: CountedChat[] | null;
  offline: boolean;
  onPress?: () => void;
  /** A Host's own page: a tap on its card lands on its waiting cards, not on the list of computers. */
  openMachine?: (id: string) => void;
}) {
  const mac = useMacLink();
  const counts = needInput(chats, offline);
  const hosts = (machines ?? []).filter((m) => m.id !== 'local');
  return (
    <View style={{ gap: 10, paddingHorizontal: 16, paddingTop: 28 }}>
      <Card name={mac.name} line={mac.word} count={counts.get('local') ?? 0} onPress={onPress} />
      {hosts.map((m) => (
        <Card
          key={m.id}
          name={m.name}
          line={[m.line, attentionReason(m), m.reach ? reachLabel(m.reach, mac.name, m.directDown) : null].filter(Boolean).join(' · ')}
          // the Mac's chats waiting there, or the cards the Host itself holds (the Mac may be away, or not count them)
          count={Math.max(counts.get(m.id) ?? 0, m.waiting ?? 0)}
          onPress={openMachine ? () => openMachine(m.id) : onPress}
        />
      ))}
    </View>
  );
}
