// What the keyboard's announcements mean for the chat's JS side (#5686): the view is not moved here (the UI thread does that, frame by frame, see useChatLift); the clamp and the end-follow stay out of the lift's way until it is over, and the residual is settled.
import { type MutableRefObject, useEffect, useRef } from 'react';
import { Dimensions, Keyboard, Platform } from 'react-native';
import { perf } from '../perfLog';
import { type KeyboardFrame, KEYBOARD_MARGIN, covered } from './followMath';
import type { Slide } from './useSlide';

/** What the keyboard says it is about to do: its frame before and after, and how long it takes. */
type KeyboardGives = { duration?: number; startCoordinates?: KeyboardFrame; endCoordinates?: KeyboardFrame };

/**
 * The keyboard's height changed (it opened, closed, or grew a candidate bar). Nothing moves for a reader who is not at the end; with a finger down the change is owed to the lift.
 * While it slides the clamp, the layout's follow and the end-follow stay out of its way; a deadline settles the residual whether or not the keyboard reports its end, and the
 * settle takes a following reader to the end itself, however the lift went. The room under a sent message is made for the view with no keyboard, so the native view never clamps the reader's place whichever way the keyboard goes.
 */
export function useKeyboardFollow(o: {
  following: MutableRefObject<boolean>;
  pinned: MutableRefObject<boolean>;
  touching: MutableRefObject<boolean>;
  disarm: () => void;
  slide: MutableRefObject<Slide>;
  /** Where the view stands now, and how tall it is. */
  measure: () => { y: number; view: number };
  /** What the keyboard and the composer can still give back to the view now: the frame's lift and the composer's height over one line. */
  lift: () => number;
  /** The slide is over. */
  endSlide: () => void;
  /** The residual: the end, brought back over a moment. */
  settle: () => void;
}) {
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(o);
  latest.current = o;
  useEffect(() => {
    const now = () => latest.current;
    const clearDeadline = () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = null;
    };
    const track = (event?: KeyboardGives) => {
      perf.event('keyboard-announced');
      const c = now();
      const by =
        covered(event?.endCoordinates, Dimensions.get('window').height) - covered(event?.startCoordinates, Dimensions.get('window').height);
      // counted by why it moved nothing, so a device run says whether the lift was asked for
      const skip = (why: string) => perf.event(`keyboard-skip-${why}`);
      if (by === 0) return skip('same');
      // the keyboard lifts the app's frame whoever is looking at the chat: the layouts that come in every frame of it wait for its end, and its deadline settles them
      const wait = (event?.duration ?? 250) + KEYBOARD_MARGIN;
      const slide = c.slide.current;
      const going = Date.now() < slide.layoutUntil;
      slide.layoutUntil = Date.now() + wait;
      // the view with no keyboard, as it stands when the slide begins: the room under a pinned message is made for it, so it is right whichever event comes first and the view never outgrows it
      if (!going) slide.fullView = c.measure().view + c.lift();
      clearDeadline();
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        now().endSlide();
        now().settle();
      }, wait);
      // a send's pin ends the following, so a pinned view says it is pinned before it says it is away
      if (c.pinned.current) return skip('pinned');
      if (!c.following.current) return skip('away');
      if (c.touching.current) {
        slide.owed = true;
        return skip('finger');
      }
      // the reader the lift moves: the clamp and the end-follow stay out of its way, and the offsets it takes the view between are its own
      const held = Date.now() < slide.until;
      slide.until = Date.now() + wait;
      const y = c.measure().y;
      const next: [number, number] = [Math.min(y, y + by), Math.max(y, y + by)];
      // a second announcement in the middle of a slide (a candidate bar, a repeated frame) keeps the offsets of the first as the lift's own
      slide.band = held && slide.band ? [Math.min(slide.band[0], next[0]), Math.max(slide.band[1], next[1])] : next;
    };
    const events: Parameters<typeof Keyboard.addListener>[0][] = ['keyboardDidShow', 'keyboardDidHide'];
    // iOS also reports the keyboard growing a suggestion bar, and says when it starts to move
    if (Platform.OS === 'ios') events.push('keyboardDidChangeFrame');
    const subscriptions = events.map((name) =>
      Keyboard.addListener(name, () => {
        // the keyboard coming up is the reader typing: the pin of the last send is over
        if (name === 'keyboardDidShow') now().disarm();
        now().endSlide();
        clearDeadline();
        now().settle();
      }),
    );
    // iOS says when the keyboard starts to come up, which is when the pin of the last send ends (the did event comes a slide later; Android has only that one)
    if (Platform.OS === 'ios') {
      subscriptions.push(Keyboard.addListener('keyboardWillShow', () => now().disarm()));
      // every change of the keyboard's height (open, close, the candidate bar) is announced here once; willShow and willHide say the same thing again
      subscriptions.push(Keyboard.addListener('keyboardWillChangeFrame', (event?: KeyboardGives) => track(event)));
    }
    return () => {
      subscriptions.forEach((s) => s.remove());
      clearDeadline();
    };
  }, []);
}
