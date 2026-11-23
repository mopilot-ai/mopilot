// React binding for the push controller: its permission step and the chat a tapped notification named.
import { useEffect, useState } from 'react';
import type { PushController, PushUi } from './controller';
import { DEFAULT_PREFS } from './prefs';

const idle: PushUi = {
  step: 'unknown',
  target: null,
  busy: false,
  prefs: DEFAULT_PREFS,
  notice: null,
  token: null,
  prefsError: null,
};

export function usePushUi(push: PushController | undefined): PushUi {
  const [ui, setUi] = useState<PushUi>(push ? push.ui() : idle);
  useEffect(() => {
    if (!push) return;
    setUi(push.ui());
    const off = push.subscribe(() => setUi(push.ui()));
    void push.start().catch(() => undefined);
    return () => {
      off();
      push.stop();
    };
  }, [push]);
  return ui;
}

/** Tell the controller which chat is on screen, so its own notifications can be skipped; none when the chat closes or the screen goes. */
export function useOpenChat(push: PushController | undefined, pairId: string | null, chatId: string | null) {
  useEffect(() => {
    push?.setOpenChat(pairId, chatId);
    return () => push?.setOpenChat(null, null);
  }, [push, pairId, chatId]);
}
