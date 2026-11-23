// window.native.accounts's types (Codex accounts), merged into NativeApi; the calls are declared in electron/bridge/accounts.cjs.
import type { AccountsEvent, AccountsState } from '../native';
import type { UsageReason } from '../../../shared/model/harness';
import type { ConsumeAccountRateLimitResetCreditResponse } from '../../protocol/v2/ConsumeAccountRateLimitResetCreditResponse';
import type { GetAccountRateLimitsResponse } from '../../protocol/v2/GetAccountRateLimitsResponse';

declare module '../native' {
  interface NativeApi {
    accounts: {
      list(): Promise<AccountsState>;
      apply(): Promise<AccountsState>;
      switchTo(id: string): Promise<AccountsState>;
      login(targetId?: string | null): Promise<AccountsState>;
      cancelLogin(): Promise<AccountsState>;
      remove(id: string): Promise<AccountsState>;
      /** stores an OpenAI API key as an account and switches to it; `replaceId` replaces that key account's key */
      addApiKey(key: string, baseUrl?: string, replaceId?: string | null): Promise<AccountsState>;
      setMode(mode: 'subscription' | 'apiKey' | 'mopilot'): Promise<AccountsState>;
      /** reads each ChatGPT account's usage that `reason` finds due (electron/identity/contract/usageRefresh.cjs) */
      refreshUsage(reason: UsageReason): Promise<AccountsState>;
      /** Reset cards and redemption are scoped to this account, independently of pool switches. */
      resetCredits(id: string): Promise<GetAccountRateLimitsResponse>;
      consumeResetCredit(id: string, creditId?: string | null): Promise<ConsumeAccountRateLimitResetCreditResponse>;
      setAutoSwitch(on: boolean): Promise<AccountsState>;
      setPool(mode: 'spread' | 'single'): Promise<AccountsState>;
      /** put a chat on one account; null returns it to the pool */
      pinChat(threadId: string, id: string | null): Promise<AccountsState>;
      onEvent(cb: (e: AccountsEvent) => void): () => void;
    };
  }
}
