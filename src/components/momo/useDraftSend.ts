// What a draft card knows about sending (MoMo's draft card design): the connected mail accounts for its From chooser (read again when a connector changes), the account chosen (the only one that can send, or the one last sent from, until the user picks; the user's pick is never replaced by another account if it stops working), and how far this note's send got, read once and kept current by main's momoDraft:state. A card with no chat or note (the card outside a MoMo chat) has none of it and no Send.
import { useCallback, useEffect, useState } from 'react';
import type { Send } from '../../../shared/momoDraftSend.mjs';
import type { MomoMailAccount } from '../../lib/native/contracts/momoDraft';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { lastFrom } from './draftLastFrom';

export function useDraftSend(chatId?: string, noteId?: string) {
  const enabled = !!chatId && !!noteId;
  const [accounts, setAccounts] = useState<MomoMailAccount[]>([]);
  const [picked, setPicked] = useState('');
  const [send, setSend] = useState<Send | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await native.momoDraft.accounts();
      setAccounts(r.ok ? r.accounts : []);
    } catch (error) {
      noteIgnored('read the mail accounts for a draft', error);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void reload();
    native.momoDraft.state({ chatId, noteId }).then(
      (r) => live && r.ok && setSend(r.send),
      (error) => noteIgnored('read a draft’s send state', error),
    );
    const offState = native.momoDraft.onState((e) => {
      if (e.chatId === chatId && e.noteId === noteId) setSend(e.send);
    });
    const offConnectors = native.momoConnectors.onChanged(() => void reload());
    return () => {
      live = false;
      offState();
      offConnectors();
    };
  }, [enabled, chatId, noteId, reload]);

  // the default account (see below) until the user picks one; a picked account that can no longer send (disconnected, paused) is
  // never swapped for another behind their back: there is no account until they pick again, and `lost` says why
  const picks = accounts.find((a) => a.id === picked);
  const usable = accounts.filter((a) => a.ok);
  // the default: the one account that can send, or with several the one last sent from; with several and none, the person is asked
  const last = lastFrom();
  const usual = usable.length === 1 ? usable[0] : (usable.find((a) => a.id === last) ?? null);
  const from = picked ? (picks?.ok ? picks : null) : usual;
  const lost = picked !== '' && from === null;
  // sendable: an account can send at all; needsChoice: several can and none is the default (or the picked one stopped working)
  return {
    enabled,
    accounts,
    choices: usable,
    from,
    lost,
    sendable: usable.length > 0,
    needsChoice: usable.length > 0 && from === null,
    pick: setPicked,
    send,
    setSend,
    reload,
  };
}
