// The screenshot a step took, under its row: small while you read on, full width on a tap (the Mac's full capture, when it has one), small again on another.
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { Image, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { Spark } from './Spark';

/** How wide the small picture is, in points: a glance, as Claude shows a step's screenshot in its transcript. */
export const SMALL_WIDTH = 132;

/** Reads a step's full capture from the Mac by its call id; null when there is none, and the inline picture stays. */
type LoadPicture = (callId: string) => Promise<string | null>;
const Loader = createContext<LoadPicture | null>(null);

/** The chat screen hands its way to the Mac's captures to every step picture below it. */
export function StepPictureProvider({ load, children }: { load?: LoadPicture; children: ReactNode }) {
  return <Loader.Provider value={load ?? null}>{children}</Loader.Provider>;
}

export function StepPicture({ uri, callId }: { uri: string; callId?: string }) {
  const theme = useTheme();
  const load = useContext(Loader);
  const [big, setBig] = useState(false);
  // the full capture once the Mac sent it (the inline thumbnail is small and heavily compressed); one ask per picture
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const asked = useRef(false);
  async function toggle() {
    const next = !big;
    setBig(next);
    if (!next || asked.current || !load || !callId) return;
    asked.current = true;
    setLoading(true);
    const picture = await load(callId);
    setLoading(false);
    // a picture the Mac could not give (away, none kept) is asked for again on the next enlarge; the inline one shows meanwhile
    if (picture) setFull(picture);
    else asked.current = false;
  }
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={big ? 'Show the screenshot smaller' : 'Show the screenshot larger'}
      accessibilityState={{ busy: loading }}
      onPress={() => void toggle()}
      style={{ marginLeft: 22, marginTop: 2, marginBottom: 6, alignSelf: big ? 'stretch' : 'flex-start' }}
    >
      <Image
        source={{ uri: big && full ? full : uri }}
        accessibilityLabel="Screenshot"
        resizeMode="contain"
        style={{
          width: big ? '100%' : SMALL_WIDTH,
          aspectRatio: 16 / 10,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.glassLine,
          backgroundColor: theme.sunken,
        }}
      />
      {loading && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}
        >
          <Spark size={20} spin />
        </View>
      )}
    </Tap>
  );
}
