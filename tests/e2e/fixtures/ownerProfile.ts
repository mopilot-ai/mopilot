// The owner-sized fake profile and the in-window measuring helpers (#5398): about 2,660 chats in 30 projects, a 300-turn chat, a 1,500-child linked-session journal; observers for long tasks, long frames and slow input events; a CPU profile summary. Fake data only.
import { expect, type Page } from '@playwright/test';

export const PROJECTS = 30;
export const CLAUDE_CHATS = 1400;
export const CODEX_CHATS = 1260;
export const BIG_TURNS = 300;
export const CHILDREN = 1500;
export const DELIVERIES = 1000;
export const PROPOSALS = 200;
export const BROADCASTS = 12;
export const KEYS = 'the quick brown fox jumps over the lazy dog, again and again!';
export const NOW = Date.now();

export const filler = (n: number) => 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(Math.ceil(n / 57)).slice(0, n);
export const proj = (n: number) => `proj${String(n).padStart(2, '0')}`;
export const projectOf = (n: number) => (n < PROJECTS ? n : Math.floor(PROJECTS * Math.pow((n * 0.6180339887) % 1, 1.6)));
export const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const sessionId = (n: number) => uuid('cccccccc', n);
/** The id the window gives a Claude session (src/harness/types.ts claudeThreadId). */
export const claudeId = (n: number) => `claude:${sessionId(n)}`;
/** The 300-turn chat is one of the listed ones (the sixth in its project), so the window has it as soon as it lists. */
export const BIG_N = 3;
export const BIG = claudeId(BIG_N);

export const claudeSessions = Array.from({ length: CLAUDE_CHATS }, (_, n) => ({
  id: sessionId(n),
  cwd: proj(projectOf(n)),
  title: n === BIG_N ? 'Big chat' : `Claude chat ${n}`,
  turns:
    n === BIG_N
      ? Array.from({ length: BIG_TURNS }, (_, i) => `turn ${i}: ${filler(500 + (i % 7) * 300)}`)
      : [`question ${n}`, `follow up ${n}`],
}));
export const codexThreads = Array.from({ length: CODEX_CHATS }, (_, n) => ({
  id: uuid('019b0000', n).replace('-4000-', '-7000-'),
  name: `Codex chat ${n}`,
  cwd: proj(projectOf(n + 7)),
  turns: [`question ${n}`],
}));

/** The linked-sessions journal of a long-time user (electron/session/orchestration/journal.cjs): old children, deliveries and proposals, about 2.8 MB. */
export function journal() {
  const children: Record<string, unknown> = {};
  for (let n = 0; n < CHILDREN; n++) {
    // the first 150 are sessions of chats that are listed, so some rows draw as linked sessions
    const id = n < 150 ? claudeId(n) : `gone-${n}`;
    children[id] = {
      parentId: claudeId(150 + (n % 20)),
      name: `Linked session ${n}`,
      title: `Linked ${n}`,
      createdAt: NOW - n * 60_000,
      driven: [`i${n}a`, `i${n}b`, `i${n}c`],
      worked: { ms: 60_000 + n, turns: 1 + (n % 9), since: null },
      lastReport: n % 3 === 0 ? null : { how: 'wrap_up', report: filler(1100), at: NOW - n * 30_000 },
    };
  }
  const deliveries: Record<string, unknown> = {};
  for (let n = 0; n < DELIVERIES; n++) deliveries[`d${n}`] = { kind: 'message', chatId: claudeId(n % 300), at: NOW - n * 20_000 };
  const proposals: Record<string, unknown> = {};
  for (let n = 0; n < PROPOSALS; n++)
    proposals[`p${n}`] = {
      parentId: claudeId(150 + (n % 20)),
      kind: 'offer',
      status: 'dismissed',
      args: { title: `Proposal ${n}`, prompt: filler(1200) },
      createdAt: NOW - n * 90_000,
      expiresAt: NOW - n * 90_000 + 600_000,
    };
  return { schemaVersion: 1, children, parents: {}, deliveries, proposals, queue: [], plans: {}, wrapUps: {}, dependants: {} };
}

export const round = (x: number) => Math.round(x * 10) / 10;
export const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : null;
};
export const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: pct(xs, 1) });

/** What the window observes from the moment it is called: long tasks, long animation frames (with their longest script) and slow input events. */
export const observe = (page: Page) =>
  page.evaluate(() => {
    const w = window as any;
    if (w.__jank) return;
    const jank = (w.__jank = { longtasks: [] as any[], loaf: [] as any[], events: [] as any[], keys: [] as number[], ime: [] as number[] });
    const watch = (type: string, take: (e: any) => any, into: any[], extra: object = {}) => {
      try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) => into.push(take(e)))).observe({
          type,
          buffered: true,
          ...extra,
        } as any);
      } catch {
        /* an entry type this Chromium lacks is reported empty */
      }
    };
    watch('longtask', (e) => ({ t: e.startTime, ms: e.duration }), jank.longtasks);
    watch(
      'long-animation-frame',
      (e) => {
        const top = [...(e.scripts ?? [])].sort((a: any, b: any) => b.duration - a.duration)[0];
        return {
          t: e.startTime,
          ms: e.duration,
          blocking: e.blockingDuration,
          script: top
            ? {
                file: String(top.sourceURL || '')
                  .split('/')
                  .pop(),
                fn: top.sourceFunctionName,
                invoker: top.invoker,
                ms: top.duration,
              }
            : null,
        };
      },
      jank.loaf,
    );
    watch('event', (e) => ({ t: e.startTime, name: e.name, ms: e.duration, delay: e.processingStart - e.startTime }), jank.events, {
      durationThreshold: 16,
    });
    // keydown to the paint after it, for every key (the event timing above sees only the slow ones); an IME's composition updates and ends the same way
    const toPaint = (names: string[], into: number[]) =>
      names.forEach((name) =>
        addEventListener(
          name,
          (event) => {
            // from when the browser made the event, so the time a long task kept it waiting counts
            const t0 = Math.min(event.timeStamp, performance.now());
            requestAnimationFrame(() => setTimeout(() => into.push(performance.now() - t0), 0));
          },
          true,
        ),
      );
    toPaint(['keydown'], jank.keys);
    toPaint(['compositionupdate', 'compositionend'], jank.ime);
    // frame intervals while a recorder runs
    let last = 0;
    let frames: number[] | null = null;
    const tick = (t: number) => {
      if (frames && last) frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__frames = {
      start: () => (frames = []),
      stop: () => {
        const done = frames ?? [];
        frames = null;
        return done;
      },
    };
  });

/** The window's clock now. */
export const now = (page: Page) => page.evaluate(() => performance.now());

/** Long tasks, long frames and slow events that started inside [from, to] on the window's clock. */
export const jankBetween = (page: Page, from: number, to: number) =>
  page.evaluate(
    ([a, b]) => {
      const j = (window as any).__jank;
      const within = (x: any) => x.t >= a && x.t <= b;
      const tasks = j.longtasks.filter(within);
      const loaf = j.loaf.filter(within);
      return {
        longtasks: {
          count: tasks.length,
          totalMs: Math.round(tasks.reduce((s: number, x: any) => s + x.ms, 0)),
          maxMs: Math.round(Math.max(0, ...tasks.map((x: any) => x.ms))),
        },
        loaf: loaf
          .sort((x: any, y: any) => y.ms - x.ms)
          .slice(0, 3)
          .map((x: any) => ({ ms: Math.round(x.ms), blocking: Math.round(x.blocking), script: x.script })),
        keydowns: (() => {
          // Event Timing's own duration (input delay, handlers, and the frame that shows the result), for every keydown it kept (16 ms and over)
          const k = j.events.filter((x: any) => within(x) && x.name === 'keydown').map((x: any) => x.ms);
          return {
            over16: k.length,
            max: Math.round(Math.max(0, ...k)),
            over32: k.filter((x: number) => x > 32).length,
            over100: k.filter((x: number) => x > 100).length,
          };
        })(),
        slowEvents: j.events
          .filter(within)
          .map((x: any) => ({ name: x.name, ms: x.ms, delay: Math.round(x.delay) }))
          .slice(0, 10),
      };
    },
    [from, to] as const,
  );

/** A sampled CPU profile summed by self time, slowest first. */
export function profileTop(profile: { nodes: any[]; samples: number[]; timeDeltas: number[] }) {
  return profileTotals(profile).self;
}

/** A profile by self time and by time inside each function (it or anything it called): where the time went and who asked for it. */
export function profileTotals(profile: { nodes: any[]; samples: number[]; timeDeltas: number[] }) {
  const byId = new Map<number, any>(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const child of n.children ?? []) parent.set(child, n.id);
  const keyOf = (id: number) => {
    const { functionName, url, lineNumber, columnNumber } = byId.get(id).callFrame;
    const file = url ? (url.split('/').pop()?.split('?')[0] ?? url) : '(native)';
    return `${functionName || '(anonymous)'} ${file}:${lineNumber + 1}:${columnNumber + 1}`;
  };
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const ms = (profile.timeDeltas[i] ?? 0) / 1000;
    self.set(keyOf(id), (self.get(keyOf(id)) ?? 0) + ms);
    // every function on the stack once, however often it recurs
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const key = keyOf(at);
      if (seen.has(key)) continue;
      seen.add(key);
      total.set(key, (total.get(key) ?? 0) + ms);
    }
  });
  const top = (m: Map<string, number>, n: number, skip = false) =>
    [...m]
      .filter(([name]) => !skip || !/^\((?:root|program|idle|garbage collector)\)/.test(name))
      .sort((x, y) => y[1] - x[1])
      .slice(0, n)
      .map(([name, ms]) => ({ name, ms: Math.round(ms) }));
  return { self: top(self, 15), total: top(total, 250, true) };
}

/** The nearest ancestor of a selector's first match that scrolls, as the point to put the wheel over. */
export const scrollerPoint = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    let el = document.querySelector(sel) as HTMLElement | null;
    while (el) {
      const o = getComputedStyle(el).overflowY;
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 50) break;
      el = el.parentElement;
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  }, selector);

export async function sceneCounts(page: Page) {
  return page.evaluate(() => ({
    sidebarRows: document.querySelectorAll('[data-sidebar-chat]').length,
    userMessages: document.querySelectorAll('.user-message').length,
    domNodes: document.getElementsByTagName('*').length,
    heapMb: Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576),
  }));
}

type Harness = { page: Page; app: { evaluate: (fn: any, arg?: any) => Promise<any> } };

/** The sidebar has drawn chats and both harness lists have answered. */
export async function settled(page: Page) {
  const ready = () =>
    page
      .evaluate(
        () =>
          document.querySelectorAll('[data-sidebar-chat]').length > 100 &&
          !!performance.getEntriesByName('mopilot:chats:claude').length &&
          !!performance.getEntriesByName('mopilot:chats:codex').length,
      )
      .catch(() => false);
  await expect.poll(ready, { timeout: 180_000, intervals: [500], message: 'the sidebar never settled' }).toBe(true);
}

/** Opens a chat as the app's own open-chat command does. */
export const openChat = (h: Harness, id: string) =>
  h.app.evaluate(
    ({ BrowserWindow }: any, chat: string) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', 'open-chat', chat),
    id,
  );

/** Opens a chat and waits for its column, a usable composer and a paint: the milliseconds that took, -1 when it never came. */
export async function switchTo(h: Harness, id: string): Promise<number> {
  await h.page.evaluate((chat) => {
    const t0 = performance.now();
    (window as any).__switch = new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(-1), 60_000);
      const done = () => {
        const col = document.querySelector(`.thread-column[data-selection-source="thread-${chat}"]`);
        const input = document.querySelector('[role="textbox"][aria-label="Message"]') as HTMLElement | null;
        if (!col?.textContent || !input || input.offsetParent === null) return false;
        clearTimeout(timer);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
        return true;
      };
      if (!done()) {
        const observer = new MutationObserver(() => done() && observer.disconnect());
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      }
    });
  }, id);
  await openChat(h, id);
  return h.page.evaluate(() => (window as any).__switch as Promise<number>);
}

/** Per-condition summary of keystroke-to-paint times. */
export function keySummary(keys: number[]) {
  const s = stats(keys.map(round));
  return { ...s, over32: keys.filter((x) => x > 32).length, over100: keys.filter((x) => x > 100).length };
}
