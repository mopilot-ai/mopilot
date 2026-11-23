// A full-screen look at one attached image, or at all of a message's pictures side by side (swipe between them, 1 / 2): the whole picture (contain) on black, pinch and double-tap to zoom, pan while zoomed, a close button, and a pull down that dismisses it when not zoomed (iOS's own overscroll). One viewer for the classic and the rebuilt screens.
import { type ComponentRef, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Text,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type NativeSyntheticEvent,
} from 'react-native';
import { Tap } from '../ds/Tap';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { Icon } from '../../components/Icon';
import { typo } from '../../typography';
import { useTranslation } from '../i18n';

/** The dark backing of the position and Close over the picture, so they read over a white one too. */
const BACKING = 'rgba(28,28,30,0.7)';

/** How far (points) or how fast a downward drag must go to count as a dismiss. */
export const DISMISS_DISTANCE = 100;
export const DISMISS_VELOCITY = 1.2;

/** Whether a drag that ended at `dy` points down with `vy` points/ms is a swipe down to dismiss. */
export const dismisses = (dy: number, vy: number) => dy > DISMISS_DISTANCE || (dy > 20 && vy > DISMISS_VELOCITY);

/** The pull is a scroll view's own overscroll: iOS runs the gesture, so nothing here depends on a JS touch responder claiming it. */
type Pull = { nativeEvent: { contentOffset: { y: number }; zoomScale?: number; velocity?: { y: number } } };

/** Pulling the picture down (its overscroll past the top) fades the backdrop with the pull, and letting go far or fast enough closes it. Zoomed in, the scroll view pans the picture instead. */
export function pullToDismiss(drag: SharedValue<number>, close: () => void) {
  return {
    onScroll: ({ nativeEvent: { contentOffset, zoomScale = 1 } }: Pull) => {
      drag.value = zoomScale > ZOOMED ? 0 : Math.max(0, -contentOffset.y);
    },
    onScrollEndDrag: ({ nativeEvent: { contentOffset, zoomScale = 1, velocity } }: Pull) => {
      // a scroll view's velocity is negative while the content moves down, as a finger pulling the picture down does
      if (zoomScale <= ZOOMED && dismisses(-contentOffset.y, -(velocity?.y ?? 0))) close();
    },
  };
}

/** Two taps within this many milliseconds are a double tap. */
export const DOUBLE_TAP_MS = 300;
/** How far a double tap zooms in. */
export const DOUBLE_TAP_ZOOM = 2.5;
/** More than this is zoomed in (iOS reports a zoom scale a hair over 1 after a pinch back out). */
export const ZOOMED = 1.01;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** The part of the picture a double tap at (x, y) shows: all of it when already zoomed in, else a window `DOUBLE_TAP_ZOOM` times smaller centred on the tap and kept inside the picture. */
export function doubleTapRect(zoomed: boolean, x: number, y: number, width: number, height: number) {
  if (zoomed) return { x: 0, y: 0, width, height };
  const w = width / DOUBLE_TAP_ZOOM;
  const h = height / DOUBLE_TAP_ZOOM;
  return { x: clamp(x - w / 2, 0, width - w), y: clamp(y - h / 2, 0, height - h), width: w, height: h };
}

/** The page a horizontal scroll to offset `x` came to rest on, of `count` pages `width` wide. */
export const pageAt = (x: number, width: number, count: number) => clamp(Math.round(x / Math.max(1, width)), 0, count - 1);

/** One picture of the viewer, in its own zooming scroll view: pinch and double tap zoom it, a pull down past the top closes it when it is not zoomed. */
function ZoomPage({
  place,
  page,
  width,
  height,
  active,
  pull,
}: {
  place: number;
  page: ViewerPage;
  width: number;
  height: number;
  /** the page on screen: a page swiped away comes back at its whole size */
  active: boolean;
  pull: ReturnType<typeof pullToDismiss>;
}) {
  const { t } = useTranslation();
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const zoom = useRef(1);
  const lastTap = useRef(0);
  useEffect(() => {
    if (!active && zoom.current > ZOOMED) scroller.current?.scrollResponderZoomTo({ x: 0, y: 0, width, height, animated: false });
  }, [active, width, height]);
  const onScroll = (e: Parameters<typeof pull.onScroll>[0]) => {
    zoom.current = e.nativeEvent.zoomScale ?? 1;
    pull.onScroll(e);
  };
  // a second tap soon after the first zooms in on the spot, or back out to the whole picture
  const tap = (e: NativeSyntheticEvent<{ locationX?: number; locationY?: number }>) => {
    const now = Date.now();
    const double = now - lastTap.current < DOUBLE_TAP_MS;
    lastTap.current = double ? 0 : now;
    if (!double) return;
    const { locationX = width / 2, locationY = height / 2 } = e.nativeEvent;
    scroller.current?.scrollResponderZoomTo({
      ...doubleTapRect(zoom.current > ZOOMED, locationX, locationY, width, height),
      animated: true,
    });
  };
  return (
    <ScrollView
      ref={scroller}
      testID={`image-page-${place}`}
      {...pull}
      onScroll={onScroll}
      scrollEventThrottle={16}
      alwaysBounceVertical
      bouncesZoom
      minimumZoomScale={1}
      maximumZoomScale={4}
      centerContent
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      style={{ width, height }}
      contentContainerStyle={{ width, height }}
    >
      {page.uri !== null ? (
        <Tap feel="none" accessible={false} onPress={tap} style={{ width, height }}>
          <Image
            source={{ uri: page.uri }}
            accessibilityLabel={page.name || t('viewer.picture')}
            resizeMode="contain"
            style={{ width, height }}
          />
        </Tap>
      ) : (
        <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color="#ffffff" accessibilityLabel={t('viewer.picture')} />
        </View>
      )}
    </ScrollView>
  );
}

/** One picture of a viewer that has several: its place in the message, the words it is read as. */
export type ViewerPage = { key: string; uri: string | null; name: string };

/**
 * The viewer. With `pages` (all of a message's pictures) it pages between them, a swipe at a time while the picture is not zoomed past
 * its edge (the nested scroll views hand the swipe over by themselves), with the position shown as "1 / 2" and VoiceOver able to move
 * on; `index` is the page on screen and `onIndex` hears the page it came to rest on. The picture on screen is `uri`; without `pages`
 * the viewer is that one picture.
 */
export function ImageViewer({
  uri,
  name,
  close,
  pages,
  index = 0,
  onIndex,
}: {
  uri: string | null;
  name: string;
  close: () => void;
  pages?: ViewerPage[];
  index?: number;
  onIndex?: (index: number) => void;
}) {
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  const drag = useSharedValue(0);
  // the backdrop lightens as the picture is pulled away, so the chat shows through as it goes
  const backdrop = useAnimatedStyle(() => ({ opacity: 1 - Math.min(drag.value / 400, 0.6) }));
  const closing = useRef(close);
  closing.current = close;
  const pull = useMemo(() => pullToDismiss(drag, () => closing.current()), [drag]);
  const pager = useRef<ComponentRef<typeof ScrollView>>(null);
  const list: ViewerPage[] = pages && pages.length > 1 ? pages : [{ key: 'only', uri, name }];
  const several = list.length > 1;
  const go = (to: number) => {
    const next = clamp(to, 0, list.length - 1);
    pager.current?.scrollTo({ x: next * width, y: 0, animated: true });
    if (next !== index) onIndex?.(next);
  };
  const position = t('viewer.position', { n: index + 1, total: list.length });
  return (
    <Modal visible={uri !== null} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000000' }, backdrop]} />
        {several ? (
          <ScrollView
            ref={pager}
            testID="image-pager"
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            contentOffset={{ x: index * width, y: 0 }}
            onMomentumScrollEnd={(e) => {
              const to = pageAt(e.nativeEvent.contentOffset.x, width, list.length);
              if (to !== index) onIndex?.(to);
            }}
          >
            {list.map((page, i) => (
              <ZoomPage
                key={page.key}
                place={i}
                page={Math.abs(i - index) <= 1 ? page : { ...page, uri: null }}
                width={width}
                height={height}
                active={i === index}
                pull={pull}
              />
            ))}
          </ScrollView>
        ) : (
          <ZoomPage place={0} page={list[0]} width={width} height={height} active pull={pull} />
        )}
        {several && (
          <View
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={position}
            accessibilityValue={{ text: position }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(e) => go(index + (e.nativeEvent.actionName === 'increment' ? 1 : -1))}
            style={{
              position: 'absolute',
              top: 60,
              alignSelf: 'center',
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 14,
              backgroundColor: BACKING,
            }}
          >
            <Text style={{ ...typo.subhead, color: '#ffffff' }}>{position}</Text>
          </View>
        )}
        <Tap
          accessibilityRole="button"
          accessibilityLabel={t('viewer.closeImage')}
          onPress={close}
          hitSlop={8}
          style={{
            position: 'absolute',
            top: 56,
            right: 16,
            width: 36,
            minHeight: 36,
            aspectRatio: 1,
            borderRadius: 18,
            backgroundColor: BACKING,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="xmark" glyph="×" size={16} color="#ffffff" />
        </Tap>
      </View>
    </Modal>
  );
}
