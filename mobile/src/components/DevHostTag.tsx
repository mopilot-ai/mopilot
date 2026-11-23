// A small tag on a development build: which host it talks to; a normal or production build shows nothing.
import { Text, View } from 'react-native';
import { monoFamily } from '../fonts';
import { useTheme } from '../theme';
import { typo } from '../typography';

export function DevHostTag({
  host,
  trace,
}: {
  host: string /** Launch steps in ms (launchTrace), read off a phone to see where a slow start went. */;
  trace?: string;
}) {
  const theme = useTheme();
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: theme.infoSoft, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ fontFamily: monoFamily(), ...typo.caption2, color: theme.info }}>Dev host: {host}</Text>
      {!!trace && <Text style={{ fontFamily: monoFamily(), ...typo.caption2, color: theme.info }}>{trace}</Text>}
    </View>
  );
}
