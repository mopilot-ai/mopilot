// MoMo's channels on the classic phone (A2): the picker sheet over MoMo's page, listing Main, the groups with their channels and the loose ones, each with a menu (Rename, Move to group, Archive, Delete), and the small forms behind it: a name only for a new channel or group ("A place for one topic. Your main chat stays as it is."), rename, a move into a group or out, and a delete that says it can't be undone, offers to archive instead and waits two seconds. The Mac's own words for a refusal (a taken name, the cap of twelve) show under the field. Words are catalog keys (`momoChannels.*`).
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { BottomSheet } from '../components/BottomSheet';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { MenuButton } from '../components/Menu';
import { Button, ErrorLine, Field } from '../components/ui';
import { messageOf } from '../momo/api';
import type { createChannelsApi } from '../momo/channelsApi';
import type { Channel, ChannelList, Group as ChannelGroup } from '../momo/channelsContract';
import { useTheme } from '../theme';
import { useTranslation } from '../ui/i18n';
import { typo } from '../typography';

/** How long Delete stays off after its page opens. */
export const DELETE_DELAY_MS = 2000;

type Step =
  | { kind: 'list' }
  | { kind: 'new'; group: boolean }
  | { kind: 'rename'; channel: Channel }
  | { kind: 'renameGroup'; group: ChannelGroup }
  | { kind: 'move'; channel: Channel }
  | { kind: 'delete'; channel: Channel };

export function ChannelSheet({
  open,
  onClose,
  api,
  list,
  current,
  pick,
  changed,
  gone,
}: {
  open: boolean;
  onClose: () => void;
  api: ReturnType<typeof createChannelsApi>;
  list: ChannelList;
  /** the channel shown now, or null for Main */
  current: string | null;
  /** open Main (null) or a channel */
  pick: (channelId: string | null) => void;
  /** the list changed: read it again */
  changed: () => void;
  /** a channel the page was showing is gone (archived or deleted): the page goes to Main */
  gone: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const back = () => {
    setStep({ kind: 'list' });
    setError(null);
    setText('');
  };
  useEffect(() => {
    if (open) return;
    setStep({ kind: 'list' });
    setError(null);
    setText('');
  }, [open]);
  // Delete waits until its page has been in front for two seconds
  useEffect(() => {
    setReady(false);
    if (step.kind !== 'delete') return;
    const timer = setTimeout(() => setReady(true), DELETE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [step.kind]);
  /** Runs a change; a refusal stays on the page in the Mac's words, a success returns to the list and reads it again. */
  const run = async (work: () => Promise<unknown>, then?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      changed();
      then?.();
      back();
    } catch (e) {
      setError(messageOf(e));
    }
    setBusy(false);
  };
  const form = (title: string, hint: string, action: string, submit: () => Promise<unknown>, then?: () => void) => (
    <BottomSheet open={open} title={title} onClose={onClose} onBack={back}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}>
        <Text style={{ ...typo.subhead, color: theme.ink2 }}>{hint}</Text>
        <Field
          accessibilityLabel={t('momoChannels.name')}
          placeholder={t('momoChannels.name')}
          value={text}
          onChangeText={setText}
          autoFocus
          autoCapitalize="sentences"
          maxLength={120}
        />
        <ErrorLine text={error} />
        <Button title={action} disabled={busy || !text.trim()} onPress={() => void run(submit, then)} />
      </View>
    </BottomSheet>
  );

  if (step.kind === 'new')
    return form(
      step.group ? t('momoChannels.newGroup') : t('momoChannels.new'),
      step.group ? t('momoChannels.groupHint') : t('momoChannels.createHint'),
      t('momoChannels.create'),
      step.group
        ? () => api.createGroup(text.trim())
        : async () => {
            const made = await api.create(text.trim());
            pick(made.id);
          },
      step.group ? undefined : onClose,
    );
  if (step.kind === 'rename') {
    const id = step.channel.id;
    return form(t('momoChannels.rename'), t('momoChannels.createHint'), t('momoChannels.save'), () => api.rename(id, text.trim()));
  }
  if (step.kind === 'renameGroup') {
    const id = step.group.id;
    return form(t('momoChannels.renameGroup'), t('momoChannels.groupHint'), t('momoChannels.save'), () => api.renameGroup(id, text.trim()));
  }
  if (step.kind === 'move') {
    const channel = step.channel;
    return (
      <BottomSheet open={open} title={t('momoChannels.move')} onClose={onClose} onBack={back}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
          <ErrorLine text={error} />
          <Group>
            {[
              ...list.groups.map((g) => (
                <GroupItem
                  key={g.id}
                  title={g.name}
                  end={channel.group === g.id ? 'check' : 'none'}
                  onPress={() => void run(() => api.move(channel.id, g.id))}
                />
              )),
              <GroupItem
                key="none"
                title={t('momoChannels.noGroup')}
                end={channel.group === null ? 'check' : 'none'}
                onPress={() => void run(() => api.move(channel.id, null))}
              />,
            ]}
          </Group>
        </View>
      </BottomSheet>
    );
  }
  if (step.kind === 'delete') {
    const channel = step.channel;
    const leave = () => channel.id === current && gone(channel.id);
    return (
      <BottomSheet open={open} title={t('momoChannels.deleteTitle', { name: channel.name })} onClose={onClose} onBack={back}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}>
          <Text style={{ ...typo.body, color: theme.ink }}>{t('momoChannels.deleteBody')}</Text>
          <ErrorLine text={error} />
          <Button
            secondary
            title={t('momoChannels.archiveInstead')}
            disabled={busy}
            onPress={() => void run(() => api.archive(channel.id), leave)}
          />
          <Button
            danger
            title={t('momoChannels.delete')}
            disabled={!ready || busy}
            onPress={() => void run(() => api.remove(channel.id), leave)}
          />
        </View>
      </BottomSheet>
    );
  }

  const row = (c: Channel) => (
    <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
      <View style={{ flex: 1 }}>
        <GroupItem title={`#${c.name}`} end={current === c.id ? 'check' : 'none'} onPress={() => (pick(c.id), onClose())} />
      </View>
      <View style={{ paddingRight: 8 }}>
        <MenuButton
          label={`${t('momoChannels.menu')}: ${c.name}`}
          items={[
            {
              label: t('momoChannels.rename'),
              onPress: () => (setText(c.name), setStep({ kind: 'rename', channel: c })),
            },
            { label: t('momoChannels.move'), onPress: () => setStep({ kind: 'move', channel: c }) },
            {
              label: t('momoChannels.archive'),
              onPress: () =>
                void run(
                  () => api.archive(c.id),
                  () => c.id === current && gone(c.id),
                ),
            },
            { label: t('momoChannels.delete'), onPress: () => setStep({ kind: 'delete', channel: c }) },
          ]}
        />
      </View>
    </View>
  );
  const loose = list.channels.filter((c) => !c.group || !list.groups.some((g) => g.id === c.group));
  return (
    <BottomSheet open={open} title={t('momoChannels.title')} onClose={onClose}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
        <ErrorLine text={error} />
        <Group>
          {[
            <GroupItem
              key="main"
              title={t('momoChannels.main')}
              end={current === null ? 'check' : 'none'}
              onPress={() => (pick(null), onClose())}
            />,
            ...loose.map(row),
          ]}
        </Group>
        {list.groups.map((g) => {
          const inside = list.channels.filter((c) => c.group === g.id);
          return (
            <View key={g.id}>
              <GroupLabel>{g.name}</GroupLabel>
              <Group>{inside.length ? inside.map(row) : [<GroupItem key="empty" title={t('momoChannels.emptyGroup')} />]}</Group>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                <Button
                  secondary
                  title={t('momoChannels.renameGroup')}
                  onPress={() => (setText(g.name), setStep({ kind: 'renameGroup', group: g }))}
                />
                <Button secondary title={t('momoChannels.deleteGroup')} onPress={() => void run(() => api.removeGroup(g.id))} />
              </View>
            </View>
          );
        })}
        <Group>
          {[
            <GroupItem
              key="new"
              title={t('momoChannels.new')}
              tone="link"
              onPress={() => (setText(''), setStep({ kind: 'new', group: false }))}
            />,
            <GroupItem
              key="group"
              title={t('momoChannels.newGroup')}
              tone="link"
              onPress={() => (setText(''), setStep({ kind: 'new', group: true }))}
            />,
          ]}
        </Group>
      </View>
    </BottomSheet>
  );
}

/**
 * MoMo's first row in a new channel, over an empty chat: Yes, No and Not now. Each is recorded on the Mac; Yes also sends MoMo a normal message
 * asking it to suggest tasks (the store of suggestions comes later). It is the page's own row, not a message of the chat.
 */
export function ChannelWelcome({
  api,
  channel,
  send,
  changed,
}: {
  api: ReturnType<typeof createChannelsApi>;
  channel: Channel;
  /** a normal message to the channel's chat */
  send: (text: string) => void;
  changed: () => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (channel.welcome !== null) return null;
  const answer = async (a: 'yes' | 'no' | 'later') => {
    setBusy(true);
    setError(null);
    try {
      await api.welcome(channel.id, a);
      if (a === 'yes') send(t('momoChannels.suggest'));
      changed();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  return (
    <View accessibilityLabel={t('momoChannels.welcome')} style={{ gap: 10, paddingVertical: 12 }}>
      <Text style={{ ...typo.body, color: theme.ink }}>{t('momoChannels.welcome')}</Text>
      <ErrorLine text={error} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button secondary title={t('momoChannels.yes')} disabled={busy} onPress={() => void answer('yes')} />
        <Button secondary title={t('momoChannels.no')} disabled={busy} onPress={() => void answer('no')} />
        <Button secondary title={t('momoChannels.notNow')} disabled={busy} onPress={() => void answer('later')} />
      </View>
    </View>
  );
}
