// Claude for iOS's small picker sheet over a page (Select model, Agent, Permissions): a dimmed scrim, a card floating 8 pt from the edges with 40 pt corners, the ✕ header, then the content; it rises on a timed curve from its own measured height (a spring overshot by ~110 pt on the iPhone), or just appears under Reduce Motion.
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, useColorScheme, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  runOnJS,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { GestureDetector, ScrollView, usePanGesture, type NativeGesture } from 'react-native-gesture-handler';
import { dur, ease, spring } from '../motion';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';
import { SheetHeader } from './SheetFrame';

/** The baseline's scrim: 28 % black on light, 50 % on dark. */
const scrim = (dark: boolean) => (dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.28)');

/** How far down (fraction of the card's height) or how fast (points/ms) a pull must go to send the sheet away. */
export const DISMISS_AT = 0.35;
export const DISMISS_VELOCITY = 0.8;

/** The shown fraction after a pull of `dy` points on a card `size` points tall, starting from `from`; it never rises above shown. */
export const pulled = (from: number, dy: number, size: number) => {
  'worklet';
  return Math.min(1, Math.max(0, from - dy / size));
};

/** Whether a pull released with `shown` of the card still on screen and speed `vy` (points/ms, down positive) closes the sheet. */
export const dismisses = (shown: number, vy: number) => {
  'worklet';
  return shown < 1 - DISMISS_AT || vy > DISMISS_VELOCITY;
};

type Timing = { duration: number; easing: readonly [number, number, number, number] };
/** A timed move, or the sheet spring (`spring.baseline`). */
type Move = Timing | 'spring';
/** A sheet rises on Claude for iOS's sheet spring (its picker and plus menu take 0.58 to 0.65 s from the first to the last changed frame; a critical spring at ω 17.5 takes 0.55 s) and leaves in 0.2 s (tap on the scrim: 0.2 s typical). */
const entering: Move = 'spring';
const leaving: Timing = { duration: dur.base, easing: ease.exit };
/** A drag must pass this many points before it is a pull, and sideways drift past it hands the touch back to the buttons. */
const OFFSET = 10;
const FAR = 1e6;
const returning: Timing = { duration: dur.base, easing: ease.snap };

/** Sends the shared value to `to` along `move`, or straight there under Reduce Motion. */
const travelTo = (progress: SharedValue<number>, to: number, reduce: boolean, move: Move, done?: () => void) => {
  if (reduce) {
    progress.value = to;
    done?.();
    return;
  }
  const finish = (finished?: boolean) => {
    'worklet';
    // a move cut short by another one (reopened while leaving) does not finish what it started
    if (finished && done) runOnJS(done)();
  };
  progress.value =
    move === 'spring'
      ? withSpring(to, spring.baseline, finish)
      : withTiming(to, { duration: move.duration, easing: Easing.bezier(...move.easing) }, finish);
};

/**
 * Draws nothing while closed, so what it shows is always read fresh from its owner. The scrim, ✕ and the hardware back
 * all close it; `onBack` turns ✕ into ‹ for a page reached from another sheet (Effort from Select model).
 */
export function BottomSheet({
  open,
  title,
  onClose,
  onBack,
  keyboardInset,
  right,
  footer,
  grabber = false,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onBack?: () => void;
  /** How far to ride above the keyboard when the screen's frame does not already (New chat is shown as a native page sheet: its own lift never reaches this overlay). */
  keyboardInset?: SharedValue<number>;
  /** a text control at the header's right (Add to session's "Photos") */
  right?: ReactNode;
  /** pinned under the scrolling content (Add to session's Attach capsule) */
  footer?: ReactNode;
  /** the small bar at the top, for a sheet that is also a page of choices */
  grabber?: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  const dark = useColorScheme() === 'dark';
  const reduce = useReducedMotion();
  useHardwareBack(onBack ?? onClose, open);
  // one value, 0 away and 1 shown, moves the card and the scrim together: the enter, the exit and the pull down
  const progress = useSharedValue(reduce ? 1 : 0);
  // off screen until the card is measured: the card's height, so its travel is its own
  const size = useSharedValue(10000);
  const measured = useRef(false);
  const [mounted, setMounted] = useState(open);
  const latest = useRef({ open, onClose, reduce });
  latest.current = { open, onClose, reduce };
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.value) * size.value }] }));
  const ride = useAnimatedStyle(() => ({ paddingBottom: keyboardInset ? keyboardInset.value : 0 }));
  const fade = useAnimatedStyle(() => ({ opacity: progress.value }));
  useEffect(() => {
    if (open) {
      setMounted(true);
      // a sheet reopened while it was still leaving rises from where it is
      if (measured.current) travelTo(progress, 1, reduce, entering);
      return;
    }
    // the card leaves the tree when its exit has finished, not on a second clock
    travelTo(progress, 0, reduce, leaving, () => {
      measured.current = false;
      setMounted(false);
    });
  }, [open, reduce, progress]);
  const measure = (height: number) => {
    size.value = height;
    if (measured.current) return;
    measured.current = true;
    travelTo(progress, 1, reduce, entering);
  };
  // a sheet opened while typing (⋯ from MoMo's composer) puts the keyboard away, as iOS's own sheets do; seen on the iPhone
  useEffect(() => {
    if (open) Keyboard.dismiss();
  }, [open]);
  // one pan on the whole card, beside the scroll view's own: the header always pulls, the content pulls once it is at its top
  const from = useSharedValue(1);
  // where the finger was when the content last had room to scroll, so the pull begins from the top without a dead zone
  const base = useSharedValue(0);
  const scrollY = useSharedValue(0);
  const headerEnd = useSharedValue(0);
  const onHeader = useSharedValue(false);
  const [scroller, setScroller] = useState<NativeGesture | null>(null);
  const reduceNow = useSharedValue(reduce);
  useEffect(() => {
    reduceNow.value = reduce;
  }, [reduce, reduceNow]);
  const close = useCallback(() => latest.current.onClose(), []);
  const pull = usePanGesture({
    // a drag down; sideways is left to the buttons, upwards does nothing (the content scrolls)
    activeOffsetY: [-FAR, OFFSET],
    failOffsetX: [-OFFSET, OFFSET],
    simultaneousWith: scroller ?? undefined,
    onActivate: (e) => {
      'worklet';
      from.value = progress.value;
      base.value = 0;
      onHeader.value = e.y - e.translationY < headerEnd.value;
    },
    onUpdate: (e) => {
      'worklet';
      // content with room above it is scrolling, not pulling: the pull starts where the content reached its top
      if (!onHeader.value && scrollY.value > 0) {
        base.value = e.translationY;
        return;
      }
      const dy = e.translationY - base.value;
      // a finger back above where the pull began hands the touch to the content again
      if (dy < 0) base.value = e.translationY;
      progress.value = pulled(from.value, dy, size.value);
    },
    onDeactivate: (e) => {
      'worklet';
      const shown = progress.value;
      if (!e.canceled && shown < 1 && dismisses(shown, e.velocityY / 1000)) return runOnJS(close)();
      progress.value = reduceNow.value ? 1 : withTiming(1, { duration: returning.duration, easing: Easing.bezier(...returning.easing) });
    },
  });
  if (!mounted) return null;
  return (
    <Animated.View
      accessibilityViewIsModal
      style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' }, ride]}
    >
      <Animated.View
        pointerEvents="none"
        style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: scrim(dark) }, fade]}
      />
      <Tap
        feel="none"
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={onClose}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <GestureDetector gesture={pull}>
        <Animated.View
          onLayout={(e) => measure(e.nativeEvent.layout.height)}
          style={[
            slide,
            {
              marginHorizontal: 8,
              marginBottom: 8,
              maxHeight: '85%',
              borderRadius: 40,
              backgroundColor: theme.bg,
              paddingHorizontal: 16,
              paddingTop: 14,
              paddingBottom: 26,
              shadowColor: '#000000',
              shadowOpacity: 0.15,
              shadowRadius: 40,
              shadowOffset: { width: 0, height: -6 },
            },
          ]}
        >
          <View onLayout={(e) => (headerEnd.value = e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
            {grabber && (
              <View
                style={{
                  alignSelf: 'center',
                  width: 36,
                  height: 5,
                  borderRadius: 3,
                  backgroundColor: theme.fill2,
                  marginBottom: 10,
                  marginTop: -6,
                }}
              />
            )}
            <SheetHeader title={title} onClose={onBack ?? onClose} back={!!onBack} right={right} />
          </View>
          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={16}
            onScroll={(e) => {
              scrollY.value = e.nativeEvent.contentOffset.y;
            }}
            onGestureUpdate_CAN_CAUSE_INFINITE_RERENDER={setScroller}
          >
            {children}
          </ScrollView>
          {footer}
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}
