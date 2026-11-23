// A side chat's tab title in the title bar: "Side chat", with the account it runs on as its tooltip,
// named as every place names a chat's account (src/session/harness/chatAccount.ts).
import { chatAccountLabel, useComposerFirstTier, useChatAccount, useHarnessAccounts } from '../../session/harness/select';

export function SideChatTitle({ threadId }: { threadId: string | null | undefined }) {
  const chatId = threadId || null;
  const tier = useComposerFirstTier(chatId);
  const h = chatId ? tier : null;
  const own = useChatAccount(h ?? 'codex', h ? chatId : null);
  const account = chatAccountLabel(own, useHarnessAccounts(h ?? 'codex').accounts);
  return <span title={account ? `Side chat · ${account}` : undefined}>Side chat</span>;
}
