// Claude for iOS's drawer: destinations (Chats, MoMo, Scheduled), then Pinned and Recents, your initials (Settings) and New chat at the bottom; the page slides right with a rounded corner.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { spring } from '../motion';
import { serifFamily } from '../fonts';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';
import { Capsule, GlassCircle } from './Glass';
import { Icon } from './Icon';
import { useScreenInsets } from './ui';
import { StatusGlyph, type SessionState } from './SessionRow';
import { typo, typoWeight } from '../typography';

/** How much of the screen the drawer takes, and the corner the page gets while it is pushed aside (measured on Claude for iOS: 75.4 %; the baseline's 44 pt corner). */
export const DRAWER_WIDTH = 0.754;
export const PAGE_CORNER = 44;
export type DrawerDestination = { key: string; title: string; icon: ReactNode; onPress: () => void };
export type DrawerChat = { id: string; title: string; state: SessionState };

/** The drawer's own column, without the page. */
export function DrawerPanel({
  destinations,
  current,
  pinned,
  recents,
  openChat,
  initials,
  settings,
  newChat,
  search,
}: {
  destinations: DrawerDestination[];
  current: string;
  pinned: DrawerChat[];
  recents: DrawerChat[];
  openChat: (id: string) => void;
  initials: string;
  settings: () => void;
  newChat?: () => void;
  search?: () => void;
}) {
  const theme = useTheme();
  const row = (chat: DrawerChat) => (
    <Tap
      key={chat.id}
      accessibilityRole="button"
      accessibilityLabel={chat.title}
      onPress={() => openChat(chat.id)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 46 }}
    >
      <View style={{ width: 22, alignItems: 'center' }}>
        <StatusGlyph state={chat.state} small />
      </View>
      <Text numberOfLines={1} style={{ flex: 1, ...typo.body, color: theme.ink }}>
        {chat.title}
      </Text>
    </Tap>
  );
  const label = (text: string) => (
    <Text accessibilityRole="header" style={{ ...typo.subhead, color: theme.ink2, paddingTop: 16, paddingBottom: 6 }}>
      {text}
    </Text>
  );
  return (
    <View style={{ flex: 1, backgroundColor: theme.drawer }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingLeft: 24, paddingRight: 16 }}>
        <Text style={{ flex: 1, ...typo.title1, fontFamily: serifFamily(), color: theme.ink }}>MoPilot</Text>
        {search && (
          <GlassCircle label="Search chats" onPress={search}>
            <Icon name="magnifyingglass" glyph="⌕" size={20} color={theme.ink} />
          </GlassCircle>
        )}
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24 }}>
        {destinations.map((d) => (
          <Tap
            key={d.key}
            accessibilityRole="button"
            accessibilityLabel={d.title}
            accessibilityState={{ selected: d.key === current }}
            onPress={d.onPress}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 50 }}
          >
            <View style={{ width: 22, alignItems: 'center' }}>{d.icon}</View>
            <Text style={{ ...typo.body, color: theme.ink, fontWeight: d.key === current ? typoWeight.semibold : typoWeight.regular }}>
              {d.title}
            </Text>
          </Tap>
        ))}
        {pinned.length > 0 && label('Pinned')}
        {pinned.map(row)}
        {recents.length > 0 && label('Recents')}
        {recents.map(row)}
      </ScrollView>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 24,
          paddingTop: 12,
          paddingBottom: 36,
        }}
      >
        <GlassCircle label="Settings" onPress={settings}>
          <Text style={{ ...typo.calloutSemibold, color: theme.ink }}>{initials}</Text>
        </GlassCircle>
        {newChat && <Capsule title="New chat" icon={<Icon name="plus" glyph="+" size={16} color={theme.ink} />} onPress={newChat} />}
      </View>
    </View>
  );
}

/** How far (fraction of the drawer's width) or how fast (points/ms) a release must go to settle on the side it was dragged toward. */
export const SETTLE_AT = 0.5;
export const SETTLE_VELOCITY = 0.3;
/** The strip at the screen's left edge that a drag opens the drawer from. */
export const EDGE_WIDTH = 24;

/** Where a drag that began at `from` (0 closed, 1 open) is after moving `dx` points on a drawer `span` points wide. */
export const dragTo = (from: number, dx: number, span: number) => {
  'worklet';
  return Math.min(1, Math.max(0, from + dx / span));
};

/** Whether a drag released at `progress` with horizontal speed `vx` (points/ms, right positive) settles open. */
export const settlesOpen = (progress: number, vx: number) => {
  'worklet';
  return Math.abs(vx) > SETTLE_VELOCITY ? vx > 0 : progress > SETTLE_AT;
};

/** A drag of the page runs on the UI thread; these keep it from starting a drag it should not (a vertical scroll, a drag in the middle of a closed page). */
export const OFFSET = 10;
const FAR = 1e6;
/** How dark the drawer's own layer is when the page covers it: Claude's is 0.38 × (1 − how far the page has moved), measured on two takes (0.66 of its final brightness at a tenth of the way, 0.89 at three quarters). */
export const DIM = 0.38;

/** Sends the shared value to an end on the drawer's spring, with the finger's velocity (fractions of the drawer per second); closed ends tell the owner the drawer's content can go. Runs on either thread. */
const settleTo = (progress: SharedValue<number>, to: 0 | 1, velocity: number, reduce: boolean, hide: () => void) => {
  'worklet';
  if (reduce) {
    progress.value = to;
    if (to === 0) runOnJS(hide)();
    return;
  }
  progress.value = withSpring(to, { ...spring.drawer, velocity }, (finished) => {
    'worklet';
    // a move cut short by another one does not decide whether the content stays
    if (finished && to === 0) runOnJS(hide)();
  });
};

/**
 * The drawer behind and the page in front. One shared value (0 closed, 1 open) moves the page, its corner and the drawer's
 * visibility; `open` sends it to either end on `spring.drawer` (Claude's measured sidebar), and a pan (recognised and run on the UI thread, from the left
 * edge when closed or anywhere on the open page) writes it directly and settles on the same spring by position or speed, carrying the finger's velocity. A tap on the page's
 * visible strip closes the drawer.
 */
export function DrawerFrame({
  open,
  close,
  show,
  drawer,
  children,
}: {
  open: boolean;
  close: () => void;
  /** Opens the drawer when a drag from the edge settles open; without it the drawer opens only from its button. */
  show?: () => void;
  drawer: ReactNode;
  children: ReactNode;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  // the drawer and the pushed page run under the status bar and the home indicator as Claude's do, their content clear of both
  const inset = useScreenInsets();
  const reduce = useReducedMotion();
  // Android's back closes an open drawer rather than the app
  useHardwareBack(close, open);
  const span = width * DRAWER_WIDTH;
  const progress = useSharedValue(open ? 1 : 0);
  // what the pan reads on the UI thread
  const from = useSharedValue(0);
  const spanNow = useSharedValue(span);
  const openNow = useSharedValue(open);
  const reduceNow = useSharedValue(reduce);
  // the drawer's content is there while it is open, being dragged, and while the page slides back over it, and not otherwise
  const [shown, setShown] = useState(open);
  const dragging = useRef(false);
  useEffect(() => {
    spanNow.value = span;
    openNow.value = open;
    reduceNow.value = reduce;
  }, [span, open, reduce, spanNow, openNow, reduceNow]);
  // where the shared value is headed, so a prop that follows a settled drag does not restart the spring and lose the finger's velocity
  const target = useSharedValue(open ? 1 : 0);
  const hide = useCallback(() => setShown(false), []);
  useEffect(() => {
    if (dragging.current) return;
    const to = open ? 1 : 0;
    if (open) setShown(true);
    if (target.value === to) return;
    target.value = to;
    settleTo(progress, to, 0, reduce, hide);
  }, [open, reduce, progress, target, hide]);
  // the JS side of a drag: the content is mounted while it moves, and once it settles the owner learns where it landed
  const latest = useRef({ open, close, show });
  latest.current = { open, close, show };
  const begin = () => {
    dragging.current = true;
    setShown(true);
  };
  const land = (to: number) => {
    dragging.current = false;
    const now = latest.current;
    // a drag recognised while closed needs `show` (the pan is only enabled then), so it is there when one settles open
    if (to === 1 && !now.open) (now.show as () => void)();
    if (to === 0 && now.open) now.close();
  };
  const pan = usePanGesture({
    // closed: a drag right from the left edge; open: a drag left anywhere. A vertical drag is left to the list.
    enabled: open || !!show,
    hitSlop: open ? undefined : { left: 0, width: EDGE_WIDTH },
    activeOffsetX: open ? [-OFFSET, FAR] : [-FAR, OFFSET],
    failOffsetX: open ? [-FAR, OFFSET] : [-OFFSET, FAR],
    failOffsetY: [-OFFSET, OFFSET],
    onActivate: () => {
      'worklet';
      from.value = progress.value;
      runOnJS(begin)();
    },
    onUpdate: (e) => {
      'worklet';
      progress.value = dragTo(from.value, e.translationX, spanNow.value);
    },
    onDeactivate: (e) => {
      'worklet';
      const to = e.canceled ? (openNow.value ? 1 : 0) : settlesOpen(progress.value, e.velocityX / 1000) ? 1 : 0;
      target.value = to;
      settleTo(progress, to, e.velocityX / spanNow.value, reduceNow.value, hide);
      runOnJS(land)(to);
    },
  });
  const dim = useAnimatedStyle(() => ({ opacity: DIM * (1 - progress.value) }));
  const slide = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * span }],
    borderRadius: progress.value * PAGE_CORNER,
  }));
  return (
    <GestureDetector gesture={pan}>
      <View style={{ flex: 1, backgroundColor: theme.drawer }}>
        <View
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: span, ...inset }}
          // behind the page the drawer is not read; open, the page is not
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        >
          {shown && drawer}
          {/* the drawer's own layer starts dim and clears as the page moves away */}
          <Animated.View
            pointerEvents="none"
            style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: '#000000' }, dim]}
          />
        </View>
        <Animated.View
          style={[
            {
              flex: 1,
              backgroundColor: theme.bg,
              overflow: 'hidden',
              // the baseline's lift on the pushed page's edge, so its corner reads against the drawer (off screen while closed)
              boxShadow: '-8px 0px 24px rgba(0, 0, 0, 0.18)',
            },
            slide,
          ]}
          accessibilityElementsHidden={open}
          importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
        >
          {/* set back in on a view of its own: the page's floating footer is placed from this view's edges, not the slide's */}
          <View style={{ flex: 1, ...inset }}>{children}</View>
        </Animated.View>
        {open && (
          // the visible strip of the page closes the drawer, as a tap on Claude's does
          <Tap
            feel="none"
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            onPress={close}
            style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: width * (1 - DRAWER_WIDTH) }}
          />
        )}
      </View>
    </GestureDetector>
  );
}
