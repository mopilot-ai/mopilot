// Action memory's test kit (#3571, G4): a real capability Registry with fake browser_* tools registered through the
// routine recorder, a page of named controls the fakes act on (anchors and queries by role and name, as the page agent
// answers them), the real routine tools over an in-memory sealed store, and a turn-end helper.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry, ToolError } = require('../../electron/capabilities/contract/registry.cjs');
const { RoutineStore } = require('../../electron/capabilities/routines/routineStore.cjs');
const { RoutineRecorder } = require('../../electron/capabilities/routines/routineRecorder.cjs');
const { registerRoutineTools } = require('../../electron/capabilities/routines/routineTools.cjs');

export type Control = { role: string; name: string; ref: string };

/** A sealed file in memory. */
export const memorySealed = () => {
  const m: { bytes: Buffer | null; available: boolean } = { bytes: null, available: true };
  return {
    m,
    read: () => m.bytes,
    write: (b: Buffer) => void (m.bytes = b),
    available: () => m.available,
  };
};

/**
 * @param o.controls the page's controls (a page per URL with `pages`)
 * @param o.fail a browser call that fails (it throws, as a refused tool does)
 * @param o.current whether a call's segment is still the chat's current one
 * @param o.say what a fake browser call returns instead of its usual line (a test's page text, with its own `<browser_state>`)
 * @param o.before called before each fake browser call runs (a test's Stop, a switch)
 */
export function routineKit(
  o: {
    controls?: Control[];
    pages?: Record<string, Control[]>;
    fail?: (tool: string, args: any) => string | null;
    current?: (ctx: any) => boolean;
    before?: (tool: string, args: any, ctx: any) => void | Promise<void>;
    approve?: (req: any) => boolean;
    say?: (tool: string, args: any, page: { url: string }) => string | undefined;
  } = {},
) {
  const registry = new Registry({ approve: o.approve });
  const sealed = memorySealed();
  const store = new RoutineStore({ sealed });
  const recorder = new RoutineRecorder({ store });
  const page = { url: 'https://shop.test/' };
  const controlsNow = (): Control[] => o.pages?.[page.url] ?? o.controls ?? [];
  const byRef = (ref: string) => controlsNow().find((c) => c.ref === ref);
  const tab = {
    get url() {
      return page.url;
    },
    frames: new Map(),
    frameOf: () => '',
    ownerRef: async () => 'owner',
    agent: async (op: string, args: any) => {
      if (op !== 'anchor') return null;
      const c = byRef(args.ref);
      return c
        ? { steps: [{ k: 'role', role: c.role, name: { s: c.name, exact: true } }], weak: false, secret: c.role === 'password' }
        : null;
    },
  };
  const tabs = {
    current: () => tab,
    resolve: async () => tab,
    run: async (_t: any, fn: () => any) => fn(),
    query: async (_t: any, steps: any[]) => {
      const want = steps.at(-1);
      const found = controlsNow().filter((c) => c.role === want.role && c.name === want.name?.s);
      return { sessionId: '', refs: found.map((c) => c.ref), count: found.length, desc: [] };
    },
  };
  /** What the fake browser tools did, in order: [tool, args]. */
  const did: [string, any][] = [];
  const fake = (name: string) => ({
    name,
    policy: name === 'browser_read_page' ? 'observe' : 'act',
    authorizesItself: true,
    schema: { type: 'object' },
    handler: async (args: any, ctx: any) => {
      await o.before?.(name, args, ctx);
      if (ctx.signal.aborted) throw new ToolError('stopped', 'aborted');
      const why = o.fail?.(name, args);
      if (why) throw new ToolError(why, 'denied');
      if (args.ref && !byRef(args.ref)) throw new ToolError(`${args.ref} is stale`, 'stale_ref');
      did.push([name, args]);
      if (name === 'browser_navigate' || name === 'chrome_navigate') page.url = args.url;
      // ends as a real browser tool's result does: the screen and a replay read where it came from there
      return [
        { type: 'text', text: o.say?.(name, args, page) ?? `${name} ok; Tab 1 is at ${page.url}.` },
        { type: 'text', text: `<browser_state>\ncurrent tab: tab_1 · Page · ${page.url}\ntabs: tab_1*\n</browser_state>` },
      ];
    },
  });
  const recording = recorder.recording(registry, tabs);
  for (const name of ['browser_navigate', 'browser_computer', 'browser_form_input', 'browser_read_page', 'browser_batch', 'browser_script'])
    recording.register(fake(name));
  // the user's Chrome: its own tabs object (the same page model), given lazily as chromeRelay.tabs is
  const chromeTabs = { ...tabs, chrome: true, queries: 0 };
  chromeTabs.query = async (t: any, steps: any[]) => (chromeTabs.queries++, tabs.query(t, steps));
  let chromeUp = true;
  const chromeRec = recorder.recording(registry, () => (chromeUp ? chromeTabs : null), 'chrome_');
  for (const name of ['chrome_navigate', 'chrome_computer', 'chrome_read_page']) chromeRec.register(fake(name));
  const unregister = registerRoutineTools(registry, {
    tainted: (chatId: string) => registry.taint.taintedBy(chatId).length > 0,
    store,
    recorder,
    adapters: (prefix: string) => recorder.adapter(prefix),
    invoke: (chatId: string, segmentId: string, tool: string, args: any, opts: any) => registry.invoke(chatId, segmentId, tool, args, opts),
    current: (ctx: any) => (o.current ? o.current(ctx) : true),
  });
  const call = (tool: string, args: any = {}, chat = 'chat1', segment = 'claude:s1') => registry.invoke(chat, segment, tool, args);
  /** The text of a result's content. */
  const text = (res: any) => res.content.map((c: any) => c.text ?? '').join('\n');
  return {
    registry,
    store,
    recorder,
    sealed,
    page,
    tabs,
    chromeTabs,
    setChromeUp: (up: boolean) => void (chromeUp = up),
    tab,
    did,
    call,
    text,
    unregister,
    end: (chat = 'chat1', completed = true) => recorder.turnFinished(chat, completed),
  };
}

export const SEARCH: Control = { role: 'searchbox', name: 'Search', ref: 'ref_1' };
export const GO: Control = { role: 'button', name: 'Go', ref: 'ref_2' };
export const ADD: Control = { role: 'button', name: 'Add to cart', ref: 'ref_3' };

/** One completed turn that searched and added the first result: five steps, the query a parameter. */
export async function recordSearchTurn(k: ReturnType<typeof routineKit>, chat = 'chat1') {
  await k.call('browser_navigate', { url: 'https://shop.test/' }, chat);
  await k.call('browser_read_page', { filter: 'interactive' }, chat);
  await k.call('browser_computer', { action: 'left_click', ref: SEARCH.ref }, chat);
  await k.call('browser_computer', { action: 'type', text: 'blue mug' }, chat);
  await k.call('browser_computer', { action: 'left_click', ref: GO.ref }, chat);
  await k.call('browser_computer', { action: 'left_click', ref: ADD.ref }, chat);
  return k.end(chat, true);
}
