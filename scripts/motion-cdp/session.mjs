// Motion capture over CDP: one page's capture session (#1511), with the Animation domain and a screencast on from start() until finish() labels each animation's element and writes animations.json, summary.md, frames/ and recording.json.
import fs from 'node:fs';
import path from 'node:path';
import { animationLog, labelOf, screencastLog, summarize, summaryTable } from './capture.mjs';

/** The page's document timeline and wall clock read together, to place animations on the wall clock. */
export const CLOCKS_JS = '[document.timeline.currentTime, performance.timeOrigin + performance.now()]';
/** The page's viewport in CSS px. */
export const VIEWPORT_JS = '[innerWidth, innerHeight]';

/**
 * Starts capturing a Playwright page: Animation domain events and screencast frames (saved under `dir/frames`), with
 * reduced motion emulated when asked.
 * @param {any} page @param {{ dir: string, reduced: boolean, quality: number, now?: () => number }} o
 */
export async function startCapture(page, { dir, reduced, quality, now = Date.now }) {
  const frames = path.join(dir, 'frames');
  fs.mkdirSync(frames, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const [pageNow, wallNow] = await page.evaluate(CLOCKS_JS);
  const animations = animationLog(pageNow);
  const shots = screencastLog();
  // a frame the page was not told it can drop holds the next ones back: the failures go with the recording, whose
  // dropped-frame numbers they would explain
  /** @type {string[]} */
  const ackFailures = [];
  cdp.on('Animation.animationStarted', (/** @type {any} */ p) => animations.onEvent('Animation.animationStarted', p));
  cdp.on('Animation.animationCanceled', (/** @type {any} */ p) => animations.onEvent('Animation.animationCanceled', p));
  cdp.on('Page.screencastFrame', (/** @type {any} */ p) => {
    fs.writeFileSync(path.join(frames, shots.add(p, now())), Buffer.from(p.data, 'base64'));
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch((/** @type {Error} */ e) => ackFailures.push(e.message));
  });
  if (reduced) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.send('Animation.enable');
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality, everyNthFrame: 1 });

  return {
    /**
     * Stops the screencast, names each animation's element and writes the folder. `regions` are in CSS px (or a
     * function of the viewport, read once the page has drawn what the moment shows); `marks` in wall-clock ms.
     * @param {{ title: string, arm: string, family: string, moment: string, marks: Record<string, number>,
     *   regions: Record<string, number[] | null> | ((viewport: [number, number]) => Record<string, number[] | null>) }} f
     */
    async finish({ title, arm, family, moment, marks, regions }) {
      await cdp.send('Page.stopScreencast');
      const viewport = /** @type {[number, number]} */ (await page.evaluate(VIEWPORT_JS));
      const found = typeof regions === 'function' ? regions(viewport) : regions;
      for (const id of animations.unlabeled()) {
        const label = await cdp
          .send('DOM.describeNode', { backendNodeId: id })
          .then((/** @type {any} */ r) => labelOf(r.node))
          // the element may be gone by now (a removed card): the animation stays, unnamed
          .catch(() => 'removed');
        animations.label(id, label);
      }
      await cdp.detach();
      const records = animations.records();
      const groups = summarize(records);
      const first = Object.values(marks)[0] ?? wallNow;
      fs.writeFileSync(
        path.join(dir, 'animations.json'),
        `${JSON.stringify({ arm, reducedMotion: reduced, clock: 'ms after the capture started (page timeline)', capturedAtWall: wallNow, records, groups }, null, 1)}\n`,
      );
      fs.writeFileSync(path.join(dir, 'summary.md'), `# ${title}${reduced ? ' (reduced motion)' : ''}\n\n${summaryTable(groups)}`);
      fs.writeFileSync(path.join(frames, 'frames.json'), `${JSON.stringify(shots.index())}\n`);
      const recording = {
        schema: 1,
        kind: 'screencast',
        arm,
        family,
        moment,
        media: 'frames',
        window: [0, 0, viewport[0], viewport[1]],
        regions: Object.fromEntries(Object.entries(found).filter(([, r]) => r)),
        sync: { clock: 'wall', originMs: shots.origin() ?? first },
        marks,
        reducedMotion: reduced,
        screencastAckFailures: ackFailures,
        // the page timeline's zero on the wall clock, to set animation starts against the frames
        animationOriginWallMs: wallNow - pageNow,
      };
      fs.writeFileSync(path.join(dir, 'recording.json'), `${JSON.stringify(recording, null, 1)}\n`);
      return `${records.length} animations in ${groups.length} groups, ${shots.index().length} frames`;
    },
  };
}
