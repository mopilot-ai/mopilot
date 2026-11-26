// The keyboard's slide as the chat's JS side sees it (#5686): when it holds the clamp and the end-follow off, when the layouts that come in every frame of it wait for its end, and which offsets are the lift's own.
import { useMemo, useRef } from 'react';

/** How far (points) from the offsets a lift takes the view a report may be and still be the lift's. */
export const BAND_SLACK = 40;
export type Slide = {
  /** A reader the lift moves is under it until this time (ms): the clamp and the end-follow stay out of its way. */
  until: number;
  /** The keyboard moved while a finger was down, and the lift catches up with it. */
  owed: boolean;
  /** The keyboard moves the frame, whoever is looking, until this time: its layouts wait for the end. */
  layoutUntil: number;
  /** The offsets from where a lift began to where it goes: a report between them is the lift's own. */
  band: [number, number] | null;
  /** The height the view has with no keyboard (the view plus the lift) as it stood when the slide began: the room under a pinned message is made for it, whichever event comes first. */
  fullView: number;
};

export function useSlide() {
  const slide = useRef<Slide>({ until: 0, owed: false, layoutUntil: 0, band: null, fullView: 0 });
  return useMemo(
    () => ({
      slide,
      /** The slide is over. */
      end: () => {
        slide.current.until = slide.current.layoutUntil = slide.current.fullView = 0;
      },
      sliding: () => Date.now() < slide.current.until,
      layoutHeld: () => Date.now() < slide.current.layoutUntil,
      inBand: (y: number) => !!slide.current.band && y >= slide.current.band[0] - BAND_SLACK && y <= slide.current.band[1] + BAND_SLACK,
    }),
    [],
  );
}
