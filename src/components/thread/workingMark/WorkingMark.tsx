// The working mark: Claude Code's 20px clay animation beside a running activity line, a different motion per kind of work.
import { useLayoutEffect, useRef, useState } from 'react';
import { MarkPlayer, markClock } from './markPlayer';
import { restFrame, type MarkActivity } from './markStages';
import { MARK_SIZE, MarkView, canAnimate, preloadSheets } from './markView';
import { prefersReducedMotion } from '../../../lib/paneMotion';

/**
 * The mark for an activity; it finishes the motion it is in before it changes to the next activity's. Each stage steps
 * its strip on the compositor and the mark looks again only when the stage changes, so a playing mark never re-renders
 * the line around it and a busy main thread never stalls it. A `standalone` mark (the scroll button's) picks up the
 * motion of a mark on screen but is never picked up by another.
 */
export function WorkingMark({ activity, standalone = false }: { activity: MarkActivity; standalone?: boolean }) {
  const root = useRef<HTMLSpanElement>(null);
  const view = useRef<MarkView | null>(null);
  // with reduced motion, or where nothing can step the strip, the mark holds its activity's rest frame
  const [still] = useState(() => prefersReducedMotion() || !canAnimate());
  const wanted = useRef(activity);
  wanted.current = activity;
  // the playing mark's look at what plays now, for an activity that changes between its stage changes
  const look = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    view.current ??= new MarkView(root.current as HTMLSpanElement);
    if (still) view.current.still(`${activity}.loop`, restFrame(activity));
    else look.current?.();
  }, [still, activity]);

  useLayoutEffect(() => {
    if (still) return;
    preloadSheets();
    const shown = view.current as MarkView;
    // made here, after the line this one replaces has left in the same commit, so it can pick up that mark
    const player = new MarkPlayer(wanted.current, markClock.now(), { standalone });
    let cancel: () => void = () => undefined;
    const tick = () => {
      cancel();
      const now = markClock.now();
      player.want(wanted.current, now);
      shown.show(player.frame(now), wanted.current);
      const wait = player.nextChangeMs(now);
      cancel = Number.isFinite(wait) ? markClock.after(wait, tick) : () => undefined;
    };
    look.current = tick;
    tick();
    // a fresh mark starts as a dot: keep one under it until its strip has painted (two frames, as Claude does)
    let dotGone: () => void = () => undefined;
    if (player.fresh) {
      shown.setDot(true);
      dotGone = markClock.after(0, () => {
        dotGone = markClock.after(0, () => shown.setDot(false));
      });
    }
    return () => {
      cancel();
      dotGone();
      look.current = null;
      shown.stop();
      shown.setDot(false);
      player.leave(markClock.now());
    };
  }, [still, standalone]);

  return <span ref={root} className="working-mark" data-activity={activity} style={{ width: MARK_SIZE, height: MARK_SIZE }} aria-hidden />;
}
