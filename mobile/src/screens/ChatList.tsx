// The Chats home: + New session, then the chats in white grouped cards (Needs input first, then every other chat in one list under no header, in the order the computer listed them; by project, one card per project of its first ten chats with the rest behind "Show more"), each chat's sub-sessions folded under it, and a card per computer at the bottom; the search field when it is open.
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { ChatRow, type ChatListItem } from '../components/ChatRow';
import { ChatRowMenu, type RowMenuOwner } from '../components/ChatRowMenu';
import { useHomeOverlay } from '../components/HomeOverlay';
import { useSearchableList } from '../components/ChatSearch';
import { LoadMoreChats } from '../components/LoadMoreChats';
import { FoldCapsule, NestedGuide, SectionHeader } from '../components/SessionRow';
import { GroupCard, LayoutSwitch, NewSessionRow, ProjectFoot } from '../components/HomeSections';
import { Field, useStyles } from '../components/ui';
import { useMachines } from '../macLink';
import { useKnownMachines } from '../remote/knownMachines';
import { haptic } from '../motion';
import { Enter } from '../components/Motion';
import { chatChips, chatStateLabel, nestedState } from '../presentation/chatChips';
import { chatWindow, PROJECT_FIRST, PROJECT_STEP } from '../presentation/chatWindow';
import { rowProject, sectionByProject, sectionByState } from '../presentation/chatStates';
import { ComputerCards } from '../components/ComputerCards';
import { useNow } from '../remote/useNow';
import { useTheme } from '../theme';
import { useHomeFolds, type HomeFolds } from '../useHomeFolds';

export function ChatList({
  chats,
  failed,
  busy,
  open,
  more,
  offline = false,
  openable = true,
  review,
  computers,
  machine,
  newChat,
  folds,
  rowMenu,
}: {
  /** What a long press on a row opens its menu with (Pin, Rename, Archive); absent where the chats cannot be acted on now. */
  rowMenu?: RowMenuOwner;
  /** The folds kept above the list; the list keeps its own when absent. */
  folds?: HomeFolds;
  /** `null` while the list loads. */
  chats: ChatListItem[] | null;
  failed: boolean;
  busy: boolean;
  open: (id: string) => void;
  /** Present while the computer has chats after the ones shown. */
  more?: { loading: boolean; load: () => void };
  /** The list is the last one read and the computer is away: no state is claimed for any chat. */
  offline?: boolean;
  /** False while the computer is away and not being waited for: the rows say so to a screen reader and open nothing. */
  openable?: boolean;
  /** Opens the quick review of a waiting chat; absent where the chats cannot be answered now, and a waiting row then opens the chat. */
  review?: (id: string) => void;
  /** Opens the computers' settings from a computer's card. */
  computers?: () => void;
  /** A Host's own page, from its card on the home. */
  machine?: (id: string) => void;
  /** + New session; absent while a chat cannot be started. */
  newChat?: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const now = useNow();
  const search = useSearchableList();
  const machines = useMachines();
  // the Mac sends no machines while it is away, which is when a Host chat's row names its Host
  const named = useKnownMachines();
  const [needle, setNeedle] = useState('');
  // the row the menu is for; it stays after the sheet closes so the sheet slides out with its content
  const [held, setHeld] = useState<{ chat: ChatListItem; open: boolean } | null>(null);
  // drawn over the whole screen by the page: the list's own parent is the scroll content, where a sheet would sit at the end of a long list
  const menu = useMemo(
    () =>
      rowMenu && held ? (
        <ChatRowMenu owner={rowMenu} chat={held.chat} open={held.open} close={() => setHeld({ chat: held.chat, open: false })} />
      ) : null,
    [rowMenu, held],
  );
  const inPlace = useHomeOverlay(menu);
  // closing the search clears it, so it opens empty next time
  const [wasOpen, setWasOpen] = useState(search.open);
  if (wasOpen !== search.open) {
    setWasOpen(search.open);
    if (!search.open) setNeedle('');
  }
  // the folds (sub-sessions under their parent) are the app's when it holds them, so they outlive a chat being opened
  const own = useHomeFolds();
  const { unfolded, setUnfolded, revealed, reveal, layout, setLayout } = folds ?? own;
  const byProject = layout === 'project';
  const query = search.open ? needle : '';
  const groups = chats && !byProject ? sectionByState(chats, query, now, offline) : null;
  const projects = chats && byProject ? sectionByProject(chats, query, now, offline) : null;
  const searching = query.trim() !== '';
  // `target`: the chat a tap goes to, the row's own unless a sub-session is what waits for you
  const row = (chat: ChatListItem, nested = false, family: ReturnType<typeof nestedState> = null, target = chat, inProject = false) => {
    const answerable = !!review && !offline && target.state === 'waiting';
    return (
      <ChatRow
        key={chat.id}
        chat={chat}
        now={now}
        offline={offline}
        disabled={!openable}
        // a waiting chat opens its quick review where one can be answered now; a waiting sub-session too
        quick={answerable}
        nested={nested}
        family={family}
        machines={named}
        hold={rowMenu && !offline ? () => (haptic.select(), setHeld({ chat, open: true })) : undefined}
        // under its project's header the project is not said again
        subtitle={nested || inProject ? undefined : rowProject((groups ?? projects)!.labelOf(chat))}
        open={() => (answerable ? review : open)(target.id)}
      />
    );
  };
  /** The sub-session a parent's row is waiting through ("A sub-session needs you"): the one a tap should go to; none when the parent waits itself. */
  const waitingChild = (chat: ChatListItem, family: ChatListItem[]) =>
    chatChips(chat, now, offline).state === 'needsYou'
      ? undefined
      : family.find((child) => chatChips(child, now, offline).state === 'needsYou');
  /** A chat with the sub-sessions it started folded under it behind a count (all shown while searching). */
  const placed = (chat: ChatListItem, inProject = false) => {
    const family = (groups ?? projects)?.nested.get(chat.id);
    if (!family) return row(chat, false, null, chat, inProject);
    const shown = searching || unfolded.includes(chat.id);
    const urgent = nestedState(family, now, offline);
    return (
      <View key={chat.id}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View style={{ flex: 1, minWidth: 0 }}>{row(chat, false, urgent, waitingChild(chat, family) ?? chat, inProject)}</View>
          <FoldCapsule
            count={family.length}
            open={shown}
            state={familyLabel(urgent)}
            disabled={searching}
            onPress={() => {
              haptic.select();
              setUnfolded((old) => (old.includes(chat.id) ? old.filter((k) => k !== chat.id) : [...old, chat.id]));
            }}
          />
        </View>
        {/* shown sub-sessions fade in, as the baseline's fold does */}
        {shown && (
          <NestedGuide>
            {family.map((child) => (
              <Enter key={child.id}>{row(child, true)}</Enter>
            ))}
          </NestedGuide>
        )}
      </View>
    );
  };
  const listed = projects
    ? [...projects.needs, ...projects.projects.flatMap((p) => p.chats)]
    : groups
      ? (groups.all ?? [...groups.needs, ...groups.rest])
      : [];
  return (
    <View>
      {newChat && <NewSessionRow onPress={newChat} disabled={busy} />}
      {(groups || projects) && !!chats?.length && <LayoutSwitch layout={layout} choose={setLayout} />}
      {search.open && (
        <View style={{ paddingHorizontal: 24, paddingTop: 14 }}>
          <Field
            autoFocus
            placeholder="Search chats"
            value={needle}
            onChangeText={setNeedle}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            style={{ minHeight: 44, paddingVertical: 8, borderRadius: 12, borderWidth: 0, backgroundColor: theme.sunken }}
          />
        </View>
      )}
      {!groups && !projects ? (
        <Text accessibilityLiveRegion="polite" style={[styles.muted, { paddingHorizontal: 24, paddingTop: 18 }]}>
          {failed ? 'Could not load chats. Pull down to try again.' : 'Loading chats…'}
        </Text>
      ) : chats?.length === 0 ? (
        <Text style={[styles.muted, { paddingHorizontal: 24, paddingTop: 18 }]}>No recent chats on this computer.</Text>
      ) : listed.length === 0 ? (
        <Text style={[styles.muted, { paddingHorizontal: 24, paddingTop: 18 }]}>No chat matches “{query.trim()}”.</Text>
      ) : projects ? (
        <>
          {projects.needs.length > 0 && (
            <View style={{ paddingTop: 6 }}>
              <SectionHeader title="Needs input" />
              <GroupCard>{projects.needs.map((chat) => placed(chat))}</GroupCard>
            </View>
          )}
          {projects.projects.map((section) => {
            // a project shows its first chats and the rest behind "Show more", so one project cannot fill the list; a search shows every match
            const window = searching ? null : chatWindow(section.chats, PROJECT_FIRST, PROJECT_STEP, revealed[section.key] ?? 0);
            const foot = window?.foot;
            return (
              <View key={section.key} style={{ paddingTop: 6 }}>
                <SectionHeader title={section.name} />
                <GroupCard>
                  {(window?.visible ?? section.chats).map((chat) => placed(chat, true))}
                  {foot && (
                    <ProjectFoot
                      key="foot"
                      foot={foot}
                      project={section.name}
                      onMore={() => reveal(section.key, window.more)}
                      onLess={() => reveal(section.key, 0)}
                    />
                  )}
                </GroupCard>
              </View>
            );
          })}
        </>
      ) : groups?.all ? (
        // away from the computer no state is claimed: the last list read, as it was
        <View style={{ paddingTop: 14 }}>
          <GroupCard>{groups.all.map((chat) => placed(chat))}</GroupCard>
        </View>
      ) : (
        // the branches above leave one of the two layouts
        groups && (
          <>
            {groups.needs.length > 0 && (
              <View>
                <SectionHeader title="Needs input" />
                <GroupCard>{groups.needs.map((chat) => placed(chat))}</GroupCard>
              </View>
            )}
            {groups.rest.length > 0 && (
              // the other chats have no header of their own: one list, in the order the computer listed them
              <View style={{ paddingTop: 14 }}>
                <GroupCard>{groups.rest.map((chat) => placed(chat))}</GroupCard>
              </View>
            )}
          </>
        )
      )}
      {more && !!(groups || projects) && (
        <View style={{ paddingHorizontal: 24 }}>
          <LoadMoreChats loading={more.loading} disabled={busy} onPress={more.load} />
        </View>
      )}
      <ComputerCards machines={machines} chats={chats} offline={offline} onPress={computers} openMachine={machine} />
      {inPlace}
    </View>
  );
}

/** A folded family's most urgent state in words, for the count capsule's screen-reader label. */
const familyLabel = (state: ReturnType<typeof nestedState>) => (state ? chatStateLabel(state) : null);
