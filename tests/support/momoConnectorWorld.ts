// A connector hub over a real token vault with the test connector (electron/momo/connectors/fake.cjs) for tests/momoConnectorAccess.test.ts and tests/momoConnectorsIpc.test.ts: the decisions and audit entries recorded, the browser step played by `approve` (it answers the loopback redirect of the URL the hub opened, as the provider's page would).
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './momo-fixtures.ts';

const require = createRequire(import.meta.url);
const { TokenVault } = require('../../electron/momo/connectors/vault.cjs');
const { ConnectorHub } = require('../../electron/momo/connectors/hub.cjs');
const { fakeConnector, FAKE_ID } = require('../../electron/momo/connectors/fake.cjs');

export const tick = () => new Promise((r) => setImmediate(r));

export function connectorWorld(o: { decide?: (call: any) => Promise<any>; safeStorage?: unknown } = {}) {
  let t = 1_700_000_000_000;
  const now = () => t;
  const vault = new TokenVault({ dir: scratch(), safeStorage: 'safeStorage' in o ? o.safeStorage : fakeSafe(), now });
  const decisions: any[] = [];
  const audits: any[] = [];
  const opened: string[] = [];
  const s = { allowed: true };
  const hub = new ConnectorHub({
    vault,
    allowed: () => s.allowed,
    decide: async (call: any) => (decisions.push(call), o.decide ? o.decide(call) : { allow: true }),
    audit: { append: (e: any) => void audits.push(e) },
    openExternal: (u: string) => void opened.push(u),
    now,
  });
  hub.register(fakeConnector({ now }));
  /** Waits for the hub to open the sign-in page, then answers its loopback as the provider's page would. */
  const approve = async (query: (state: string) => string = (state) => `code=c1&state=${state}`) => {
    while (!opened.length) await tick();
    const u = new URL(opened.shift()!);
    const res = await fetch(`${u.searchParams.get('redirect_uri')}?${query(u.searchParams.get('state')!)}`);
    await res.text();
    return res.status;
  };
  const connect = async () => {
    const p = hub.connect(FAKE_ID);
    await approve();
    return p;
  };
  return { hub, vault, decisions, audits, opened, s, approve, connect, advance: (ms: number) => void (t += ms), id: FAKE_ID };
}
