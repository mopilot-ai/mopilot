// Keeps a chat at its newest message on open, pins a sent message under the nav bar like Claude for iOS (the reply grows below it and the view stays still, with a down-arrow once the reply passes the fold), and leaves a reader who scrolled up where they are.
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, type ScrollView } from 'react-native';
import { nativeGate } from '../presentation/nativeGate';
import { useReducedMotion } from 'react-native-reanimated';
import { launchRise, watchSentTop } from '../sendOrigin';

/** Within this many points of the end counts as being at the end. */
export const NEAR_END = 80;
/** Where a pinned message sits below the top of the view: the content's own bottom padding is 16, the new message starts one 8 gap later, and it rests 8 under the nav bar. */
export const PIN_INSET = 16;
/** The sent bubble rests this far under the top of the view. */
export const PIN_GAP = 8;
/** A later report of the bubble's place that differs from the pinned one by more than this is the content above it growing (a tall reply), not the bubble moving: the pin stays. */
export const REPIN_SLACK = 160;
type Scrolled = {
  nativeEvent?: { contentOffset?: { y?: number }; contentSize?: { height?: number }; layoutMeasurement?: { height?: number } };
};
type Report = { y: number; content: number; view: number };

/** What a scroll report says, or null when it lacks a number. */
export function reportOf(event: Scrolled): Report | null {
  const m = event.nativeEvent;
  const y = m?.contentOffset?.y;
  const content = m?.contentSize?.height;
  const view = m?.layoutMeasurement?.height;
  return y === undefined || content === undefined || view === undefined ? null : { y, content, view };
}
export const atEnd = (r: Report) => r.content - r.view - r.y <= NEAR_END;
/** How far past the end of what is drawn the offset may stand, in views: a finger's bounce stays within it, a blank screen does not. */
export const BLANK_PAST = 0.5;
/**
 * Where to put the offset when it stands past the end by more than a bounce could: the last screen of what is drawn, or null
 * when it is fine. Content that shrinks under a held offset (earlier pages dropped by a read again, a card replaced by its
 * receipt, a pinned room collapsing) leaves the native view where it was, showing nothing; this is the one rule for all of them.
 */
export function clampOffset(r: Report, slack = BLANK_PAST, grace = 0): number | null {
  const max = Math.max(0, r.content - r.view);
  return r.y > max + r.view * slack + grace ? max : null;
}
/**
 * How far past the end a view that follows the chat may stand with no finger on it, in points. A bounce only happens under a finger
 * (or its momentum), so a followed, idle view past the end is blank space, not a bounce: a cold open of a long reply was left 107
 * points up by the view moving after the last pin, with nothing to put it back. A little is rounding and the screen's own settling.
 */
export const IDLE_BLANK = 8;

/**
 * The reader has left the end when the offset went back up while the content did not shrink. How the view moved
 * (a finger, a status-bar tap, an accessibility scroll, a scrollbar) does not matter, and a report taken after the
 * content grew and before the screen scrolled to it (a streaming reply) never lowers the offset, so it cannot end
 * the following. Going down, such as the jump to the latest message animating, never does either.
 */
export const wentUp = (before: Report | null, now: Report) => before !== null && now.content >= before.content && now.y < before.y - 1;

/** What the jump arrow shows: nothing, the arrow, or the arrow marked because a card needs the person's answer. */
export type ArrowLevel = 'none' | 'away' | 'answer';

/** Whether the jump arrow shows, as a small store: the reader has scrolled up, and a card that needs an answer marks it. */
export type AwayStore = {
  get: () => ArrowLevel;
  subscribe: (listener: () => void) => () => void;
  setAway: (value: boolean) => void;
  setWaiting: (waiting: string) => void;
};
export function createAwayStore(waiting = ''): AwayStore {
  const state = { away: false, waiting };
  const listeners = new Set<() => void>();
  const level = (): ArrowLevel => (!state.away ? 'none' : state.waiting === '' ? 'away' : 'answer');
  const set = (patch: Partial<typeof state>) => {
    const before = level();
    Object.assign(state, patch);
    if (level() !== before) for (const listener of [...listeners]) listener();
  };
  return {
    get: level,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setAway: (value) => set({ away: value }),
    setWaiting: (value) => set({ waiting: value }),
  };
}

/**
 * `waiting` names the cards that need the person's answer (empty when none). A card never moves a reader who left the end, as
 * nothing does (Claude for iOS: once you scroll away the view stays); the down-arrow says an answer is waiting (`answer`), so the
 * card is not missed.
 */
export function useFollowEnd(reset: string, waiting = '') {
  const ref = useRef<ComponentRef<typeof ScrollView>>(null);
  // Reduce Motion: the pin and the jump move the view without animating
  const reduced = { current: useReducedMotion() };
  const following = useRef(true);
  // a finger is on the list: the view is the reader's, and nothing the chat does moves it
  const touching = useRef(false);
  const last = useRef<Report | null>(null);
  // whether the jump arrow shows is kept outside this screen's render: it moves with every scroll report, and drawing the whole chat for it
  // cost two runs of the screen per report; only the arrow subscribes (`awayStore`)
  const store = useRef<AwayStore | null>(null);
  store.current ??= createAwayStore(waiting);
  const away = store.current;
  const setAway = away.setAway;
  // the chat moved the view of a reader who is away (the content got shorter): the next report is the view's new place, not the reader coming back
  const clamped = useRef(false);
  // the reader left a pinned message: the pin no longer puts the view back to it
  const released = useRef(false);
  // a sent message pins: nothing is followed, the new message is scrolled to the top once, and room is kept under it
  const pinned = useRef(false);
  const pending = useRef<number | null>(null);
  const size = useRef({ content: 0, view: 0, y: 0 });
  const target = useRef(0);
  // the pinned scroll waits until the room under the message is part of the content, or the native view clamps it
  const scrollPending = useRef(false);
  // the bubble has told where it sits once: only a small correction of that place is followed after it
  const anchored = useRef(false);
  const [reserve, setReserve] = useState<number | undefined>(undefined);
  // a chat opened: its runs stay React text until the first screens are still (#5369). Before its rows render, so none of them is drawn natively first.
  useMemo(() => {
    void reset;
    nativeGate.open();
  }, [reset]);
  // a run measures itself against the list's content (see nativeGate.attach)
  useEffect(() => nativeGate.attach(() => (ref.current as { getInnerViewRef?: () => unknown } | null)?.getInnerViewRef?.() ?? null), []);
  const follow = useCallback(
    (value: boolean) => {
      following.current = value;
      pinned.current = false;
      pending.current = null;
      scrollPending.current = false;
      anchored.current = false;
      released.current = false;
      clamped.current = false;
      setAway(!value);
    },
    [setAway],
  );
  useEffect(() => {
    void reset;
    last.current = null;
    touching.current = false;
    setReserve(undefined);
    follow(true);
  }, [reset, follow]);
  // growth of a chat the reader is following (a streaming reply, with nothing sent) is followed at once, unless a finger is on the list: the reader's own move wins
  // `echo`: the caller is the list's own report (a lift, a momentum end). The list answers every scrollToEnd with a scroll report and a momentum end, even
  // from the end itself, so asking again from where the list already is would make it answer itself in a loop that never lets a touch through (#5351)
  const toEnd = (echo = false) => {
    if (following.current && !touching.current && !(echo && atEnd(size.current))) ref.current?.scrollToEnd({ animated: false });
  };
  // a pinned chat is "away" while the reply runs past the fold, and not once it fits or the reader scrolled down to it
  const measure = () => setAway(!atEnd({ y: size.current.y, content: size.current.content, view: size.current.view }));
  // the viewport must show content: past the end, back to the end of what is drawn
  // `shrunk`: the content just got shorter, which no finger did, so not even a bounce's worth of blank is left
  const clamp = (shrunk = false) => {
    // the pin waiting for the room under it (a view that grew before the room did) is a place the content is about to reach
    if (scrollPending.current) return false;
    // a followed view with no finger on it has no bounce to leave room for
    const idle = following.current && !touching.current && !pinned.current;
    const to = shrunk ? clampOffset(size.current, 0) : idle ? clampOffset(size.current, 0, IDLE_BLANK) : clampOffset(size.current);
    if (to === null) return false;
    size.current.y = to;
    last.current = null;
    clamped.current = !following.current;
    ref.current?.scrollTo({ y: to, animated: false });
    return true;
  };
  // a chat that opens and is followed to its end may never send a scroll report (the list has nothing to scroll, or is already where it is told to be), and the native-text
  // gate would not know where its window stands: the window of a followed list is its end, from the sizes the list reported (a report, when one comes, replaces this)
  const seedWindow = () => {
    const { content, view } = size.current;
    if (!nativeGate.viewport() && following.current && view > 0) nativeGate.view(Math.max(0, content - view), view);
  };
  const grown = (height?: number) => {
    const shrunk = height !== undefined && height < size.current.content;
    if (height !== undefined) size.current.content = height;
    seedWindow();
    clamp(shrunk);
    if (pending.current !== null && height !== undefined && height > pending.current) {
      target.current = Math.max(0, pending.current - PIN_INSET);
      pending.current = null;
      scrollPending.current = true;
      setReserve(target.current + size.current.view);
    }
    if (scrollPending.current && size.current.content >= target.current + size.current.view - 1) {
      scrollPending.current = false;
      // the sent bubble carries the motion (it rises from the composer), so the list itself does not glide under it
      ref.current?.scrollTo({ y: target.current, animated: false });
      // that is where the view will be: the guard must not read the offset it reported before it
      size.current.y = target.current;
    }
    // a reader who is not following is where they left themselves: the arrow follows the distance, the view does not move
    if (pinned.current || !following.current) measure();
    else toEnd();
  };
  useEffect(() => away.setWaiting(waiting), [waiting, away]);
  // The view is laid out at its new height while the keyboard still slides, and the native view scrolls to the end of the
  // height it has at that moment; once the keyboard is done the end is where the last messages are.
  const settled = useRef(toEnd);
  settled.current = toEnd;
  useEffect(() => {
    const events: Parameters<typeof Keyboard.addListener>[0][] = ['keyboardDidShow', 'keyboardDidHide'];
    // iOS also reports the keyboard growing a suggestion bar
    if (Platform.OS === 'ios') events.push('keyboardDidChangeFrame');
    const subscriptions = events.map((name) => Keyboard.addListener(name, () => settled.current()));
    return () => subscriptions.forEach((s) => s.remove());
  }, []);
  const again = useRef(grown);
  again.current = grown;
  // the sent bubble reports where it really sits in the content, which beats the height measured before it landed (a row above
  // it can change in between); the message is scrolled back under the nav bar whenever that place moves
  useEffect(
    () =>
      watchSentTop((y, refine) => {
        if (!pinned.current || released.current || (refine && !anchored.current)) return;
        const next = Math.max(0, y - PIN_GAP);
        // the outbox bubble is drawn after the rows: a reply that grows above it pushes it down, and the message must not be dragged after it.
        // Rows that go away above it (older pages dropped when the chat is read again) move it up by any amount, and the room kept under it
        // must follow, or the view is left at a place past the rows that are left
        if (anchored.current && next - target.current > REPIN_SLACK) return;
        anchored.current = true;
        if (!scrollPending.current && next === target.current && pending.current === null) return;
        target.current = next;
        pending.current = null;
        scrollPending.current = true;
        setReserve(next + size.current.view);
        again.current();
      }),
    [],
  );
  return {
    ref,
    /** True when the reader has scrolled up, so the jump control shows. */
    get away() {
      return away.get() !== 'none';
    },
    /** A card needs the person's answer while the reader is away from the end: the arrow says so. */
    get answer() {
      return away.get() === 'answer';
    },
    /** What the arrow subscribes to: the same answer, as a store, so a scroll report draws the arrow and not the chat. */
    awayStore: away,
    /** Room kept under a pinned message (the content's minimum height), so it can reach the top of a short chat. */
    reserve,
    /** A message was just sent: the next growth scrolls it to the top under the nav bar, and the reply below it is not followed. */
    pin: (text?: string) => {
      if (text !== undefined) launchRise(text);
      follow(false);
      setAway(false);
      touching.current = false;
      pinned.current = true;
      pending.current = size.current.content;
    },
    /** Scrolls to the newest message and follows again. */
    jump: () => {
      touching.current = false;
      nativeGate.open();
      follow(true);
      seedWindow();
      setReserve(undefined);
      ref.current?.scrollToEnd({ animated: !reduced.current });
    },
    /** Props for the ScrollView. */
    props: {
      // while a finger is down the chat does not scroll the view; a lift with speed leaves the view to its momentum until it stops, a lift without catches up at once
      onScrollBeginDrag: () => {
        touching.current = true;
        nativeGate.activity();
      },
      onScrollEndDrag: (event?: { nativeEvent?: { velocity?: { y?: number } } }) => {
        if (event?.nativeEvent?.velocity?.y) return;
        touching.current = false;
        toEnd(true);
      },
      onMomentumScrollEnd: () => {
        touching.current = false;
        toEnd(true);
      },
      onScroll: (event: Scrolled) => {
        nativeGate.activity();
        const now = reportOf(event);
        if (!now) return;
        nativeGate.view(now.y, now.view);
        size.current = { content: now.content, view: now.view, y: now.y };
        // the report is of the blank place: not a reader's move, so it says nothing about following
        if (clamp()) return;
        // content that got shorter moved the view to its end (the chat's clamp, or the native view's): the view stands there, but a reader who did not scroll down to it has not come back
        const moved = clamped.current;
        clamped.current = false;
        const shorter = moved || (last.current !== null && now.content < last.current.content && now.y <= last.current.y);
        if (pinned.current) {
          // a finger moving up leaves the pinned message: the pin does not pull the view back to it
          if (touching.current && wentUp(last.current, now)) {
            released.current = true;
            pending.current = null;
            scrollPending.current = false;
          }
          measure();
        } else if (touching.current && wentUp(last.current, now) && now.y < now.content - now.view - 1) {
          // a finger moving up leaves at once, however near the end it started (a bounce back from past the end is not "up")
          follow(false);
          setAway(!atEnd(now));
        } else if (atEnd(now)) {
          if (shorter && !following.current) setAway(false);
          else follow(true);
        } else if (wentUp(last.current, now)) follow(false);
        last.current = now;
      },
      onContentSizeChange: (_w?: number, h?: number) => grown(h),
      // the keyboard shrinks the view: the end stays in sight, or a pinned message keeps its room
      onLayout: (event?: { nativeEvent?: { layout?: { height?: number } } }) => {
        const height = event?.nativeEvent?.layout?.height;
        if (height !== undefined) {
          const before = size.current.view;
          size.current.view = height;
          seedWindow();
          // the view grew or shrank (the keyboard): the room under the message follows it, and the message goes back to the top
          // once the content has caught up, since the native view clamps its offset when it grows
          if (pinned.current && !released.current && pending.current === null && height !== before) {
            scrollPending.current = true;
            setReserve(target.current + height);
          }
          clamp();
        }
        if (pinned.current) measure();
        else toEnd();
      },
    },
  };
}
