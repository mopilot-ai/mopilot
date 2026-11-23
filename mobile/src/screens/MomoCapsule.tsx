// The capsule under MoMo's name on the classic phone: what the Mac says (Online, Offline, or "Paused · Tap to resume", which resumes MoMo when pressed).
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { typo } from '../typography';
import type { MomoStatus } from '../momo/stateContract';

/** The capsule under MoMo's name: what the Mac says, else the connection's own word; never a guess. */
export const statusWord = (status: MomoStatus | null, online: boolean): { text: string; on: boolean } => {
  if (status === 'paused') return { text: 'Paused · Tap to resume', on: false };
  // an older Mac reports no state: the connection alone says whether MoMo can be reached
  return online && status !== 'offline' ? { text: 'Online', on: true } : { text: 'Offline', on: false };
};

export function StatusCapsule({
  word,
  paused,
  busy,
  resume,
}: {
  word: { text: string; on: boolean };
  paused: boolean;
  busy: boolean;
  resume: () => void;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole={paused ? 'button' : 'text'}
      accessibilityLabel={word.text}
      disabled={!paused || busy}
      onPress={resume}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginTop: 2,
        paddingHorizontal: 9,
        paddingVertical: 2,
        borderRadius: 10,
        backgroundColor: word.on ? theme.okSoft : theme.sunken,
      }}
    >
      {!paused && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: word.on ? theme.ok : theme.ink3 }} />}
      <Text style={{ ...typo.captionSemibold, color: word.on ? theme.ok : theme.ink2 }}>{word.text}</Text>
    </Tap>
  );
}
