// Keeps a chat at its newest message on open, pins a sent message under the nav bar like Claude for iOS (the reply grows below it and the view stays still, with a down-arrow once the reply passes the fold), and leaves a reader who scrolled up where they are.
import { type ComponentRef, type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Keyboard, type ScrollView } from 'react-native';
import { nativeGate } from '../presentation/nativeGate';
import { perf } from '../perfLog';
import { type AwayStore, createAwayStore } from './awayStore';
import { useKeyboardFollow } from './useKeyboardFollow';
import { useEndMeasure } from './useEndMeasure';
import { useSlide } from './useSlide';
import { useChatLift } from './useChatLift';
import {
  type Report,
  type Scrolled,
  atEnd,
  atRest,
  clampOffset,
  fingersAfterStart,
  GLIDE_SILENCE,
  IDLE_BLANK,
  MOVE_KEEPALIVE,
  PIN_WINDOW,
  reportOf,
  TOUCH_SILENCE,
  wentUp,
} from './followMath';
export * from './followMath';
import { useReducedMotion } from 'react-native-reanimated';
import { launchRise } from '../sendOrigin';
import { useRoomView } from './useRoomView';
import { PIN_ECHO, usePinEcho } from './usePinEcho';
import { useSentTop } from './useSentTop';
export { PIN_GAP, REPIN_SLACK } from './useSentTop';

/** A move of the view this large (points) with no finger and no scroll of the chat's own behind it is counted as a native shift. */
const NATIVE_SHIFT = 4;
/** Where a pinned message sits below the top of the view: the content's own bottom padding is 16, the new message starts one 8 gap later, and it rests 8 under the nav bar. */
export const PIN_INSET = 16;
/** A touch event as far as the hook reads it: how many fingers it began or ended. */
type Touched = { nativeEvent?: { changedTouches?: readonly unknown[]; touches?: readonly unknown[] } };

export { type AwayStore, type ArrowLevel, createAwayStore } from './awayStore';

/**
 * `waiting` names the cards that need the person's answer (empty when none). A card never moves a reader who left the end, as
 * nothing does (Claude for iOS: once you scroll away the view stays); the down-arrow says an answer is waiting (`answer`), so the
 * card is not missed.
 */
export function useFollowEnd(reset: string, waiting = '', onRest?: () => void) {
  // the keyboard moves the view of a reader at the end on the UI thread, frame by frame (useChatLift): the list's ref is the one it scrolls by, and what it needs to know of the chat is kept in step
  const lift = useChatLift();
  const ref = lift.ref as MutableRefObject<ComponentRef<typeof ScrollView> | null>;
  const reduced = { current: useReducedMotion() };
  const following = lift.following;
  // a finger is on the list: the view is the reader's, and nothing the chat does moves it. A finger that only rests counts (a long press to select words, a hand on the screen), not only one that drags.
  const touching = lift.touching;
  // how many fingers are down (the touch events say how many are left), and whether the view is moving under the reader (a drag, or the glide after a lift with speed): the view is the reader's while either holds, whatever order the touch and scroll events come in (a finger put down on a gliding list ends the glide with a finger still down)
  const fingers = useRef(0);
  const moving = useRef(false);
  const glideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // when the silence timer was last started: a finger's moves keep it alive without starting a timer for every frame
  const touchWatchedAt = useRef(0);
  // the keyboard slides until `until`; `owed`: it moved while a finger was down, and the lift catches up with it (see useKeyboardFollow)
  const { slide, sliding, layoutHeld, inBand, end: endSlide } = useSlide();
  // which touch each drag came from (a newer one: the drag's finger may still be down)
  const touchSeq = useRef(0);
  const dragSeq = useRef(0);
  // the fingers the latest touch began: a drag ends with the one that made it, not with one that only rests
  const lastStart = useRef(1);
  const restingAtDrag = useRef(0);
  const rest = useRef(onRest);
  rest.current = onRest;
  const last = useRef<Report | null>(null);
  // whether the jump arrow shows is kept outside this screen's render (a scroll report must not draw the chat): only the arrow subscribes (`awayStore`)
  const store = useRef<AwayStore | null>(null);
  store.current ??= createAwayStore(waiting);
  const away = store.current;
  const setAway = away.setAway;
  // the chat moved the view of a reader who is away (the content got shorter): the next report is the view's new place, not the reader coming back
  const clamped = useRef(false);
  // the reader left a pinned message: the pin no longer puts the view back to it
  const released = useRef(false);
  // a sent message pins: nothing is followed, the new message is scrolled to the top once, and room is kept under it
  const pinned = lift.pinned;
  const pending = useRef<number | null>(null);
  const size = useRef({ content: 0, view: 0, y: 0 });
  const target = useRef(0);
  // the pin's own scroll: until it lands, the list reports the way to it
  const echo = usePinEcho(size, target);
  const { roomView, giveBack, sent } = useRoomView({ size, slide, layoutHeld, pinned, lift: lift.lift });
  // the pinned scroll waits until the room under the message is part of the content, or the native view clamps it
  const scrollPending = useRef(false);
  // the bubble has told where it sits once: only a small correction of that place is followed after it
  const anchored = useRef(false);
  const [reserve, setReserve] = useState<number | undefined>(undefined);
  // the room kept under a pinned message, read back without a render
  const reserved = useRef<number | undefined>(undefined);
  const room = useCallback((value: number | undefined) => {
    reserved.current = value;
    setReserve(value);
  }, []);
  // the rows' end moved inside the room (the content does not grow): the arrow and the end-follow answer it as they answer growth
  const ends = {
    // a sent message on its way to its pinned place, or the pin's scroll not landed yet (the list still reports the old end): the arrow waits for the view to get there
    placing: () => pinned.current && (pending.current !== null || scrollPending.current || echo.landing()),
    rowsMoved: () => (publish(), pinned.current || !following.current ? measure() : toEnd(true, false, 'rows')),
    settled: () => (pinned.current && layoutHeld() ? slide.current.fullView : 0),
    state: () => ({ pinned: pinned.current, pending: pending.current, scrollPending: scrollPending.current, ...echo.state() }),
  };
  const { measure, publish, endMarker, forget, real, toRealEnd } = useEndMeasure({ lift, size, reserved, target, setAway, ...ends });
  // a send's pin is live: until it ends, the rows around the message do not move it (maintainVisibleContentPosition is off)
  const [armed, setArmedState] = useState(false);
  const armedNow = useRef(false);
  // a state set to what it is still draws the screen once: only a change is set
  const setArmed = useCallback((value: boolean) => {
    if (armedNow.current === value) return;
    armedNow.current = value;
    setArmedState(value);
  }, []);
  const pinnedAt = useRef(0);
  // a chat opened: its runs stay React text until the first screens are still (#5369). Before its rows render, so none of them is drawn natively first.
  useMemo(() => {
    void reset;
    nativeGate.open();
  }, [reset]);
  // a run measures itself against the list's content (see nativeGate.attach)
  useEffect(() => nativeGate.attach(() => (ref.current as { getInnerViewRef?: () => unknown } | null)?.getInnerViewRef?.() ?? null), [ref]);
  const follow = useCallback(
    (value: boolean) => {
      following.current = value;
      pinned.current = false;
      pending.current = null;
      scrollPending.current = false;
      anchored.current = false;
      released.current = false;
      clamped.current = false;
      setArmed(false);
      setAway(!value);
    },
    [setAway, setArmed, following, pinned],
  );
  const left = useCallback(() => !following.current, [following]);
  // the pin ends for good: the sent message stays, the room under it stays as room, and nothing the chat does moves the view
  const disarm = useCallback(() => {
    if (!pinned.current) return;
    pinned.current = false;
    pending.current = null;
    scrollPending.current = false;
    anchored.current = false;
    released.current = false;
    setArmed(false);
  }, [setArmed, pinned]);
  // whether the pin is still live: a pin older than PIN_WINDOW has had its time
  const pinLive = useCallback(() => {
    if (pinned.current && Date.now() - pinnedAt.current > PIN_WINDOW) disarm();
    return pinned.current;
  }, [disarm, pinned]);
  useEffect(() => {
    void reset;
    last.current = null;
    forget();
    touching.current = false;
    fingers.current = 0;
    moving.current = false;
    room(undefined);
    follow(true);
  }, [reset, follow, room, touching, forget]);
  // Every scroll the chat asks of the list is counted by its reason, and so is a move that no call and no finger made: counts only, and only while the performance log is on (Settings > About) (#5686)
  const calledAt = useRef(0);
  const scrolled = (why: string) => {
    calledAt.current = Date.now();
    if (why === 'pin') echo.scrolled();
    perf.event(`scroll-${why}`);
  };
  // growth of a chat the reader is following (a streaming reply, with nothing sent) is followed at once, unless a finger is on the list: the reader's own move wins
  // `echo`: the caller is the list's own report (a lift, a momentum end): the list answers every scrollToEnd with a report and a momentum end, so asking again from the end would loop (#5351); `glide`: the view was resized under the list (the Changes chip, the composer growing a line, the keyboard), not by a reply growing: the end comes back over a moment, not in one frame (#5686)
  const toEnd = (echo = false, glide = false, why = 'growth') => {
    // from the list's own report the end is asked for only when the view is not at it (see `echo`): a view a few points short, from a keyboard that slid or a reply that grew under a finger, is brought the rest of the way
    if (following.current && !touching.current && !sliding() && !(echo && atRest(real(size.current)))) {
      scrolled(why);
      toRealEnd(glide && !reduced.current);
    }
  };
  // the reader let go (a lift, the end of a glide, a touch that never scrolled): at the very end they are following again, and what grew meanwhile is caught up
  const rested = () => {
    // not while a finger is down or the view is still moving: a finger put down on a gliding list holds it, and the glide's end must not let go of that finger
    touching.current = fingers.current > 0 || moving.current;
    if (touching.current) {
      // the last finger went and a glide is all that holds the view: it has to report its end, or fall silent
      if (fingers.current === 0 && !glideTimer.current) watchGlide();
      return;
    }
    if (glideTimer.current) clearTimeout(glideTimer.current);
    glideTimer.current = null;
    if (touchTimer.current) clearTimeout(touchTimer.current);
    touchTimer.current = null;
    // the view was held back from moving to a place inside its content (the clamp waits for the reader): put it there now
    clamp();
    // where the reader stood at their last report: what grew since is not them leaving the end
    if (!following.current && !pinned.current && atRest(real(last.current ?? size.current))) follow(true);
    // a keyboard that moved while the finger was down is caught up over a moment, not in one frame
    toEnd(true, slide.current.owed, 'rest');
    slide.current.owed = false;
    rest.current?.();
  };
  // a glide that never reports its end (the app went away, a gesture was cancelled): the reader let go of it a moment after the last report
  const watchGlide = () => {
    if (glideTimer.current) clearTimeout(glideTimer.current);
    glideTimer.current = setTimeout(() => {
      glideTimer.current = null;
      // a finger that landed on the glide holds the view: its touch end lets go
      if (fingers.current > 0) return;
      moving.current = false;
      rested();
    }, GLIDE_SILENCE);
  };
  // a finger that has sent no touch event for TOUCH_SILENCE is gone: its end was never delivered (its view unmounted under it), and a count that stays above zero would hold the view
  const watchTouches = () => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
    touchWatchedAt.current = Date.now();
    touchTimer.current = setTimeout(() => {
      touchTimer.current = null;
      if (fingers.current === 0) return;
      // a drag's finger is not silent: its moves are the list's own (the native view may take them), so the count is looked at again once the drag is over
      if (moving.current) return watchTouches();
      fingers.current = 0;
      rested();
    }, TOUCH_SILENCE);
  };
  // the app goes to the background: no touch is held any more, whatever the events said before it
  const goneAway = () => {
    fingers.current = 0;
    moving.current = false;
    rested();
  };
  const gone = useRef(goneAway);
  gone.current = goneAway;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') gone.current();
    });
    return () => {
      sub.remove();
      if (glideTimer.current) clearTimeout(glideTimer.current);
      if (touchTimer.current) clearTimeout(touchTimer.current);
    };
  }, []);
  // a pinned chat is "away" while the reply runs past the fold, and not once it fits or the reader scrolled down to it; the viewport must show content: past the end, back to the end of what is drawn; `shrunk`: the content just got shorter, which no finger did, so not even a bounce's worth of blank is left
  const clamp = (shrunk = false) => {
    // the pin waiting for the room under it (a view that grew before the room did) is a place the content is about to reach
    if (scrollPending.current) return false;
    // under a finger, or while it glides, the view is the reader's: the clamp waits for them to let go (`rested`), and a bounce past the end is theirs
    if (touching.current || sliding()) return false;
    // a followed view with no finger on it has no bounce to leave room for
    const idle = following.current && !pinned.current;
    const to = shrunk ? clampOffset(size.current, 0) : idle ? clampOffset(size.current, 0, IDLE_BLANK) : clampOffset(size.current);
    if (to === null) return false;
    size.current.y = to;
    publish();
    last.current = null;
    clamped.current = !following.current;
    scrolled('clamp');
    ref.current?.scrollTo({ y: to, animated: false });
    return true;
  };
  // a chat that opens and is followed to its end may never send a scroll report (the list has nothing to scroll, or is already where it is told to be), and the native-text gate would not know where its window stands: the window of a followed list is its end, from the sizes the list reported (a report, when one comes, replaces this)
  const seedWindow = () => {
    const { content, view } = size.current;
    if (!nativeGate.viewport() && following.current && view > 0) nativeGate.view(Math.max(0, content - view), view);
  };
  const grown = (height?: number) => {
    pinLive();
    const shrunk = height !== undefined && height < size.current.content;
    if (height !== undefined) size.current.content = height;
    publish();
    seedWindow();
    clamp(shrunk);
    if (pending.current !== null && height !== undefined && height > pending.current) {
      target.current = Math.max(0, pending.current - PIN_INSET);
      pending.current = null;
      scrollPending.current = true;
      room(target.current + roomView());
    }
    if (scrollPending.current && size.current.content >= target.current + size.current.view - 1) {
      scrollPending.current = false;
      // the sent bubble carries the motion (it rises from the composer), so the list itself does not glide under it
      scrolled('pin');
      ref.current?.scrollTo({ y: target.current, animated: false });
      // that is where the view will be: the guard must not read the offset it reported before it
      size.current.y = target.current;
      publish();
    }
    // a reader who is not following is where they left themselves: the arrow follows the distance, the view does not move
    if (pinned.current || !following.current) measure();
    else toEnd();
  };
  useEffect(() => away.setWaiting(waiting), [waiting, away]);
  useKeyboardFollow({
    following,
    pinned,
    touching,
    disarm,
    slide,
    measure: () => size.current,
    lift: giveBack,
    endSlide,
    settle: settleKeyboard,
  });
  // the view's height changed: the room under a pinned message follows it, and the end stays in sight
  const layoutOwed = useRef<number | null>(null);
  function laidOut(height: number | undefined, before: number) {
    if (height !== undefined) {
      seedWindow();
      // the view grew or shrank: the room under the message follows it, and the message goes back to the top once the content has caught up, since the native view clamps its offset when it grows
      if (pinned.current && !released.current && pending.current === null && height !== before) {
        scrollPending.current = true;
        room(target.current + roomView());
      } else if (!pinned.current && reserved.current !== undefined && height !== before) {
        // the pin is over: the room under the sent message still follows the view's height, without scrolling
        room(target.current + roomView());
      }
      clamp();
    }
    if (pinned.current) measure();
    else toEnd(false, height !== undefined && height !== before && before > 0, 'layout');
  }
  // the keyboard's lift is over: the layouts that came during it are caught up, and a reader who follows is at the very end, however the lift went
  function settleKeyboard() {
    const before = layoutOwed.current;
    layoutOwed.current = null;
    if (before !== null) laidOut(size.current.view, before);
    // a residual of a few points is closed in one move; a larger one (the lift did not run) over a moment, never in one frame
    toEnd(false, size.current.content - size.current.view - size.current.y > IDLE_BLANK, 'keyboard');
  }
  const again = useRef(grown);
  again.current = grown;
  useSentTop({ pinLive, released, anchored, target, pending, scrollPending, room, roomView, again });
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
    /** A send's pin is live: the rows around the message must not move it, so the list does not anchor to the row being read until it ends. */
    pinArmed: armed,
    /** A message was just sent: the next growth scrolls it to the top under the nav bar, and the reply below it is not followed. */
    pin: (text?: string) => {
      if (text !== undefined) launchRise(text);
      follow(false);
      setAway(false);
      touching.current = false;
      fingers.current = 0;
      moving.current = false;
      sent();
      pinned.current = true;
      pinnedAt.current = Date.now();
      setArmed(true);
      pending.current = size.current.content;
    },
    /** The reader is not at the end (left it, or a sent message is pinned): a read again keeps what is above them. */
    left,
    /** Props for the zero-height last child of the list: where it sits says where the rows end. */
    endMarker,
    /** Scrolls to the newest message and follows again. */
    jump: () => {
      touching.current = false;
      fingers.current = 0;
      moving.current = false;
      nativeGate.open();
      follow(true);
      seedWindow();
      scrolled('jump');
      toRealEnd(!reduced.current);
      room(undefined);
    },
    /** Props for the ScrollView. */
    props: {
      // while a finger is down the chat does not scroll the view; a lift with speed leaves the view to its momentum until it stops, a lift without catches up at once
      onScrollBeginDrag: () => {
        disarm();
        touching.current = true;
        moving.current = true;
        dragSeq.current = touchSeq.current;
        restingAtDrag.current = Math.max(0, fingers.current - lastStart.current);
        nativeGate.activity();
      },
      onScrollEndDrag: (event?: { nativeEvent?: { velocity?: { y?: number } } }) => {
        // the finger that dragged is gone, whatever the touch events said, unless another landed since; a finger that only rests stays counted
        if (touchSeq.current === dragSeq.current) fingers.current = Math.min(fingers.current, restingAtDrag.current);
        // a lift with speed leaves the view to its glide, which has to report its end (or fall silent, see `watchGlide`)
        if (event?.nativeEvent?.velocity?.y) return watchGlide();
        moving.current = false;
        rested();
      },
      onMomentumScrollEnd: () => {
        moving.current = false;
        rested();
      },
      // a finger down, even one that does not move, holds the view. Only the fingers that began on the list count (`changedTouches`, not `touches`, which lists every finger on the screen, the composer's too), so a finger put down on a glide stays counted when the glide ends
      onTouchStart: (event?: Touched) => {
        disarm();
        touching.current = true;
        touchSeq.current += 1;
        lastStart.current = event?.nativeEvent?.changedTouches?.length ?? 1;
        fingers.current = fingersAfterStart(fingers.current, lastStart.current, event?.nativeEvent?.touches?.length);
        watchTouches();
      },
      // a finger that moves is not silent: its moves keep the count (a long drag, or a hold that wanders) from being taken for a lost end
      onTouchMove: () => {
        if (fingers.current > 0 && Date.now() - touchWatchedAt.current > MOVE_KEEPALIVE) watchTouches();
      },
      // a touch that ends on the list also puts the keyboard away (a tap on the messages)
      onTouchEnd: (event?: Touched) => {
        Keyboard.dismiss();
        fingers.current = Math.max(0, fingers.current - (event?.nativeEvent?.changedTouches?.length ?? 1));
        if (fingers.current > 0) watchTouches();
        rested();
      },
      onTouchCancel: (event?: Touched) => {
        fingers.current = Math.max(0, fingers.current - (event?.nativeEvent?.changedTouches?.length ?? 1));
        if (fingers.current > 0) watchTouches();
        rested();
      },
      onScroll: (event: Scrolled) => {
        nativeGate.activity();
        // a glide goes on while it reports
        if (moving.current && fingers.current === 0) watchGlide();
        const now = reportOf(event);
        if (!now) return;
        nativeGate.view(now.y, now.view);
        size.current = { content: now.content, view: now.view, y: now.y };
        publish();
        // the report is of the blank place: not a reader's move, so it says nothing about following
        if (clamp()) return;
        // the keyboard's lift moves the view in every frame of it: a report between where it began and where it goes is the lift's; any other move is the reader's
        if (sliding() && !touching.current && inBand(now.y)) {
          perf.event('scroll-lift');
          last.current = now;
          return;
        }
        // content that got shorter moved the view to its end (the chat's clamp, or the native view's): the view stands there, but a reader who did not scroll down to it has not come back
        const moved = clamped.current;
        clamped.current = false;
        const shorter = moved || (last.current !== null && now.content < last.current.content && now.y <= last.current.y);
        const here = real(now);
        if (pinned.current) {
          // a finger moving up leaves the pinned message: the pin does not pull the view back to it
          if (touching.current && wentUp(last.current, now)) {
            released.current = true;
            pending.current = null;
            scrollPending.current = false;
          }
          measure();
        } else if (wentUp(last.current, now) && now.y < here.content - here.view - 1) {
          // any move up leaves the end, with a finger or without one (a screen reader's scroll, the status bar, a scroll bar), however near the end it started: a bounce back from past the end is not "up". Coming back is the reader's own, at rest (see `rested`), or the arrow.
          follow(false);
          setAway(!atEnd(here));
        } else if (atEnd(here)) {
          if (shorter && !following.current) setAway(false);
          // within reach is not at rest: a reader who stopped a few lines above the end is not followed. With no finger on the list (a glide's frames, a finger's are `touching`, and `rested` decides when they let go) arriving at the very end is coming back
          else if (following.current || (!touching.current && atRest(here))) follow(true);
        }
        // the view moved with no finger behind it: counted as a native shift when no scroll of ours was just made. With the content not shorter and the view the same size it is also the reader's scroll by some means we do not see (a screen reader, a scroll bar): a pin still in its window is over (only the pin's own scroll is an echo)
        if (!touching.current && last.current && Math.abs(now.y - last.current.y) > NATIVE_SHIFT) {
          if (Date.now() - calledAt.current > 600) perf.event('scroll-native-shift');
          if (now.content >= last.current.content && now.view === last.current.view && Date.now() - echo.at.current > PIN_ECHO) disarm();
        }
        last.current = now;
      },
      onContentSizeChange: (_w?: number, h?: number) => grown(h),
      // the keyboard shrinks the view: the end stays in sight, or a pinned message keeps its room
      onLayout: (event?: { nativeEvent?: { layout?: { height?: number } } }) => {
        pinLive();
        const height = event?.nativeEvent?.layout?.height;
        const before = size.current.view;
        if (height !== undefined) {
          size.current.view = height;
          publish();
        }
        // the keyboard lifts the frame in every frame of its slide: the rest of the layout's work waits for its end (see `settleKeyboard`)
        if (layoutHeld()) layoutOwed.current ??= before;
        else laidOut(height, before);
      },
    },
  };
}
