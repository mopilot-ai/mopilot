// A WebDriverAgent that answers from a list of things on screen: the fake the journey runner's tests drive its client with.
import { Wda } from '../../scripts/mobile-ios-journey/wda.mjs';

export const sleepNone = async () => undefined;

export type Item = { label: string; rect?: { x: number; y: number; width: number; height: number } };
/** A WebDriverAgent that answers from a list of things on screen, and keeps every call it was asked for. */
export function fakeWda(
  o: {
    screen?: Item[];
    elementShape?: 'ELEMENT' | 'w3c';
    alert?: boolean;
    staleOnce?: boolean;
    failElements?: string;
    badBody?: boolean;
    sessionShape?: 'top' | 'value';
    plainFail?: boolean;
    front?: string;
    alertText?: string;
    alertError?: string;
    systemTree?: object;
    keyboardTop?: number;
    /** the keyboard's top edge on each read while it slides in; the last one is where it rests */
    keyboardRise?: number[];
    /** WebDriverAgent's answer when the keyboard is measured (it went away after being found) */
    keyboardRectError?: string;
  } = {},
) {
  const calls: { method: string; route: string; body: any }[] = [];
  const state = { screen: o.screen ?? [], staleOnce: o.staleOnce ?? false };
  const rise = [...(o.keyboardRise ?? [])];
  let sessions = 0;
  let active = 'auto';
  const fetchImpl = (async (url: string, init: any) => {
    const route = url.replace('http://wda:8100', '');
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method: init.method, route, body });
    const reply = (value: unknown, extra: object = {}, ok = !o.badBody, status = o.badBody ? 502 : 200) => ({
      ok,
      status,
      json: async () => (o.badBody ? Promise.reject(new Error('not json')) : { value, ...extra }),
    });
    if (route === '/session' && o.plainFail) return reply(null, {}, false, 500);
    if (route === '/session') {
      const id = `s${++sessions}`;
      return reply({ sessionId: id }, o.sessionShape === 'top' ? { sessionId: id } : {});
    }
    if (route === '/wda/activeAppInfo') return reply({ bundleId: o.front ?? 'ai.mopilot.phone' });
    if (route.endsWith('/alert/text')) {
      if (o.alertError) return reply({ error: 'unknown error', message: o.alertError }, {}, false, 500);
      return o.alert === false
        ? reply(
            { error: 'no such alert', message: 'An attempt was made to operate on a modal dialog when one was not open' },
            {},
            false,
            404,
          )
        : reply(o.alertText ?? 'Open in “MoPilot”?');
    }
    if (route === '/wda/homescreen') return reply(null);
    if (route.endsWith('/elements') && body.using === 'class name')
      return reply(
        o.keyboardTop === undefined && !rise.length
          ? []
          : [o.elementShape === 'w3c' ? { 'element-6066-11e4-a52e-4f735466cecf': 'kb' } : { ELEMENT: 'kb' }],
      );
    if (route.endsWith('/element/kb/rect') && o.keyboardRectError)
      return reply({ error: 'unknown error', message: o.keyboardRectError }, {}, false, 500);
    if (route.endsWith('/element/kb/rect'))
      return reply({ x: 0, y: rise.length > 1 ? rise.shift() : (rise[0] ?? o.keyboardTop), width: 400, height: 300 });
    if (route.endsWith('/elements')) {
      if (o.failElements) return reply({ error: 'unknown error', message: o.failElements }, {}, false, 500);
      if (state.staleOnce) {
        state.staleOnce = false;
        return reply(
          { error: 'stale element reference', message: 'The previously found element is not present in the current view anymore' },
          {},
          false,
          404,
        );
      }
      const wanted: string = body.value;
      const contains = (/CONTAINS '((?:[^'\\]|\\.)*)'/.exec(wanted) ?? [])[1]?.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      const hits = state.screen
        .map((item, index) => ({ item, index }))
        .filter(({ item }) =>
          body.using === 'accessibility id' ? item.label === wanted : contains !== undefined && item.label.includes(contains),
        );
      return reply(
        hits.map(({ index }) =>
          o.elementShape === 'w3c' ? { 'element-6066-11e4-a52e-4f735466cecf': `e${index}` } : { ELEMENT: `e${index}` },
        ),
      );
    }
    const element = /\/element\/e(\d+)\/(rect|attribute\/label)$/.exec(route);
    if (element && init.method === 'GET') {
      const item = state.screen[Number(element[1])];
      return reply(element[2] === 'rect' ? { ...(item.rect ?? { x: 10, y: 100, width: 200, height: 44 }) } : item.label);
    }
    if (route.endsWith('/element/active'))
      return reply(o.elementShape === 'w3c' ? { 'element-6066-11e4-a52e-4f735466cecf': 'active' } : { ELEMENT: 'active' });
    if (route.endsWith('/appium/settings')) {
      if ('defaultActiveApplication' in body.settings) active = body.settings.defaultActiveApplication;
      return reply({});
    }
    if (route.endsWith('/source?format=json') && active === 'com.apple.springboard' && o.systemTree) return reply(o.systemTree);
    if (route.endsWith('/source?format=json'))
      return reply({ label: 'App', children: [{ label: 'One', children: [{ label: 'Two' }, { label: '' }] }, { type: 'Other' }] });
    if (route.endsWith('/screenshot')) return reply(Buffer.from('png-bytes').toString('base64'));
    if (route.endsWith('/alert/accept'))
      return o.alert === false
        ? reply(
            { error: 'no such alert', message: 'An attempt was made to operate on a modal dialog when one was not open' },
            {},
            false,
            404,
          )
        : reply(null);
    return reply(null);
  }) as any;
  return { fetchImpl, calls, state };
}
export const wdaOf = (f: ReturnType<typeof fakeWda>, over: object = {}) => {
  let clock = 0;
  return new Wda({
    base: 'http://wda:8100/',
    bundleId: 'ai.mopilot.phone',
    fetchImpl: f.fetchImpl,
    sleep: async (ms: number) => void (clock += ms),
    now: () => clock,
    ...over,
  });
};
