// What floats over a chat's list: the soft fade into the composer (Claude for iOS lets the text melt away above the box, not end in a hard edge), the round down-arrow while a pinned reply runs past the fold, and the ghost bubble that rises from the composer when a message is sent.
import { type ComponentProps, type RefObject, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { withAlpha } from '../presentation/wordFade';
import { useTheme } from '../theme';
import { JumpToLatest } from './JumpToLatest';
import { RiseGhost } from './RiseGhost';
import type { ArrowLevel, AwayStore } from '../remote/useFollowEnd';

/** The fade is this many bands of this many points, from clear at the top to the page's own colour at the composer. */
export const FADE_BANDS = 8;
export const FADE_BAND_HEIGHT = 4;

/** How opaque each band is: eased, so the text goes from ink to nothing without a visible step. */
export const FADE_ALPHAS = Array.from({ length: FADE_BANDS }, (_, i) => ((i + 1) / FADE_BANDS) ** 1.6);

function ComposerFade() {
  const theme = useTheme();
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: FADE_BANDS * FADE_BAND_HEIGHT }}>
      {FADE_ALPHAS.map((alpha) => (
        <View key={alpha} style={{ height: FADE_BAND_HEIGHT, backgroundColor: withAlpha(theme.bg, alpha) }} />
      ))}
    </View>
  );
}

/** A boolean given as it is never changes: nothing to subscribe to. */
const never = () => () => undefined;
const levelOf = (away: boolean): ArrowLevel => (away ? 'away' : 'none');

export function FollowOverlays({
  scroller,
  away,
  ready = true,
  jump,
}: {
  scroller: ComponentProps<typeof RiseGhost>['scroller'] & RefObject<unknown>;
  /** The reply is past the fold: the arrow shows. */
  away: boolean | Pick<AwayStore, 'get' | 'subscribe'>;
  /** False until the chat has rows: no arrow before then. */
  ready?: boolean;
  jump: () => void;
}) {
  const store = typeof away === 'boolean' ? null : away;
  const level = useSyncExternalStore(store?.subscribe ?? never, store?.get ?? (() => levelOf(away === true)));
  return (
    <>
      <ComposerFade />
      <RiseGhost scroller={scroller} />
      {ready && level !== 'none' && <JumpToLatest onPress={jump} answer={level === 'answer'} />}
    </>
  );
}
