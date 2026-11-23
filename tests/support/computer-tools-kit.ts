// A ComputerUse (the computer_* tools) over a scripted helper, recording its calls, the activity bar and the cards asked.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ComputerUse } = require('../../electron/capabilities/tools/computer.cjs');

export const APP = { bundleId: 'com.b', name: 'B', pid: 5 };
export const shot = (o: any = {}) => ({ png: 'PNG', width: 100, height: 50, display: { x: 0, y: 0 }, pixelsPerPoint: 2, ...o });

export function make(o: any = {}) {
  const calls: any[] = [];
  const rec =
    (name: string, v?: any) =>
    (...a: any[]) => (calls.push([name, ...a]), typeof v === 'function' ? v(...a) : Promise.resolve(v));
  const helper: any = {
    running: true,
    start: rec('start', {}),
    targetInfo: rec('targetInfo', APP),
    glowStart: rec('glowStart'),
    glowStop: rec('glowStop'),
    click: rec('click'),
    scroll: rec('scroll'),
    type: rec('type'),
    key: rec('key'),
    acquireControl: rec('acquire'),
    releaseControl: rec('release'),
    resumeControl: rec('resume'),
    screenshot: rec('screenshot', shot()),
    axSnapshot: rec('axSnapshot', {
      app: { name: 'B' },
      root: { id: 'e1', role: 'AXButton', title: 'OK', frame: { x: 0, y: 0, w: 10, h: 10 } },
    }),
    ocrElements: rec('ocr', []),
    permissionStatus: rec('permissionStatus', { accessibility: true, screenRecording: true }),
    requestPermission: rec('requestPermission', {}),
    ...o.helper,
  };
  const activity: any[] = [];
  const asked: any[] = [];
  const cu = new ComputerUse({
    helper,
    grants: {
      forChat: () => o.grants ?? [{ bundleId: 'com.b', level: 'full' }],
      deny: () => [],
      grant: (...a: any[]) => calls.push(['grant', ...a]),
    },
    broker: { ask: async (...a: any[]) => (asked.push(a), o.answer ?? { decision: 'allow', scope: 'once' }) },
    session: () => (o.session === undefined ? { modality: 'image' } : o.session),
    onActivity: (chatId: string, a: any) => activity.push([chatId, a]),
    settleMs: o.settleMs ?? 0,
    waitMs: o.waitMs ?? 0,
    pollMs: 1,
    takeoverWaitMs: o.takeoverWaitMs,
    vision: o.vision,
    unattended: o.unattended,
  });
  const by = Object.fromEntries(cu.tools().map((t: any) => [t.name, t.handler]));
  return { cu, helper, calls, activity, asked, by };
}
export const ctx = { chatId: 'c' };
