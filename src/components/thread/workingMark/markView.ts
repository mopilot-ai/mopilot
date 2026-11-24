// The working mark on screen, as the Code tab draws it: each sheet a strip of frames behind a 20px window, stepped
// frame to frame by a transform animation the compositor runs, so a busy page never stalls it.
import { ignoring, noteIgnored } from '../../../lib/ignored';
import type { MarkFrame } from './markPlayer';
import { MARK_SHEETS } from './markSheets';
import { CROSSFADE_MS, nextStage, sheetKey, sheetOf, stageRange, type MarkActivity } from './markStages';

/** The mark's size in px. */
export const MARK_SIZE = 20;
/** Opacity that keeps a waiting layer painted (its strip decoded) while it shows nothing, as Claude's does. */
const WARM = '0.001';

interface Layer {
  layer: HTMLElement;
  strip: HTMLElement;
}

/** Translate a strip to show frame `index`. */
export function frameTransform(index: number): string {
  return `translateY(${-index * MARK_SIZE}px)`;
}

/** The keyframes that step a strip through frames [from, to). */
export function frameKeyframes(from: number, to: number): Keyframe[] {
  return Array.from({ length: to - from }, (_, i) => ({ transform: frameTransform(from + i) }));
}

/**
 * Start an animation whose end nothing waits for. A cancel (every stage change) rejects `finished` with an AbortError,
 * which browsers mark handled and some DOMs do not; any other failure is recorded.
 */
function play(el: HTMLElement, keyframes: Keyframe[], opts: KeyframeAnimationOptions, startTime: number): Animation {
  const anim = el.animate(keyframes, opts);
  anim.finished?.catch((error: unknown) => {
    if ((error as { name?: unknown } | null)?.name !== 'AbortError') noteIgnored('play the working mark', error);
  });
  // on the clock the player keeps, so a late start still shows the frame due now
  anim.startTime = startTime;
  return anim;
}

/** Whether this browser can step a strip with a Web Animation (without one, the mark holds still). */
export function canAnimate(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
}

/** Decode every strip once, before a mark first needs it (as Claude preloads its sheets). */
let preloaded = false;
export function preloadSheets(): void {
  if (preloaded || typeof Image === 'undefined') return;
  preloaded = true;
  for (const { url } of Object.values(MARK_SHEETS)) {
    const img = new Image();
    img.src = url;
    // a strip that fails to decode here is decoded again when it paints
    img.decode?.().catch(ignoring('decode a working mark sheet'));
  }
}

/** Documents that have the strips' stylesheet. */
const styled = new WeakSet<Document>();

/**
 * One rule per sheet for the strip's image, added to a document once: every layer of every mark names its sheet and
 * shares the parsed image, instead of each carrying its own copy of the data URL.
 */
function styleSheets(doc: Document): void {
  if (styled.has(doc)) return;
  styled.add(doc);
  const style = doc.createElement('style');
  style.dataset.workingMark = '';
  style.textContent = Object.entries(MARK_SHEETS)
    .map(([key, { url }]) => `.working-mark-strip[data-sheet="${key}"]{background-image:url("${url}")}`)
    .join('\n');
  doc.head.append(style);
}

/** One strip in its window: the sheet's frames, in their own colours (blocked turns amber), as the Code tab paints them. */
function makeLayer(doc: Document, sheet: string): Layer {
  styleSheets(doc);
  const layer = doc.createElement('span');
  layer.className = 'working-mark-layer';
  const strip = doc.createElement('span');
  strip.className = 'working-mark-strip';
  strip.dataset.sheet = sheet;
  strip.style.height = `${MARK_SHEETS[sheet].frames * MARK_SIZE}px`;
  layer.append(strip);
  return { layer, strip };
}

export class MarkView {
  private readonly layers = new Map<string, Layer>();
  private current: Layer | null = null;
  private steps: Animation | null = null;
  private playing: { stage: MarkFrame['stage']; start: number; looping: boolean } | null = null;
  private ghost: { el: HTMLElement; start: number; fade: Animation } | null = null;
  private dot: HTMLElement | null = null;

  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /** Show what plays: the stage's strip steps on its own until the next change; the sheets wanted next are kept ready. */
  show(frame: MarkFrame, wanted: MarkActivity): void {
    const next = nextStage(frame.stage, wanted);
    const ready = [frame.sheet, sheetKey(next), `${wanted}.in`, `${wanted}.loop`];
    const layer = this.select(frame.sheet, ready);
    const same =
      this.playing &&
      this.playing.stage === frame.stage &&
      this.playing.looping === frame.looping &&
      (frame.looping || this.playing.start === frame.start);
    if (!same) {
      this.steps?.cancel();
      const [from, to] = stageRange(frame.stage);
      const n = to - from;
      layer.strip.style.transform = frameTransform(frame.index);
      this.steps = play(
        layer.strip,
        frameKeyframes(from, to),
        {
          duration: n * sheetOf(frame.stage).speed,
          iterations: frame.looping ? Infinity : 1,
          easing: n > 1 ? `steps(${n}, jump-none)` : 'linear',
          fill: 'forwards',
        },
        frame.start,
      );
      this.playing = { stage: frame.stage, start: frame.start, looping: frame.looping };
    }
    this.showGhost(frame, layer);
  }

  /** Hold one frame of a sheet, with no motion. */
  still(sheet: string, index: number): void {
    this.stop();
    const layer = this.select(sheet, [sheet]);
    layer.strip.style.transform = frameTransform(index);
  }

  /** A dot under a fresh mark's first frames, so nothing blinks while its strip decodes (Claude's 35% dot). */
  setDot(on: boolean): void {
    if (on && !this.dot) {
      this.dot = this.root.ownerDocument.createElement('span');
      this.dot.className = 'working-mark-dot';
      this.root.prepend(this.dot);
    } else if (!on && this.dot) {
      this.dot.remove();
      this.dot = null;
    }
  }

  /** Stop every animation (the mark goes, or holds still). */
  stop(): void {
    this.steps?.cancel();
    this.steps = null;
    this.playing = null;
    this.dropGhost();
  }

  /** Make `sheet` the visible layer, and mount the others in `ready` unseen so they are decoded when they come. */
  private select(sheet: string, ready: string[]): Layer {
    for (const key of ready)
      if (!this.layers.has(key) && MARK_SHEETS[key]) {
        const made = makeLayer(this.root.ownerDocument, key);
        made.layer.style.opacity = WARM;
        this.layers.set(key, made);
        this.root.append(made.layer);
      }
    const layer = this.layers.get(sheet) as Layer;
    if (this.current !== layer) {
      if (this.current) {
        this.current.layer.style.opacity = WARM;
        this.current.layer.style.zIndex = '';
        this.current.strip.style.willChange = '';
      }
      layer.layer.style.opacity = '';
      layer.layer.style.zIndex = '1';
      layer.strip.style.willChange = 'transform';
      this.current = layer;
    }
    return layer;
  }

  /** A cut's left-behind frame under the stage, which fades in over it; dropped once the player lets it go. */
  private showGhost(frame: MarkFrame, layer: Layer): void {
    if (!frame.ghost) return this.dropGhost();
    if (this.ghost?.start === frame.ghost.start) return;
    this.dropGhost();
    const made = makeLayer(this.root.ownerDocument, frame.ghost.sheet);
    made.strip.style.transform = frameTransform(frame.ghost.index);
    this.root.insertBefore(made.layer, this.root.firstChild);
    // filled backwards: the cut may start a moment ahead of the timeline's frame, and must not show at full opacity first
    const fade = play(
      layer.layer,
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: CROSSFADE_MS, easing: 'ease-in-out', fill: 'backwards' },
      frame.ghost.start,
    );
    this.ghost = { el: made.layer, start: frame.ghost.start, fade };
  }

  private dropGhost(): void {
    this.ghost?.fade.cancel();
    this.ghost?.el.remove();
    this.ghost = null;
  }
}
