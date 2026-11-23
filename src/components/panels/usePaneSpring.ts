// The side pane's width spring, driven from script so an open or a close can be reversed mid-way without a jump.
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { PANE_SPRING_MS, paneCurve, paneKeyframes, prefersReducedMotion, type PaneCurve } from '../../lib/paneMotion';

/** The spring playing (or last played) on the pane. */
type Motion = { open: boolean; curve: PaneCurve; start: number; anim: Animation };

/**
 * Springs the pane's width as the Codex app's right panel does: open from 0 when it mounts, shut to 0 when it
 * leaves. Reopened (or closed again) mid-way, the new spring starts from the width and speed the edge has at that
 * moment, where a CSS animation restarts from its far end. A new width while it opens (the pane measuring its lane
 * right after mounting, a drag, a resize) retargets the spring the same way. The full view fades in CSS instead,
 * coming back from it does not replay the open, and with reduced motion nothing moves.
 */
export function usePaneSpring(ref: RefObject<HTMLElement | null>, leaving: boolean, width: number, full: boolean): () => void {
  const motion = useRef<Motion | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    const first = !mounted.current;
    mounted.current = true;
    const m = motion.current;
    if (!el || full || prefersReducedMotion() || typeof el.animate !== 'function') {
      m?.anim.cancel();
      motion.current = null;
      return;
    }
    const open = !leaving;
    const elapsed = m ? performance.now() - m.start : Number.POSITIVE_INFINITY;
    const running = elapsed < PANE_SPRING_MS;
    // the same direction: nothing to do, unless the width changed while opening (the pane measuring its lane just
    // after it mounts, a drag or a resize), which the spring heads for from where it is, as Framer retargets
    if (m?.open === open && !(open && running && m.curve.to !== width)) return;
    // back from full view: the pane is already open
    if (!m && open && !first) return;
    const from = running ? m!.curve.at(elapsed) : first && open ? 0 : el.getBoundingClientRect().width;
    const velocity = running ? m!.curve.velocity(elapsed) : 0;
    m?.anim.cancel();
    const curve = paneCurve(from, open ? width : 0, velocity);
    // closing holds 0 until the pane unmounts; opened, the pane's own width (and any drag) applies again
    const anim = el.animate(
      paneKeyframes(curve).map((w) => ({ width: `${w}px` })),
      { duration: PANE_SPRING_MS, fill: open ? 'none' : 'forwards' },
    );
    motion.current = { open, curve, start: performance.now(), anim };
  }, [ref, leaving, width, full]);
  // a drag of the edge takes over from an open still under way: its animated width would hide the drag's (#2049)
  return () => {
    const m = motion.current;
    if (!m?.open) return;
    m.anim.cancel();
    m.start = Number.NEGATIVE_INFINITY;
  };
}
