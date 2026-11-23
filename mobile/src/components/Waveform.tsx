// The live meter of a voice note: bars that rise with the voice and a timer, drawn from the microphone's level; the screen reader hears only the time, once.
import { Text, View } from 'react-native';
import { BARS, clock, type Meter } from '../remote/useMeter';
import { useTheme } from '../theme';
import { typo } from '../typography';

const TALLEST = 26;
const SHORTEST = 3;

export function Waveform({ meter }: { meter: Meter }) {
  const theme = useTheme();
  // the newest bar is at the right; before the first one arrives the meter is flat
  const empty = Array.from({ length: Math.max(0, BARS - meter.levels.length) }, (_, k) => ({ at: -k - 1, level: 0 }));
  const bars = [...empty, ...meter.levels];
  return (
    <View accessible accessibilityLabel={`Recording, ${clock(meter.ms)}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View importantForAccessibility="no-hide-descendants" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        {bars.map(({ at, level }) => (
          <View
            key={at}
            style={{ width: 3, height: SHORTEST + level * (TALLEST - SHORTEST), borderRadius: 2, backgroundColor: theme.accent }}
          />
        ))}
      </View>
      <Text style={{ ...typo.subhead, fontVariant: ['tabular-nums'], color: theme.ink2 }}>{clock(meter.ms)}</Text>
    </View>
  );
}
