// One chat in the list as a tappable row, as in Claude's Code list: a status glyph and its 17 pt title, then one grey line (status · age · the computer when there are several · login · +N −M) and where it runs.
import { memo } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useMacLink } from '../macLink';
import { useLargeText } from '../useLargeText';
import { accountChip, chatChips, type ChatStateChip } from '../presentation/chatChips';
import { sessionState } from '../presentation/sessionState';
import { hostCardLine, hostOfflineLine, type Machine } from '../remote/machines';
import { Icon } from './Icon';
import { StatusGlyph } from './SessionRow';
import { ageLabel, changesOf, type Changes } from '../presentation/chatRowParts';
import { useTheme } from '../theme';
import { typo } from '../typography';

export type ChatListItem = {
  id: string;
  title?: string;
  state?: string;
  unread?: boolean;
  harness?: string;
  /** When the computer last heard from the chat (epoch ms). */
  at?: number;
  pinned?: boolean;
  project?: string | null;
  projectId?: string | null;
  /** What tells this chat's project from another of its name (sent by the Mac for a shared name only). */
  projectHint?: string;
  /** The login the chat runs on, where the Mac has several to tell apart. */
  account?: string;
  /** The login is the computer's default one: the row does not say it (the Mac flags it; an older Mac sends none and the row says it as before). */
  accountDefault?: boolean;
  /** The lines the chat's folder changed since its last commit; an older computer sends none. */
  changes?: Changes;
  /** The chat that started this one (a linked session), which the list nests it under; an older computer sends none. */
  parentId?: string;
  /** How a linked session's last turn ended: finished, failed, stopped or lost. */
  ended?: string;
  /** The host machine the chat runs on, when it is not the Mac (Remote Run); an older computer sends none. */
  hostId?: string;
  /** A card the machine's Host waits on is why this chat waits (the phone's own path knows it, the Mac does not). */
  hostCard?: boolean;
};

/** `open` is rebuilt on every render of the list and only ever opens this chat, so a row redraws when what it shows changes: a list of hundreds stays cheap while the screen updates. */
export const ChatRow = memo(
  ChatRowView,
  (a, b) =>
    a.chat === b.chat &&
    a.subtitle === b.subtitle &&
    a.first === b.first &&
    a.now === b.now &&
    a.offline === b.offline &&
    a.disabled === b.disabled &&
    a.quick === b.quick &&
    a.nested === b.nested &&
    a.family === b.family &&
    a.machines === b.machines &&
    !!a.hold === !!b.hold,
);

function ChatRowView({
  chat,
  open,
  subtitle,
  now,
  offline = false,
  disabled = false,
  quick = false,
  nested = false,
  family = null,
  machines = null,
  hold,
}: {
  chat: ChatListItem;
  open: () => void;
  /** A long press, or the screen reader's "Chat actions": opens the row's menu. Absent where the chat cannot be acted on now. */
  hold?: () => void;
  /** Words put first on the grey line (the project, where a row is listed outside its project section). */
  subtitle?: string;
  /** Kept for callers that still pass it: rows have no dividers in Claude's list. */
  first?: boolean;
  /** The time the list reads the chat's age at; it moves on once a minute, so a row can turn to "No recent update" while the screen is open. */
  now?: number;
  /** The list is the last one read: no state is claimed for any chat. */
  offline?: boolean;
  /** The chat cannot be opened now (the computer is away and not being waited for). */
  disabled?: boolean;
  /** Tapping opens a quick review of what the chat asks, not the chat. */
  quick?: boolean;
  /** A sub-session listed under the chat that started it: inset beside the guide line, a smaller title. */
  nested?: boolean;
  /** The most urgent state among this chat's folded sub-sessions: one waiting turns the parent amber. */
  family?: ChatStateChip | null;
  /** The machines the Mac reports, to name a chat's Host when the Mac is away. */
  machines?: Machine[] | null;
}) {
  const theme = useTheme();
  const large = useLargeText();
  const mac = useMacLink();
  const at = now ?? Date.now();
  const chips = chatChips(chat, at, offline);
  const account = accountChip(chat.account);
  const title = chat.title || 'Untitled chat';
  const changes = changesOf(chat.changes);
  const age = ageLabel(chat.at, at);
  // a parent that is not waiting itself waits for you through a sub-session, as Claude's list says it
  const childWaits = chips.state !== 'needsYou' && family === 'needsYou';
  const state = childWaits ? 'waiting' : sessionState(chips.state);
  // a chat on a Host runs on while the Mac is away: its line says where, as the Mac words it
  const hostLine = !mac.online ? hostOfflineLine(machines, chat.hostId) : null;
  const cardLine = chat.hostCard ? hostCardLine(machines, chat.hostId) : null;
  const status = cardLine ?? hostLine ?? (childWaits ? 'A sub-session needs you' : rowStatus(chips.state));
  // the default login is what every chat runs on: it is said where it is not
  // with more than one computer the row says which one its chat is on, unless the line already names a Host
  const place =
    !cardLine && !hostLine && machines && machines.length > 1 ? machines.find((m) => m.id === (chat.hostId ?? 'local'))?.name : null;
  const line = [subtitle, status, age, place, chat.accountDefault ? null : account].filter(Boolean).join(' · ');
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={`Open chat ${title}`}
      accessibilityHint={quick ? 'Opens a quick review of what it asks' : undefined}
      accessibilityValue={{
        text: [
          childWaits ? status : chips.stateLabel,
          chips.harness,
          account && `Account ${account}`,
          chat.pinned === true ? 'Pinned' : '',
          changes && `${changes.added} added, ${changes.removed} removed`,
          chat.hostId ? 'Runs on a host' : mac.online ? '' : 'Your computer is offline',
        ]
          .filter(Boolean)
          .join(', '),
      }}
      onPress={open}
      onLongPress={hold}
      delayLongPress={350}
      accessibilityActions={hold ? [{ name: 'chatActions', label: 'Chat actions' }] : undefined}
      onAccessibilityAction={hold ? () => hold() : undefined}
      disabled={disabled}
      accessibilityState={{ disabled }}
      // a held row darkens like a native list cell; no dividers, as in Claude's list
      feel="row"
      rowColor={theme.sunken}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
        paddingVertical: nested ? 7 : 10,
        paddingLeft: nested ? 60 : 24,
        paddingRight: 24,
      }}
    >
      <View style={{ width: 22, minHeight: 24, alignItems: 'center', justifyContent: 'center' }}>
        <StatusGlyph state={state} small={nested} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={large ? 2 : 1} style={{ ...(nested ? typo.callout : typo.body), color: theme.ink }}>
          {title}
        </Text>
        {/* the numbers and the computer glyph keep their place when the words before them are cut */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {!!line && (
            <Text numberOfLines={1} style={{ flexShrink: 1, ...typo.subhead, color: theme.ink2 }}>
              {line}
            </Text>
          )}
          {!!changes && (
            <Text style={{ ...typo.subhead, color: theme.ink2 }}>
              <Text style={{ color: theme.ok }}>{`+${changes.added}`}</Text>{' '}
              <Text style={{ color: theme.bad }}>{`−${changes.removed}`}</Text>
            </Text>
          )}
          {/* where it runs: the Mac (green while connected, grey when away) or a host */}
          {chat.hostId ? (
            <Icon name="server.rack" glyph="▤" size={13} color={theme.ink2} />
          ) : (
            <Icon
              name={mac.online ? 'laptopcomputer' : 'laptopcomputer.slash'}
              glyph="▭"
              size={14}
              color={mac.online ? theme.ok : theme.ink3}
            />
          )}
        </View>
      </View>
    </Tap>
  );
}

/** The words a row's grey line starts with: none for an idle chat, Claude's "Waiting for you" and "Working", the rest as the Mac says them. */
function rowStatus(state: ChatStateChip): string {
  if (state === 'idle' || state === 'offline') return '';
  if (state === 'needsYou') return 'Waiting for you';
  if (state === 'running') return 'Working';
  return STATE_WORDS[state];
}
const STATE_WORDS: Record<'quiet' | 'failed' | 'done', string> = { quiet: 'No recent update', failed: 'Failed', done: 'Done' };
