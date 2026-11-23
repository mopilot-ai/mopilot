// What a channel's chat has that main's has not (A2): its header (#name and the menu: rename, instructions, move, archive, delete) and, until the user answers it, MoMo's first row "This channel is for one topic. Want me to suggest tasks I can do here?" with Yes, No and Not now. Yes only records the answer and sends MoMo a normal message asking it to suggest tasks; the store of suggestions is a later change. The row is the page's own, over an empty chat: it is not a message of the chat.
import { useState } from 'react';
import { native } from '../../../lib/native';
import { sendMessage } from '../../../store/send';
import { toast, useStore } from '../../../store/core';
import { errorText } from '../../../lib/ignored';
import type { MomoChannel, MomoChannelGroup, MomoChannelWelcome } from '../../../lib/native/contracts/momoChannels';
import { MessageSquare } from '../../ui/icons';
import { ChannelMenu, type RailActions } from './ChannelsRail';
import { CHANNEL_COPY as C } from './channelCopy';
import styles from './channels.module.css';

/** The channel's name and its menu, in the chat's header. */
export function ChannelHeader({ channel, groups, act }: { channel: MomoChannel; groups: MomoChannelGroup[]; act: RailActions }) {
  return (
    <div className={`${styles.row} ${styles.headGap}`} data-channel-header="">
      <MessageSquare size={16} strokeWidth={1.7} aria-hidden="true" />
      <span className={styles.headName}>{channel.name}</span>
      <ChannelMenu channel={channel} groups={groups} act={act} />
    </div>
  );
}

/** MoMo's first row in a new channel. */
export function WelcomeRow({ channel, chatId }: { channel: MomoChannel; chatId: string }) {
  const empty = useStore((s) => !s.threads[chatId]?.turns?.length);
  const [busy, setBusy] = useState(false);
  if (channel.welcome !== null || !empty) return null;
  const answer = async (a: MomoChannelWelcome) => {
    setBusy(true);
    try {
      const r = await native.momoChannels.welcome(channel.id, a);
      if (!r.ok) throw new Error(r.error);
      // Yes is a normal message the chat answers; the suggestion store that would hold them comes later
      if (a === 'yes') void sendMessage(chatId, C.suggest, [], { human: true });
    } catch (e) {
      toast(errorText(e), 'error');
      setBusy(false);
    }
  };
  return (
    <div className={styles.welcome} data-welcome="">
      <p className={styles.welcomeText}>{C.welcome}</p>
      <div className={styles.chips} role="group" aria-label={C.welcome}>
        {(
          [
            ['yes', C.yes],
            ['no', C.no],
            ['later', C.notNow],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={styles.chip} disabled={busy} onClick={() => void answer(id)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
