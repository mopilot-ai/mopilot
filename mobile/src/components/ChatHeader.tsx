// A chat's header as the baseline draws it: a glass Back, the title (and the line under it), the laptop where it runs with its state dot, and the ⋯ menu with its sheets.
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useMacLink, useMachines } from '../macLink';
import { explain, type Owned } from '../remote/client';
import { useKnownMachines } from '../remote/knownMachines';
import { MoveSheet } from './MoveSheet';
import { hostOfflineLine } from '../remote/machines';
import { archiveChat, pinChat, renameChat, setPermission, UPDATE, type ChatControls } from '../remote/controls';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';
import { BottomSheet } from './BottomSheet';
import { ChatMenu, type ChatMenuItem, type ChatMenuSection } from './ChatMenu';
import { GlassCircle } from './Glass';
import { Group, GroupItem, GroupLabel } from './Grouped';
import { Icon } from './Icon';
import { PageHeader } from './PageHeader';
import { ComposerButton } from './ComposerBox';
import { typo } from '../typography';
import { usePerfRender } from '../perfLog';

type Sheet = 'permissions' | 'rename' | 'move' | null;

/** "+4 −2"; "2 files" when the files changed no lines (renamed, binary); "None yet"; nothing before the counts are read. */
export function changesValue(lines: { added: number; removed: number; files: number } | null | undefined) {
  if (!lines) return null;
  if (lines.added || lines.removed) return `+${lines.added} −${lines.removed}`;
  return lines.files ? `${lines.files} ${lines.files === 1 ? 'file' : 'files'}` : 'None yet';
}

/** A screen pushed over a chat (Changes, Terminal): the glass Back, its name and the line under it. */
export function ScreenHeader({
  title,
  subtitle,
  back,
  backLabel = 'Back to chat',
}: {
  title: string;
  subtitle?: string;
  back: () => void;
  /** what Back is read as: the chat it returns to by default */
  backLabel?: string;
}) {
  useHardwareBack(back);
  return (
    <PageHeader
      title={title}
      subtitle={subtitle}
      left={
        <GlassCircle label={backLabel} onPress={back}>
          <Icon name="chevron.left" glyph="‹" size={20} />
        </GlassCircle>
      }
    />
  );
}

export function useChatHeader({
  request,
  chatId,
  title,
  subtitle,
  back,
  backLabel = 'Back to chats',
  review,
  terminal,
  lines,
  pinned = false,
  changed,
  archived,
  where,
  controls,
  reload,
  unsupported,
  hostId,
}: {
  request: Owned;
  chatId: string;
  title?: string;
  subtitle?: string;
  back: () => void;
  /** what Back is read as: the chat list, or the parent a sub-session was opened from */
  backLabel?: string;
  /** opens Changes; absent where review is not offered */
  review?: () => void;
  /** opens the Terminal; absent where the Mac offers none */
  terminal?: () => void;
  /** the lines the chat changed, for the Changes entry */
  lines?: { added: number; removed: number; files: number } | null;
  pinned?: boolean;
  /** the chat list changed (pinned, renamed): read it again */
  changed?: () => void;
  /** the chat was archived: leave it */
  archived?: () => void;
  /** opens where the chat runs (the Mac's row) */
  where?: () => void;
  /** the chat's controls as read for this screen (useChatControls); null greys the settings */
  controls: ChatControls | null;
  /** reads the controls again after a change */
  reload: () => void;
  /** why this chat has no controls on the phone (it runs on a machine that offers none yet), in the machine's name; absent when the Mac just lacks them */
  unsupported?: string | null;
  /** the Host the chat runs on; absent for a chat on the Mac itself */
  hostId?: string;
}) {
  usePerfRender('Thread'); // called once per render of the chat screen that owns this header
  const theme = useTheme();
  const mac = useMacLink();
  // the live list for what can be done now (a list kept from before Host access closed offers nothing); the kept one only names a machine while the Mac is away
  const live = useMachines();
  const machines = useKnownMachines();
  // a chat on a Host runs on while the Mac is away: the line under the title says where, as the chat list's row does
  const runsOn = mac.online ? null : hostOfflineLine(machines, hostId);
  // the Mac's button names the Mac; for a chat on a Host it does not say the chat runs there
  useHardwareBack(back);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function act(work: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await work();
      after?.();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }
  // a chat on a machine says so on the button, where it names the Mac's link for any other
  const machineName = hostId ? machines?.find((m) => m.id === hostId)?.name : undefined;
  const methods = controls?.methods;
  const options = controls?.options;
  const value = changesValue(lines);
  const screens: ChatMenuItem[] = [];
  if (review) screens.push({ label: value ? `Changes  ${value}` : 'Changes', icon: 'plus.forwardslash.minus', onPress: review });
  if (terminal) screens.push({ label: 'Terminal', icon: 'apple.terminal', onPress: terminal });
  const rename: ChatMenuItem = {
    label: 'Rename',
    icon: 'pencil',
    disabled: !methods?.rename,
    onPress: () => {
      setName(title ?? '');
      setSheet('rename');
    },
  };
  const archive: ChatMenuItem = {
    label: 'Archive',
    icon: 'archivebox',
    destructive: true,
    disabled: !methods?.archive,
    onPress: () => void act(() => archiveChat(request, chatId), archived),
  };
  const settings: ChatMenuItem[] = [
    {
      label: options?.permissionLabel ? `Permissions  ${options.permissionLabel}` : 'Permissions',
      icon: 'checkmark.shield',
      disabled: !methods?.permit,
      onPress: () => setSheet('permissions'),
    },
    {
      label: pinned ? 'Unpin' : 'Pin',
      icon: pinned ? 'pin.slash' : 'pin',
      disabled: !methods?.pin,
      onPress: () => void act(() => pinChat(request, chatId, !pinned), changed),
    },
    ...(methods?.rename ? [rename] : []),
    // only with the Mac there (it carries the chat over) and a machine to move to; a Mac with no Hosts sends none
    ...(mac.online && live && live.length > 1
      ? [{ label: 'Move to another computer', icon: 'arrow.left.arrow.right' as const, onPress: () => setSheet('move') }]
      : []),
  ];
  // what this Mac cannot do yet is grouped under the one thing that gives it
  const later = [rename, archive].filter((item) => item.disabled);
  const sections: ChatMenuSection[] = [
    { items: screens },
    { items: settings },
    ...(methods?.archive ? [{ items: [archive] }] : []),
    ...(later.length ? [{ title: unsupported ?? UPDATE.menu, items: later }] : []),
  ];
  return {
    bar: (
      <>
        <PageHeader
          title={title ?? 'Chat'}
          subtitle={runsOn ?? subtitle}
          left={
            <GlassCircle label={backLabel} onPress={back}>
              <Icon name="chevron.left" glyph="‹" size={20} />
            </GlassCircle>
          }
          right={
            <>
              <GlassCircle
                label={machineName ? `Runs on ${machineName}` : hostId ? `${mac.name}, ${mac.word}` : `Runs on ${mac.name}, ${mac.word}`}
                badge={mac.online ? 'on' : 'off'}
                onPress={where ?? (() => undefined)}
              >
                <Icon name={mac.online ? 'laptopcomputer' : 'laptopcomputer.slash'} glyph="💻" size={18} />
              </GlassCircle>
              <ChatMenu sections={sections.filter((section) => section.items.length > 0)} />
            </>
          }
        />
        {!!error && (
          <Text accessibilityRole="alert" style={{ ...typo.footnote, color: theme.bad, paddingHorizontal: 24, paddingBottom: 6 }}>
            {error}
          </Text>
        )}
      </>
    ),
    sheets: (
      <>
        <BottomSheet open={sheet === 'permissions'} title="Permissions" onClose={() => setSheet(null)}>
          {options && (
            <>
              <Group>
                {options.permissions.map((p) => (
                  <GroupItem
                    key={p.id}
                    title={p.label}
                    // a mode the Mac cannot use now says why instead of what it does
                    detail={p.disabled ?? (p.detail || undefined)}
                    end={p.id === options.permission ? 'check' : 'none'}
                    onPress={
                      p.disabled
                        ? undefined
                        : p.id === options.permission
                          ? () => setSheet(null)
                          : () =>
                              void act(
                                () => setPermission(request, methods!.permit!, chatId, p.id),
                                () => {
                                  setSheet(null);
                                  reload();
                                },
                              )
                    }
                  />
                ))}
              </Group>
              {options.macOnly.map((label) => (
                <GroupLabel key={label}>{`${label} is only available on your Mac.`}</GroupLabel>
              ))}
              {options.permission === null && !!options.permissionLabel && (
                <GroupLabel>{`Now: ${options.permissionLabel}, which only your Mac can set.`}</GroupLabel>
              )}
            </>
          )}
        </BottomSheet>
        {!!live && (
          <MoveSheet
            open={sheet === 'move'}
            onClose={() => setSheet(null)}
            request={request}
            chatId={chatId}
            hostId={hostId}
            machines={live}
            agent={controls?.harness ?? null}
            moved={() => {
              changed?.();
              reload();
            }}
          />
        )}
        <BottomSheet open={sheet === 'rename'} title="Rename chat" onClose={() => setSheet(null)}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 }}>
            <TextInput
              autoFocus
              value={name}
              onChangeText={setName}
              placeholder="Chat name"
              placeholderTextColor={theme.ink3}
              accessibilityLabel="Chat name"
              returnKeyType="done"
              style={{
                flex: 1,
                minHeight: 48,
                borderRadius: 24,
                paddingHorizontal: 16,
                ...typo.body,
                color: theme.ink,
                backgroundColor: theme.surface,
              }}
            />
            <ComposerButton
              label="Save name"
              strong
              disabled={busy || !name.trim()}
              icon={<Icon name="checkmark" glyph="✓" size={18} color={theme.btnInk} />}
              onPress={() =>
                void act(
                  () => renameChat(request, chatId, name.trim()),
                  () => {
                    setSheet(null);
                    changed?.();
                  },
                )
              }
            />
          </View>
        </BottomSheet>
      </>
    ),
  };
}

/**
 * The header with its sheets in one piece. A screen that has content after the header draws the sheets itself, last
 * (`useChatHeader`): a sheet drawn before the page body would sit under it.
 */
export function ChatHeader(props: Parameters<typeof useChatHeader>[0]) {
  const { bar, sheets } = useChatHeader(props);
  return (
    <>
      {bar}
      {sheets}
    </>
  );
}
