// Resolve Chrome continuation from main at the user's click, retiring reads with their owning notice.
import { useEffect, useRef, useState } from 'react';
import { native } from './native';
import { errorText } from './ignored';
import type { SendReceipt } from '../../shared/sendReceipt.mjs';
import type { HandoffPrecondition } from '../../shared/chromeHandoff.mjs';

export function useChromeContinuation(owner: string | null) {
  const current = useRef({ owner, serial: 0, busy: false, retained: null as string | null });
  const [busy, setBusy] = useState(false);
  const [retained, setRetained] = useState(false);
  if (current.current.owner !== owner) current.current = { owner, serial: current.current.serial + 1, busy: false, retained: null };
  const state = current.current;
  const cancel = () => {
    current.current.serial++;
    current.current.busy = false;
    setBusy(false);
  };
  useEffect(() => {
    setBusy(false);
    setRetained(false);
    return () => {
      state.serial++;
      state.busy = false;
    };
  }, [state]);
  const run = async (
    request: { chatId: string; url: string; signedIn?: boolean },
    send: (message: string, precondition: HandoffPrecondition, received: (receipt: SendReceipt) => void) => Promise<unknown>,
    settled: (error: string | null) => void,
  ) => {
    if (owner === null || current.current.owner !== owner || current.current.busy || current.current.retained) return;
    const serial = ++current.current.serial;
    const live = () => current.current === state && state.serial === serial;
    current.current.busy = true;
    setBusy(true);
    try {
      const retainedMessage = 'Still queued. Remove it below before retrying.';
      const result = await native.browser.handoffContinuation(request);
      if (!live()) return;
      if (
        !result ||
        typeof result.message !== 'string' ||
        !result.message.trim() ||
        typeof result.precondition?.token !== 'string' ||
        result.precondition.url !== request.url
      )
        throw new Error('Could not read the chat’s current Chrome tools. Try again.');
      const sent = await send(result.message, result.precondition, (receipt) => {
        if (receipt.action === 'queued' && receipt.error) {
          state.retained = receipt.id;
          if (live()) setRetained(true);
        }
      });
      if (live())
        settled(state.retained ? retainedMessage : sent === false ? 'Could not resume the task. Return to the chat to continue.' : null);
    } catch (error) {
      if (live()) settled(`Could not resume the task: ${errorText(error)}`);
    } finally {
      if (live()) {
        current.current.busy = false;
        setBusy(false);
      }
    }
  };
  const removeRetained = async (chatId: string, settled: (error: string | null) => void) => {
    if (current.current !== state || !state.retained || state.busy) return;
    const serial = ++state.serial;
    const live = () => current.current === state && state.serial === serial;
    state.busy = true;
    setBusy(true);
    try {
      const removed = await native.session.removeQueued(chatId, state.retained);
      if (!live()) return;
      if (removed !== true) {
        settled('That continuation is no longer queued. Check the chat before continuing.');
        return;
      }
      state.retained = null;
      setRetained(false);
      settled(null);
    } catch (error) {
      if (live()) settled(`Could not remove the queued continuation: ${errorText(error)}`);
    } finally {
      if (live()) {
        state.busy = false;
        setBusy(false);
      }
    }
  };
  return { busy, retained, run, cancel, removeRetained };
}
