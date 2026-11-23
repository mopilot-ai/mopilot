// The model picker's account row: which account a chat runs on, shown when that is a choice; it opens the account list.
import { useChatAccount, useHarnessAccounts, chatAccountLabel, type ChatAccount } from '../../session/harness/select';
import type { HarnessId } from '../../harness/types';
import { AccountAvatar, accountAvatars } from '../accounts/presentation';
import { ChevronRight } from '../ui/icons';

/**
 * The last row of the model picker: the account a chat (or a new chat) on harness `h` runs on, never on the model
 * button itself. Shown only when it tells the user something: the harness has several accounts, or the chat is
 * pinned to one. Its full name is the one wording every surface uses ("Pinned to B · now on A"); `onOpen` opens
 * the harness list (the panel this row is in gives way to it), where the account list flies out beside the harness.
 */
export function AccountRow({ h, chatId, onOpen }: { h: HarnessId; chatId: string | null; onOpen: () => void }) {
  const view = useHarnessAccounts(h);
  const own = useChatAccount(h, chatId);
  if (view.accounts.length < 2 && !own?.pinned) return null;
  const chat: ChatAccount | null = own ?? (view.active ? { id: view.active.id, pinned: false, serving: view.active.id } : null);
  const serving = chat ? view.accounts.find((a) => a.id === chat.serving) : undefined;
  if (!chat || !serving) return null;
  // each account by the name every surface gives it; a chat with an account always has one
  const name = (id: string) => String(chatAccountLabel({ id, pinned: false, serving: id }, view.accounts));
  const label = String(chatAccountLabel(chat, view.accounts));
  // a pin the chat can't use right now names the account it waits for
  const note = chat.pinned ? (chat.id === chat.serving ? 'Pinned to this chat' : `Pinned to ${name(chat.id)}`) : null;
  return (
    <>
      <div className="menu-sep" role="separator" />
      <button
        type="button"
        className="menu-item hp-account"
        onClick={onOpen}
        // → opens the list as a submenu row does, instead of stepping the effort around it
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight') return;
          e.stopPropagation();
          onOpen();
        }}
        aria-haspopup="menu"
        aria-label={`Account: ${label}`}
        title={label}
      >
        {/* the same avatar the account list shows for it: told apart from its neighbours, "?" while unverified (#1930) */}
        <AccountAvatar account={serving} size={18} label={accountAvatars(view.accounts)[view.accounts.indexOf(serving)]} />
        <span className="hp-account-name">{name(serving.id)}</span>
        {note && <span className="hp-account-note">{note}</span>}
        <ChevronRight size={12} className="hp-account-chevron" />
      </button>
    </>
  );
}
