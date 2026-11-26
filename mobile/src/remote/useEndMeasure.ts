// Where a chat's content really ends while the room under a sent message dominates its height (#5686): the arrow and the end test read that, not the blank.
import { type MutableRefObject, useCallback, useMemo, useRef } from 'react';
import { perf } from '../perfLog';
import { type Report, atEnd } from './followMath';

/** The container's padding under the last row: the end marker's top is this far above where the content ends. */
const MARKER_TO_END = 16;
/** The list's gap between rows: the end marker, a row of its own, cancels it, so it costs no space under the last row. */
const LIST_GAP = 8;
/**
 * How far (points) the content may stand over the room and still be the room: the list reports its content on the pixel grid, the room is made from float layout values, so the
 * two differ by a hair (device, #5693: 1314.6667 against 1314.66666); only more than this is a reply outgrowing the room.
 */
const ROOM_SLACK = 1;
/** The end marker's style: a direct last child (the list counts its children) that is no taller than nothing and takes none of the gap. */
export const END_MARKER = { height: 0, marginTop: -LIST_GAP } as const;

/**
 * The content height to measure the end against. With the room under a sent message dominating the content's height (made for the view with no keyboard, so with the keyboard up it
 * is `lift` points more than the view needs), what counts is where the rows end, when the end marker has said, and else what the room would have been for the view as it is.
 */
export const realContent = (o: { content: number; room: number | undefined; natural: number | null; target: number; view: number }) => {
  if (o.room === undefined || o.content > o.room + ROOM_SLACK) return o.content;
  return Math.min(o.content, o.natural ?? o.target + o.view);
};

type Scroller = { scrollTo: (o: { y: number; animated: boolean }) => void; scrollToEnd: (o: { animated: boolean }) => void } | null;

export function useEndMeasure(o: {
  /** The chat's lift: the list to scroll and where the UI thread is told the view's place. */
  lift: { ref: MutableRefObject<Scroller>; publish: (geometry: { y: number; content: number; view: number }) => void };
  size: MutableRefObject<Report>;
  reserved: MutableRefObject<number | undefined>;
  target: MutableRefObject<number>;
  setAway: (away: boolean) => void;
  /** A sent message is on its way to its pinned place (the view will be moved there): the arrow waits for it. */
  placing: () => boolean;
  /** The rows' end moved while the room dominates the content: no growth of the content says so, so this does. */
  rowsMoved: () => void;
  /** The view a keyboard's slide ends at, for a pinned reader while it slides (0 otherwise): the arrow judges the place the view is growing into, not a frame of the close. */
  settled: () => number;
  /** What the arrow's decision rests on besides the sizes (the pin's state), for the performance log only. */
  state: () => Record<string, number | boolean | null>;
}) {
  const { size, reserved, target, setAway, placing } = o;
  // the caller's function is a new one every render: the marker's props must not be
  const moved = useRef(o.rowsMoved);
  moved.current = o.rowsMoved;
  const state = useRef(o.state);
  state.current = o.state;
  const settled = useRef(o.settled);
  settled.current = o.settled;
  const list = o.lift.ref;
  const tell = o.lift.publish;
  const natural = useRef<number | null>(null);
  /** A report with its content as far as the rows go: the one definition of the end wherever a reader's place is judged (the native view may still reach the padded content). */
  const real = useCallback(
    (r: Report): Report => ({
      ...r,
      content: realContent({ content: r.content, room: reserved.current, natural: natural.current, target: target.current, view: r.view }),
    }),
    [reserved, target],
  );
  /** What the UI thread needs of where the view stands: the content as far as the rows go, so that a reader at the end of the rows is a reader at the end. */
  const publish = useCallback(
    () => tell({ y: size.current.y, content: real(size.current).content, view: size.current.view }),
    [tell, size, real],
  );
  const endMarker = useMemo(
    () => ({
      style: END_MARKER,
      onLayout: (event?: { nativeEvent?: { layout?: { y?: number } } }) => {
        const y = event?.nativeEvent?.layout?.y;
        natural.current = y === undefined ? null : y + MARKER_TO_END;
        if (size.current.content <= (reserved.current ?? 0)) moved.current();
      },
    }),
    [size, reserved],
  );
  return {
    real,
    publish,
    /** Whether the jump arrow shows: the distance to where the rows end. */
    measure: useCallback(() => {
      const r = real(size.current);
      const view = Math.max(r.view, settled.current());
      const away = !placing() && !atEnd({ ...r, view });
      // each decision, frame by frame, while the performance log is on: a flash of the arrow on the device is read from these lines
      if (perf.enabled) {
        const [room, end] = [reserved.current ?? null, natural.current];
        perf.note('arrow', {
          y: r.y,
          end: r.content,
          content: size.current.content,
          view: r.view,
          judged: view,
          room,
          natural: end,
          away,
          ...state.current(),
        });
      }
      setAway(away);
    }, [real, size, setAway, placing, reserved]),
    /** Scrolls to where the rows end, not to the blank the room adds under them. */
    toRealEnd: useCallback(
      (animated: boolean) => {
        const r = real(size.current);
        if (r.content < size.current.content) list.current?.scrollTo({ y: Math.max(0, r.content - r.view), animated });
        else list.current?.scrollToEnd({ animated });
      },
      [real, size, list],
    ),
    /** What to spread on the zero-height view that is the last child of the list: where it sits says where the rows end. */
    endMarker,
    /** A chat opened: the rows of the one before are not these. */
    forget: useCallback(() => {
      natural.current = null;
    }, []),
  };
}
