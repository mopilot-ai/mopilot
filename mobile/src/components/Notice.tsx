// A calm amber line for what is not known yet (an offline Mac, an action that could not be read back); real failures use ErrorLine.
import { Text, View } from 'react-native';
import { useStyles } from './ui';
import { useTheme } from '../theme';
import { typo, typoWeight } from '../typography';

export function Notice({ lead, text }: { /** Bold first words, e.g. "Stop not confirmed." */ lead?: string; text: string }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.warnSoft }}
    >
      <Text style={{ ...styles.muted, ...typo.subhead, color: theme.warn }}>
        {lead ? <Text style={{ fontWeight: typoWeight.semibold }}>{lead} </Text> : null}
        {text}
      </Text>
    </View>
  );
}

/** What the saved rows show while the Mac does not answer: they may be out of date. */
export const SAVED_ON_PHONE = 'Saved on this phone · may be out of date';
export const SavedOnPhone = () => <Notice text={SAVED_ON_PHONE} />;
