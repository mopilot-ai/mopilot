// A stand-in for the Rust core's addon, for tests of how a caller decides on what the caps routes answer. What the routes themselves read: tests/capsRealPeer.test.ts and core/crates/caps.

/** What a route answers: a value to reply with, an Error to fail with, or either from the payload. */
export type FakeReply = unknown | ((payload: string) => unknown);

/** A core answering `replies[route]`, and the calls it was asked, as `route payload`. A route it does not list fails. */
export function fakeCore(replies: Record<string, FakeReply>) {
  const asked: string[] = [];
  const answer = (route: string, payload: Buffer) => {
    asked.push(`${route} ${payload}`);
    if (!Object.hasOwn(replies, route)) throw new Error(`no route ${route}`);
    const reply = replies[route];
    const value = typeof reply === 'function' ? (reply as (p: string) => unknown)(String(payload)) : reply;
    if (value instanceof Error) throw value;
    return Buffer.from(JSON.stringify(value));
  };
  return {
    asked,
    addon: {
      routes: () => Object.keys(replies),
      dispatch: async (route: string, payload: Buffer) => answer(route, payload),
      dispatchSync: answer,
      // what the caps routes' callers never use, so the fake is a whole addon
      dispatchCancellable: (route: string, payload: Buffer) => ({ id: 0, reply: (async () => answer(route, payload))() }),
      cancel: () => false,
      subscribe: () => undefined,
    },
  };
}

/** A core whose peer check is ready here, and the routes that takes. */
export const READY_ROUTES = { 'caps.ancestry': [], 'caps.executable': '', 'caps.peerPid': 0, 'caps.ready': true };

/**
 * `caps.ancestry` over `parents` (pid to parent), as crates/caps reads a table: the pid, then each parent until one is 1
 * or below or is not listed, which still ends the chain.
 */
export const ancestryOf =
  (parents: Record<number, number>) =>
  (payload: string): number[] => {
    const chain: number[] = [];
    let at: number | undefined = Number(payload);
    while (at !== undefined && at > 1 && chain.length <= Object.keys(parents).length) {
      chain.push(at);
      at = parents[at];
    }
    return chain;
  };
