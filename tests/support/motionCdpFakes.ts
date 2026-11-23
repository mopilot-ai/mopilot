// Fakes for the motion capture tests (scripts/motion-cdp): an Animation domain animation, and a page, CDP session and driver whose screencast and page events play once a turn is sent.
import path from 'node:path';
import { CLOCKS_JS, VIEWPORT_JS } from '../../scripts/motion-cdp/session.mjs';
import { LAYOUT_JS, PROMPT, UNTHROTTLED } from '../../scripts/motion-cdp/run.mjs';

export const cssAnimation = (id: string, startTime: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'fade-in',
  type: 'CSSAnimation',
  startTime,
  source: {
    duration: 200,
    delay: 50,
    endDelay: 0,
    iterations: 1,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    direction: 'normal',
    fill: 'both',
    backendNodeId: 7,
    keyframesRule: {
      name: 'fade-in',
      keyframes: [
        { offset: '0%', easing: 'ease' },
        { offset: '100%', easing: 'ease' },
      ],
    },
    ...extra,
  },
});

/** A fake page, CDP session and driver: the screencast sends two frames and the page runs two animations once the turn is sent. */
export function fakes(dir: string, { failDescribe = false } = {}) {
  const calls: string[] = [];
  const handlers: Record<string, (p: any) => void> = {};
  const cdp = {
    on: (event: string, fn: (p: any) => void) => {
      handlers[event] = fn;
    },
    send: async (method: string, params?: any) => {
      calls.push(params ? `${method} ${JSON.stringify(params)}` : method);
      if (method === 'DOM.describeNode') {
        if (failDescribe || params.backendNodeId === 9) throw new Error('No node');
        return { node: { nodeName: 'DIV', attributes: ['class', 'step-row'] } };
      }
      if (method === 'Page.screencastFrameAck' && params.sessionId === 2) throw new Error('closed');
      return {};
    },
    detach: async () => calls.push('detach'),
  };
  const page = {
    getByRole: (_role: string, o: any) => ({ first: () => ({ click: async () => calls.push(`click ${o.name}`) }) }),
    locator: (sel: string) => ({
      first: () => ({
        waitFor: async () => calls.push(`waitFor ${sel}`),
        click: async (o: any) => calls.push(`press ${sel} ${o.delay}`),
      }),
    }),
    context: () => ({ newCDPSession: async () => cdp }),
    evaluate: async (js: string) => {
      if (js === LAYOUT_JS) return { transcript: [10, 40, 800, 600], composer: null };
      if (js === VIEWPORT_JS) return [1200, 800];
      if (js === CLOCKS_JS) return [5000, 1_700_000_005_000];
      throw new Error(`unexpected ${js}`);
    },
  };
  const jpeg = Buffer.from('jpeg').toString('base64');
  const driver = {
    pickHarness: async (_s: any, family: string) => calls.push(`pick ${family}`),
    send: async (_s: any, text: string) => {
      calls.push(`send ${text === PROMPT}`);
      handlers['Page.screencastFrame']({ data: jpeg, sessionId: 1, metadata: { timestamp: 1_700_000_005.6 } });
      handlers['Page.screencastFrame']({ data: jpeg, sessionId: 2, metadata: { timestamp: 1_700_000_005.65 } });
      handlers['Animation.animationStarted']({ animation: cssAnimation('a', 5600) });
      handlers['Animation.animationStarted']({ animation: cssAnimation('b', 5700, { backendNodeId: 9 }) });
      handlers['Animation.animationCanceled']({ id: 'b' });
    },
    waitTurns: async () => calls.push('wait'),
    start: async (profile: string, o: any) => {
      calls.push(`start ${path.basename(path.dirname(profile))} ${o.args.join(' ') === UNTHROTTLED.join(' ')}`);
      return { page, ctl: path.join(dir, 'ctl') };
    },
    stop: async () => calls.push('stop'),
  };
  return { calls, driver, page };
}

/** A page whose locators answer with how many elements match, recording each click. */
export function stepsPage(counts: Record<string, number>, calls: string[], cardShows = true) {
  return {
    locator: (sel: string) => ({
      count: async () => counts[sel] ?? 0,
      first: () => ({
        click: async () => calls.push(`click ${sel}`),
        waitFor: async () => (cardShows ? undefined : Promise.reject(new Error('Timeout'))),
      }),
    }),
  };
}
