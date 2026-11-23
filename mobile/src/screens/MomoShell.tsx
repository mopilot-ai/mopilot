// The classic phone's MoMo shell (M0b): a floating tab pill Chat · Tasks · Make (324 wide, 60 high at least, so large text grows it; an icon over each word, as the design has it) under MoMo's page for every account that has MoMo, whatever the Mac's page-shell flag says; the Tasks tab is the four-tab list of M0a where the Mac serves it, else one honest line, the Make tab says honestly that nothing is listed yet (the Mac offers the phone no method for what MoMo makes), and a "New" divider marks the replies that came while the reader was on another tab. A tab changes in the `s` token (120 ms, the snap curve), at once with Reduce Motion on. Words are catalog keys (`momoShell.*`).
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import Animated, { Easing, FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { MOMO_DUR, MOMO_EASE } from '../../../shared/momoMotion.mjs';
import { Group, GroupItem } from '../components/Grouped';
import { Icon } from '../components/Icon';
import { ErrorLine } from '../components/ui';
import { messageOf, type MomoApi } from '../momo/api';
import type { MomoRow } from '../momo/chatRows';
import { MARK_METHOD, type PanelTask } from '../momo/taskPanelContract';
import { TASKS_METHOD } from '../momo/tasksContract';
import { useLoad, type Guard } from '../momo/useLoad';
import type { MobileRuntime } from '../contracts';
import { useTheme } from '../theme';
import { useTranslation } from '../ui/i18n';
import { typo } from '../typography';
import { TaskTabs } from './MomoTaskTabs';
import type { Suggestion } from '../momo/suggestionsContract';

export type ShellTab = 'chat' | 'tasks' | 'make';

/** The pill's size, as the design has it (MoMo's design §5.6). */
export const PILL = { width: 324, minHeight: 60 } as const;
const PAD = 6;

/** The pill's tabs: always all three (the Tasks page says when this Mac cannot serve it). */
export const SHELL_TABS: ShellTab[] = ['chat', 'tasks', 'make'];

/** Whether this Mac serves the Tasks tab: its panel is on and it lists the two methods that list and mark. */
export function tasksServed(shell: { shell: boolean; shellTasks: boolean } | null, has: (method: string) => boolean): boolean {
  return !!shell?.shell && shell.shellTasks && has(TASKS_METHOD) && has(MARK_METHOD);
}

/** Each tab's symbol over its word: neutral stand-ins until the design names its own glyphs. */
const TAB_ICON: Record<ShellTab, { name: Parameters<typeof Icon>[0]['name']; glyph: string }> = {
  chat: { name: 'bubble.left', glyph: '◌' },
  tasks: { name: 'checklist', glyph: '☑' },
  make: { name: 'sparkles', glyph: '✦' },
};

/**
 * The key of the first reply that came since the reader last left the chat (`seen`: the row keys then; null before the reader
 * has left once), or null. Only MoMo's own lines count; the reader's are never new.
 */
export function firstNewKey(rows: MomoRow[], seen: ReadonlySet<string> | null): string | null {
  if (!seen) return null;
  const row = rows.find((r) => r.kind === 'message' && r.row.role === 'assistant' && !seen.has(r.key));
  return row?.key ?? null;
}

/** The floating pill; the selected tab sits on a raised capsule that slides to the one picked. */
export function ShellPill({ tabs, tab, pick }: { tabs: ShellTab[]; tab: ShellTab; pick: (tab: ShellTab) => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const each = (PILL.width - 2 * PAD) / tabs.length;
  const index = Math.max(0, tabs.indexOf(tab));
  const x = useSharedValue(index * each);
  const placed = useRef(false);
  useEffect(() => {
    const to = index * each;
    // the first place is taken, not travelled to
    x.value = reduce || !placed.current ? to : withTiming(to, { duration: MOMO_DUR.s, easing: Easing.bezier(...MOMO_EASE.snap) });
    placed.current = true;
  }, [index, each, reduce, x]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }], width: each }));
  const words: Record<ShellTab, string> = { chat: t('momoShell.chat'), tasks: t('momoShell.tasks'), make: t('momoShell.make') };
  return (
    <View style={{ alignItems: 'center', paddingBottom: 10 }}>
      <View
        accessibilityRole="tablist"
        accessibilityLabel={t('momoShell.tabs')}
        style={{
          width: PILL.width,
          minHeight: PILL.minHeight,
          borderRadius: PILL.minHeight / 2,
          padding: PAD,
          flexDirection: 'row',
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.glassLine,
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              top: PAD,
              bottom: PAD,
              left: PAD,
              borderRadius: PILL.minHeight / 2 - PAD,
              backgroundColor: theme.sunken,
            },
            slide,
          ]}
        />
        {tabs.map((id) => (
          <Tap
            key={id}
            accessibilityRole="tab"
            accessibilityState={{ selected: id === tab }}
            accessibilityLabel={words[id]}
            onPress={() => pick(id)}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 }}
          >
            <Icon name={TAB_ICON[id].name} glyph={TAB_ICON[id].glyph} size={20} color={id === tab ? theme.ink : theme.ink2} />
            <Text style={{ ...(id === tab ? typo.captionSemibold : typo.caption), color: id === tab ? theme.ink : theme.ink2 }}>
              {words[id]}
            </Text>
          </Tap>
        ))}
      </View>
    </View>
  );
}

/** The small line under the chat, above the pill. */
export function ShellFootnote() {
  const theme = useTheme();
  const { t } = useTranslation();
  return <Text style={{ ...typo.caption, color: theme.ink3, textAlign: 'center', paddingBottom: 6 }}>{t('momoShell.mistakes')}</Text>;
}

/** The "New" divider before the first reply the reader has not seen. */
export function NewDivider() {
  const theme = useTheme();
  const { t } = useTranslation();
  const line = <View style={{ flex: 1, borderTopWidth: 1, borderColor: theme.line }} />;
  return (
    <View accessibilityRole="header" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
      {line}
      <Text style={{ ...typo.subhead, color: theme.ink2 }}>{t('momoShell.new')}</Text>
      {line}
    </View>
  );
}

/** What a tab's page does as it appears: a fade in the `s` token, nothing with Reduce Motion on. */
export function TabPage({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <Animated.View style={{ flex: 1 }} entering={reduce ? undefined : FadeIn.duration(MOMO_DUR.s).easing(Easing.bezier(...MOMO_EASE.snap))}>
      {children}
    </Animated.View>
  );
}

/** A tab's page that says one thing and nothing more. */
function Said({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Text style={{ ...typo.subhead, color: theme.ink2, textAlign: 'center' }}>{text}</Text>
    </View>
  );
}

/** The Make tab: the Mac lists no method for what MoMo makes, so it says what it is for and nothing more. */
export function ShellMake() {
  const { t } = useTranslation();
  return <Said text={t('momoShell.makeEmpty')} />;
}

/** The Tasks tab on a Mac that does not serve it (its Tasks panel is off, or it is older): one line, not a list that cannot load. */
export function ShellTasksOff() {
  const { t } = useTranslation();
  return <Said text={t('momoShell.tasksOff')} />;
}

/** The Tasks tab: M0a's four tabs over the Mac's own list; a task with a page of its own opens MoMo's page on it. */
export function ShellTasks({
  runtime,
  api,
  guard,
  version,
  review,
  open,
  suggestions: shown,
  openSuggestion,
}: {
  runtime: MobileRuntime;
  api: MomoApi;
  guard: Guard;
  /** bumped as anything MoMo keeps changes: the list is read again */
  version: number;
  /** a card: the chat where it is answered (a channel's card: that channel) */
  review: (task: PanelTask) => void;
  /** a task with a page of its own, with the Mac's clock of the list it came from */
  open: (task: PanelTask, now: number) => void;
  /** whether the phone shows suggestions: the Mac's flag is on and it lists the methods */
  suggestions: boolean;
  /** a suggestion of Up next: its own page, in MoMo's page */
  openSuggestion: (suggestion: Suggestion) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tasks = useLoad(runtime, () => guard(api.tasks), [api, version]);
  const panel = tasks.data?.panel ?? null;
  // what MoMo suggested for Up next (A7): the same rows as MoMo's page, where the Mac lists both methods
  const suggested = useLoad(runtime, () => (shown ? guard(api.suggestions) : Promise.resolve(null)), [api, version, shown]);
  /** One call of the user's at a time (a routine's switch, Pause all); the list is read again after it. */
  const run = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    guard(work).then(
      () => {
        setBusy(false);
        tasks.reload();
      },
      (e: unknown) => {
        setBusy(false);
        setError(messageOf(e));
      },
    );
  };
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 16 }}>
      <ErrorLine text={error} />
      {(!!tasks.error || (!!tasks.data && !panel)) && (
        <Group>
          <GroupItem key="failed" title={t('momoTasks.readFailed')} value={t('momoTasks.tryAgain')} tone="link" onPress={tasks.reload} />
        </Group>
      )}
      {panel && (
        <TaskTabs
          view={panel}
          stale={!!tasks.error}
          review={review}
          open={(task) => open(task, panel.now)}
          busy={busy}
          toggle={(task) => run(() => api.routine(task.paused ? 'resume' : 'pause', task.ref))}
          pauseAll={() => run(() => api.setPaused(!panel.paused))}
          suggestions={suggested.data}
          openSuggestion={openSuggestion}
        />
      )}
    </ScrollView>
  );
}

/** The page under the pill for the Tasks and Make tabs (the chat is Momo's own): Tasks where the Mac serves it, one line where it does not. */
export function ShellPages({ tab, served, ...tasks }: { tab: ShellTab; served: boolean } & React.ComponentProps<typeof ShellTasks>) {
  if (tab === 'chat') return null;
  return <TabPage>{tab === 'make' ? <ShellMake /> : served ? <ShellTasks {...tasks} /> : <ShellTasksOff />}</TabPage>;
}
