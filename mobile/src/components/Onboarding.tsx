// What a person who just installed the app needs to know: where the pairing code comes from, and what a notification will say.
import { Text, View } from 'react-native';
import { PUSH_TITLES } from '../push/kinds';
import { useTheme } from '../theme';
import { useStyles } from './ui';
import { typo } from '../typography';

/** The one line under an empty home: where the code comes from. */
export const PAIR_HINT = 'Add a computer to see its chats here.';

/** What a notification will look like, drawn before the phone asks for permission: the real fixed title, and the line on what never shows. */
export function NotificationPreview() {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <>
      <View
        accessible
        accessibilityLabel={`Example notification: ${PUSH_TITLES.needsYou}`}
        style={{ backgroundColor: theme.sunken, borderRadius: 14, padding: 12, gap: 2 }}
      >
        <Text style={{ ...typo.caption, color: theme.ink2 }}>MoPilot · now</Text>
        <Text style={{ ...typo.subheadSemibold, color: theme.ink }}>{PUSH_TITLES.needsYou}</Text>
      </View>
      <Text style={styles.muted}>That is all it says. A chat's words, commands and files never appear in a notification.</Text>
    </>
  );
}
