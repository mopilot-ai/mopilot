// The chat's page while the computer has not yet said which chat Start made: your message, the quiet working dots, and Back (which leaves the start to finish on its own).
import { ScrollView, View } from 'react-native';
import { GlassCircle } from '../components/Glass';
import { Icon } from '../components/Icon';
import { ThinkingDots } from '../components/Motion';
import { PageHeader } from '../components/PageHeader';
import { SentBubble } from '../components/SentBubble';
import { useStyles } from '../components/ui';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';

export function Starting({ text, pictures, back }: { text: string; pictures?: string[]; back: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  useHardwareBack(back, true);
  return (
    <View style={styles.page}>
      <PageHeader
        left={
          <GlassCircle label="Back" onPress={back}>
            <Icon name="chevron.left" glyph="‹" size={20} color={theme.ink} />
          </GlassCircle>
        }
      />
      <ScrollView contentContainerStyle={[styles.body, { padding: 16, gap: 8 }]}>
        <SentBubble id="starting" text={text} pictures={pictures} />
        <ThinkingDots color={theme.ink2} />
      </ScrollView>
    </View>
  );
}
