// Shared set-up for the MoMo Google connector tests: an in-memory account file and a connected account.
import { GoogleAccount } from '../../shared/momoGoogle/account.mjs';
import type { AccountFile, ClientConfig, Fetch, StoredAccount } from '../../shared/momoGoogle/types.mjs';
import { READ_SCOPES } from '../../shared/momoGoogle/types.mjs';

export const NOW = Date.parse('2026-11-24T10:00:00Z');

export function memoryFile(initial: StoredAccount | null = null): AccountFile & { value: StoredAccount | null } {
  const f = {
    value: initial,
    load: async () => (f.value ? structuredClone(f.value) : null),
    save: async (a: StoredAccount) => void (f.value = structuredClone(a)),
    clear: async () => void (f.value = null),
  };
  return f;
}

export const record = (over: Partial<StoredAccount> = {}): StoredAccount => ({
  version: 1,
  email: 'me@example.com',
  subject: 'sub-me@example.com',
  connectedAt: NOW,
  grantedAt: NOW,
  tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 3_600_000, scopes: [...READ_SCOPES] },
  ...over,
});

export function makeAccount(o: {
  config: ClientConfig;
  iosConfig?: ClientConfig;
  fetch: Fetch;
  file?: ReturnType<typeof memoryFile>;
  clock?: { t: number };
  testingMode?: boolean;
  revokeMs?: number;
}) {
  const file = o.file ?? memoryFile(record());
  const clock = o.clock ?? { t: NOW };
  return {
    account: new GoogleAccount({
      file,
      config: o.config,
      iosConfig: o.iosConfig,
      fetch: o.fetch,
      now: () => clock.t,
      testingMode: o.testingMode,
      revokeMs: o.revokeMs,
    }),
    file,
    clock,
  };
}
