// The signed-out home on the baseline tokens, as short as Claude's: the mark, the name in serif, what the app is, and one Sign in capsule.
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { serifFamily } from '../fonts';
import { useTheme } from '../theme';
import { typo } from '../typography';

export function Welcome({ busy, signIn }: { busy: boolean; signIn: () => void }) {
  const theme = useTheme();
  const title = busy ? 'Opening sign in…' : 'Sign in';
  return (
    <View style={{ gap: 28, paddingTop: 48 }}>
      <View style={{ alignItems: 'center', gap: 10 }}>
        <View
          style={{ width: 72, height: 72, borderRadius: 20, backgroundColor: theme.btn, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text allowFontScaling={false} style={{ ...typo.largeTitleBold, color: theme.btnInk }}>
            M
          </Text>
        </View>
        <Text accessibilityRole="header" style={{ fontFamily: serifFamily(), ...typo.largeTitle, color: theme.ink, textAlign: 'center' }}>
          MoPilot
        </Text>
        <Text style={{ ...typo.body, color: theme.ink2, textAlign: 'center' }}>Your chats, connected to your computer.</Text>
      </View>
      {/* the baseline's one primary action: a 52 pt ink capsule */}
      <Tap
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={signIn}
        style={{
          minHeight: 52,
          borderRadius: 26,
          paddingHorizontal: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.btn,
          opacity: busy ? 0.5 : 1,
        }}
      >
        <Text style={{ ...typo.bodySemibold, color: theme.btnInk }}>{title}</Text>
      </Tap>
    </View>
  );
}
