// Remote Control for the chat's Claude Code session: the composer switch and /remote-control turn it on or off in main
// (electron/claudeRemoteControl.cjs), which reports the link back as the chat's session state.
import { native } from '../../../lib/native';
import type { RemoteControlView } from '../../../store/session/sessionState';
import { errorText } from '../../../lib/ignored';
import { get as getState, threadTitle, toast } from '../../../store/core';
import { nativeOf } from '../../../store/chats';

/** Link the chat's running Claude Code session to claude.ai, or take the link down. A failure is said in a toast, never silent. */
export async function setRemoteControl(threadId: string, on: boolean) {
  try {
    const view = (await native.claude.control(nativeOf(threadId), 'remoteControl', {
      on,
      title: threadTitle(getState().threads[threadId]),
    })) as RemoteControlView | null;
    // main answers null for a session that isn't running
    if (!view) toast('Remote Control links a running Claude Code session. Send a message first.', 'error');
    else if (on && (view.state === 'error' || view.state === 'unavailable'))
      toast(view.error ?? "Couldn't connect Remote Control", 'error');
  } catch (e) {
    toast(`Couldn't ${on ? 'turn on' : 'turn off'} Remote Control: ${errorText(e)}`, 'error');
  }
}
