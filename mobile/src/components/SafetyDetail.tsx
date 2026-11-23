// The safety number of a pairing as a detail under the wait for the computer's Connect: a quiet "Check the number" opens the digits and what to do when the computer's differ (#5320); it is not removed, only no longer the first thing on the screen.
import { useState } from 'react';
import { Text, View } from 'react-native';
import { groupSafety, speakSafety } from '../../../shared/remote/safetyNumber.mjs';
import { Tap } from '../ui/ds/Tap';
import { monoFamily } from '../fonts';
import { useTheme } from '../theme';
import { typo } from '../typography';
import { useStyles } from './ui';

export function SafetyDetail({ number }: { number: string }) {
  const styles = useStyles();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel="Check the number"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        hitSlop={8}
        style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ ...typo.subhead, color: theme.accent }}>{`Check the number ${open ? '▴' : '▾'}`}</Text>
      </Tap>
      {open && (
        <View style={{ gap: 2 }}>
          <Text
            accessibilityLabel={`Safety number ${speakSafety(number)}`}
            style={{ fontFamily: monoFamily(), ...typo.subhead, color: theme.ink2 }}
          >
            {groupSafety(number)}
          </Text>
          <Text style={styles.muted}>Your computer shows the same number. If it doesn't, decline there.</Text>
        </View>
      )}
    </View>
  );
}
