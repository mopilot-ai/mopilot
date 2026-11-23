// Scripted account owners for relay transport tests; all authenticated requests have a real usage generation.
import { createRequire } from 'node:module';
const { UsageRefresh } = createRequire(import.meta.url)('../../electron/identity/contract/usageRefresh.cjs');
export function createRelayAccounts(apiBase: string) {
  const calls: any[] = [];
  function accounts(o: any = {}) {
    const list = o.list ?? [{ id: 'a' }, { id: 'b' }];
    return {
      usageRefresh: new UsageRefresh(),
      pickFor: (session: string | null, tried: Set<string>) => {
        calls.push(['pick', session, [...tried]]);
        if ('pick' in o) return typeof o.pick === 'function' ? o.pick(session, tried) : o.pick;
        return list.find((x: any) => !tried.has(x.id));
      },
      tokens: async (acct: any, force?: boolean) => {
        calls.push(['tokens', acct.id, !!force]);
        if (o.tokens) return o.tokens(acct, force);
        return { accessToken: `tok-${acct.id}${force ? '-fresh' : ''}`, chatgptAccountId: `cg-${acct.id}` };
      },
      apiBase: () => o.apiBase ?? apiBase,
      keyRoute: (session: string | null) => (o.keyRoute ? o.keyRoute(session) : null),
      noteUsageHeaders: (acct: any) => calls.push(['usage', acct.id]),
      markLimited: (acct: any, at: any) => calls.push(['limited', acct.id, at]),
    };
  }

  return { accounts, calls };
}

export { admitAll } from './relayPeer.ts';
