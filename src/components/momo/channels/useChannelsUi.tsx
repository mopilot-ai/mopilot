// What MoMo's page does with channels (A2), apart from how it looks: the list and what is shown now (Main, Everything or one channel, read from the route and the store), the rail with its rows, and every call a row or the channel's own header can make (open, create by name, rename, instructions, move, archive, delete, groups) with the dialogs they ask through. Nothing is drawn while channels are off (`enabled` false), and a call that fails says why in the user's words, in its dialog or as a toast.
import { useMemo, useState, type ReactNode } from 'react';
import { native } from '../../../lib/native';
import { navigate } from '../../../store/panes';
import { toast, useStore } from '../../../store/core';
import { momoChannelIdOf } from '../../../../shared/momoChat.mjs';
import { channelCall, useMomoChannels } from './channelsData';
import type { MomoChannel, MomoChannelGroup } from '../../../lib/native/contracts/momoChannels';
import { ChannelsRail, type RailActions, type RailView } from './ChannelsRail';
import { DeleteDialog, InstructionsDialog, NameDialog } from './ChannelDialogs';
import { CHANNEL_COPY as C } from './channelCopy';

/** The route's chat id for Everything: not a chat, the page draws the feed instead. */
export const EVERYTHING = 'momo:everything';

type Dialog =
  | { kind: 'new'; group?: boolean }
  | { kind: 'rename'; channel: MomoChannel }
  | { kind: 'renameGroup'; group: MomoChannelGroup }
  | { kind: 'instructions'; channel: MomoChannel; initial: string }
  | { kind: 'delete'; channel: MomoChannel };

export interface ChannelsUi {
  enabled: boolean;
  view: RailView;
  /** the channel being shown, if one is */
  channel: MomoChannel | null;
  channels: MomoChannel[];
  groups: MomoChannelGroup[];
  actions: RailActions;
  /** the rail's list (replaces its single Everything row) */
  rail: ReactNode;
  newChannel: () => void;
  newGroup: () => void;
  dialogs: ReactNode;
}

export function useChannelsUi(): ChannelsUi {
  const list = useMomoChannels();
  const chatId = useStore((s) => (s.route.name === 'momo' ? s.route.chatId : undefined));
  const tag = useStore((s) => (chatId ? s.momoChats[chatId] : undefined));
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const shownId = useMemo(() => momoChannelIdOf({ momo: tag ?? '' }), [tag]);
  const channel = list.enabled ? (list.channels.find((c) => c.id === shownId) ?? null) : null;
  // Memory and Tasks are pages beside the chat: none of the rail's places is the one shown
  const onPage = useStore((s) => s.route.name === 'momo' && (s.route.tab === 'memory' || s.route.tab === 'tasks'));
  const view: RailView = onPage
    ? { kind: 'none' }
    : chatId === EVERYTHING
      ? { kind: 'everything' }
      : channel
        ? { kind: 'channel', id: channel.id }
        : { kind: 'main' };
  const fail = (error: string) => toast(error, 'error');
  const home = () => navigate({ name: 'momo', tab: 'chat' });

  const open = async (id: string) => {
    const r = await channelCall(
      () => native.momoChannels.chat(id),
      (x) => x.chatId,
    );
    if (r.ok) navigate({ name: 'momo', tab: 'chat', chatId: r.value });
    else fail(r.error);
  };
  /** Runs a change; resolves the error to show in a dialog, or null once it worked. */
  const change = async (run: () => Promise<{ ok: boolean }>) => {
    const r = await channelCall(run, () => null);
    if (r.ok) list.reload();
    return r.ok ? null : r.error;
  };
  const toastChange = async (run: () => Promise<{ ok: boolean }>) => {
    const error = await change(run);
    if (error) fail(error);
    return error === null;
  };
  /** A toast for a change that worked, with Undo: `undo` runs the opposite change and resolves its error, `done` says it was undone. */
  const undoable = (text: string, undo: () => Promise<string | null>, done: string) =>
    toast(text, 'info', {
      action: {
        label: C.undo,
        run: () => void undo().then((error) => toast(error ?? done, error ? 'error' : 'info')),
      },
    });
  const groupName = (id: string | null) => list.groups.find((g) => g.id === id)?.name ?? '';
  const moveChannel = async (c: MomoChannel, group: string | null) => {
    if (!(await toastChange(() => native.momoChannels.move(c.id, group))) || c.group === group) return;
    const back = c.group;
    const said = (to: string | null) => (to ? C.moved(c.name, groupName(to)) : C.movedOut(c.name));
    undoable(said(group), () => change(() => native.momoChannels.move(c.id, back)), said(back));
  };
  const actions: RailActions = {
    openMain: home,
    openEverything: () => navigate({ name: 'momo', tab: 'chat', chatId: EVERYTHING }),
    openChannel: (id) => void open(id),
    rename: (c) => setDialog({ kind: 'rename', channel: c }),
    instructions: (c) =>
      void channelCall(
        () => native.momoChannels.getInstructions(c.id),
        (r) => r.text,
      ).then((r) => (r.ok ? setDialog({ kind: 'instructions', channel: c, initial: r.value }) : fail(r.error))),
    move: (c, group) => void moveChannel(c, group),
    moveById: (id, group) => {
      const c = list.channels.find((x) => x.id === id);
      if (c) void moveChannel(c, group);
      else void toastChange(() => native.momoChannels.move(id, group));
    },
    reorder: (c, dir) => void toastChange(() => native.momoChannels.reorder(c.id, dir)),
    archive: (c) =>
      void toastChange(() => native.momoChannels.archive(c.id)).then((ok) => {
        if (!ok) return;
        undoable(C.archived(c.name), () => change(() => native.momoChannels.restore(c.id)), C.unarchived(c.name));
        if (channel?.id === c.id) home();
      }),
    remove: (c) => setDialog({ kind: 'delete', channel: c }),
    renameGroup: (g) => setDialog({ kind: 'renameGroup', group: g }),
    removeGroup: (g) => {
      const members = list.channels.filter((c) => c.group === g.id).map((c) => c.id);
      void toastChange(() => native.momoChannels.deleteGroup(g.id)).then(
        (ok) =>
          ok && undoable(C.groupDeleted(g.name), () => change(() => native.momoChannels.restoreGroup(g, members)), C.groupBack(g.name)),
      );
    },
    create: { channel: () => setDialog({ kind: 'new' }), group: () => setDialog({ kind: 'new', group: true }) },
  };

  const rail = list.enabled ? <ChannelsRail channels={list.channels} groups={list.groups} view={view} act={actions} /> : null;

  const close = () => setDialog(null);
  let dialogs: ReactNode = null;
  if (dialog?.kind === 'new')
    dialogs = (
      <NameDialog
        group={dialog.group}
        onClose={close}
        submit={async (name) => {
          if (dialog.group) return change(() => native.momoChannels.createGroup(name));
          const r = await channelCall(
            () => native.momoChannels.create(name),
            (x) => x.channel.id,
          );
          if (!r.ok) return r.error;
          list.reload();
          void open(r.value);
          return null;
        }}
      />
    );
  else if (dialog?.kind === 'rename')
    dialogs = (
      <NameDialog
        rename
        initial={dialog.channel.name}
        onClose={close}
        submit={async (name) => {
          const old = dialog.channel;
          const error = await change(() => native.momoChannels.rename(old.id, name));
          const now = name.trim();
          if (error === null && now !== old.name)
            undoable(C.renamed(now), () => change(() => native.momoChannels.rename(old.id, old.name)), C.renamedBack(old.name));
          return error;
        }}
      />
    );
  else if (dialog?.kind === 'renameGroup')
    dialogs = (
      <NameDialog
        rename
        group
        initial={dialog.group.name}
        onClose={close}
        submit={(name) => change(() => native.momoChannels.renameGroup(dialog.group.id, name))}
      />
    );
  else if (dialog?.kind === 'instructions')
    dialogs = (
      <InstructionsDialog
        initial={dialog.initial}
        onClose={close}
        submit={(text) => change(() => native.momoChannels.setInstructions(dialog.channel.id, text))}
      />
    );
  else if (dialog?.kind === 'delete') {
    const c = dialog.channel;
    const leave = (error: string | null) => (error === null && channel?.id === c.id ? home() : undefined, error);
    dialogs = (
      <DeleteDialog
        name={c.name}
        onClose={close}
        remove={async () => leave(await change(() => native.momoChannels.delete(c.id)))}
        archive={async () => leave(await change(() => native.momoChannels.archive(c.id)))}
      />
    );
  }
  return {
    enabled: list.enabled,
    view,
    channel,
    channels: list.channels,
    groups: list.groups,
    actions,
    rail,
    newChannel: () => setDialog({ kind: 'new' }),
    newGroup: () => setDialog({ kind: 'new', group: true }),
    dialogs,
  };
}
