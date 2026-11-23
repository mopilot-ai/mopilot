// Trusted pointer clicks in Chrome's native panel wait for an uncovered, stable control and recheck after hover.
import { releaseAfterHold } from './nativePanelHold.mjs';

/**
 * @param {{ inPanel: (expression: string) => Promise<any>, send: (event: Record<string, unknown>) => Promise<unknown>, delay?: (ms: number) => Promise<unknown> }} o
 * @param {string} selector
 * @param {number} [holdMs]
 * @param {() => Promise<void>} [settled]
 */
export async function clickNativePanel(
  { inPanel, send, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  selector,
  holdMs = 0,
  settled,
) {
  let point;
  let previous;
  let why = 'Native panel control did not settle';
  const same = (a, b) => !!a && a.x === b.x && a.y === b.y;
  const locate = () =>
    inPanel(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled) return { why: 'Native panel control unavailable' };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { why: 'Native panel control hidden' };
    const point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    if (!el.contains(document.elementFromPoint(point.x, point.y))) return { why: 'Native panel control covered' };
    return point;
  })()`);
  for (let i = 0; i < 100; i++) {
    const found = await locate();
    if (found.why) {
      why = found.why;
      previous = undefined;
    } else if (same(previous, found)) {
      await send({ type: 'mouseMoved', ...found });
      const checked = await locate();
      if (!checked.why && same(found, checked)) {
        point = checked;
        break;
      }
      why = checked.why ?? 'Native panel control did not settle';
      previous = checked.why ? undefined : checked;
    } else {
      why = 'Native panel control did not settle';
      previous = found;
    }
    await delay(100);
  }
  if (!point) throw new Error(`${why}: ${selector}`);
  await send({ type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await releaseAfterHold(holdMs, settled, () => send({ type: 'mouseReleased', button: 'left', clickCount: 1, ...point }));
}
