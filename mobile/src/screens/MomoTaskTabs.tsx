// The four-tab Tasks of MoMo's page on the classic phone (M0a), where the Mac has the panel on (momo.tasks.list answers v: 2 and lists momo.tasks.mark): Active, Up next, Scheduled and Resolved over the Mac's own rows; a card opens the chat, a run waiting for the user is marked done or archived (and Reopened) on its own page, a loop keeps its Done, Snooze and Dismiss (Reopen once closed), a routine Pauses or Resumes, and Pause all is MoMo's own pause. Only the user's tap marks a run done; an Undo line stays a minute after a mark.
import { useEffect, useRef, useState } from 'react';
import { Switch, View } from 'react-native';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { Segmented } from '../components/Segmented';
import { useTheme } from '../theme';
import type { PanelMark, PanelTab, PanelTask, PanelView } from '../momo/taskPanelContract';
import { useTranslation } from '../ui/i18n';
import type { Suggestion, SuggestionsView } from '../momo/suggestionsContract';
import type { Act } from './MomoPageParts';
import { SuggestionGroups } from './MomoSuggestions';

type Say = ReturnType<typeof useTranslation>['t'];

/** How long the Undo line stays (the Mac keeps the token as long). */
export const UNDO_MS = 60_000;
const TABS: PanelTab[] = ['active', 'next', 'scheduled', 'resolved'];

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const dayOf = (ms: number) => `${new Date(ms).getFullYear()}-${pad(new Date(ms).getMonth() + 1)}-${pad(new Date(ms).getDate())}`;
/** A time as the page says it: the clock today, else the day and the clock. */
const when = (ms: number, now: number) => (dayOf(ms) === dayOf(now) ? clock(ms) : `${dayOf(ms)} ${clock(ms)}`);

/** A row's grey line. */
function lineOf(t: Say, task: PanelTask, now: number): string {
  const at = task.at === null ? null : when(task.at, now);
  const parts: (string | null)[] =
    task.kind === 'brief'
      ? task.state === 'failed'
        ? [t('momoBrief.couldNotStart'), task.detail]
        : task.paused
          ? [task.detail]
          : [task.nextAt === null ? null : t('momoBrief.next', { time: when(task.nextAt, now) })]
      : task.kind === 'routine'
        ? [task.paused ? t('momoTasks.paused') : task.nextAt === null ? null : t('momoTasks.next', { time: when(task.nextAt, now) })]
        : task.state === 'failed'
          ? [
              task.outcome === 'stopped'
                ? t('momoTasks.stopped')
                : task.outcome === 'interrupted'
                  ? t('momoTasks.cutShort')
                  : t('momoTasks.couldNotRun'),
              at,
            ]
          : task.state === 'review'
            ? [t('momoTasks.ready'), at]
            : task.state === 'running'
              ? [t('momoTasks.working')]
              : task.tab === 'resolved'
                ? [
                    t(
                      task.state === 'dismissed'
                        ? 'momoTasks.dismissed'
                        : task.state === 'archived'
                          ? 'momoTasks.archived'
                          : 'momoTasks.done',
                    ),
                    at,
                  ]
                : [
                    task.channel ? `#${task.channel.name}` : null,
                    task.dueDay ? t('momoTasks.due', { day: task.dueDay }) : null,
                    task.detail,
                  ];
  return parts.filter((s): s is string => !!s).join(' · ');
}

/** What a tap on the row does: a card and a run still going have no page of their own. */
const hasPage = (task: PanelTask) => task.kind !== 'card' && task.state !== 'running' && (task.kind !== 'brief' || task.state === 'failed');

export function TaskTabs({
  view,
  open,
  review,
  pauseAll,
  toggle,
  busy,
  stale,
  suggestions,
  openSuggestion,
  tab: shownTab,
  onTab,
}: {
  view: PanelView;
  open: (task: PanelTask) => void;
  /** a card: the chat where it is answered (a channel's card: that channel) */
  review: (task: PanelTask) => void;
  /** MoMo's own pause, or its resume */
  pauseAll: () => void;
  /** a routine's own switch: pause it when it is on, resume it when it is off */
  toggle: (task: PanelTask) => void;
  busy: boolean;
  /** the last read failed: what is drawn is the last known list */
  stale: boolean;
  /** what MoMo suggested for Up next, where the Mac lists it (A7), and what a tap on one opens */
  suggestions?: SuggestionsView | null;
  openSuggestion?: (s: Suggestion) => void;
  /** the tab shown and what changes it, kept by the caller; without them the tabs keep their own */
  tab?: PanelTab;
  onTab?: (tab: PanelTab) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  // the page keeps the tab (an Add or a Hide comes back to where it was); the shell's own tab keeps it here
  const [own, setOwn] = useState<PanelTab>('active');
  const tab = shownTab ?? own;
  const setTab = onTab ?? setOwn;
  const words: Record<PanelTab, string> = {
    active: t('momoTasks.tabActive'),
    next: t('momoTasks.tabNext'),
    scheduled: t('momoTasks.tabScheduled'),
    resolved: t('momoTasks.tabResolved'),
  };
  const row = (task: PanelTask) => (
    <GroupItem
      key={task.id}
      title={task.title}
      detail={lineOf(t, task, view.now) || undefined}
      // the state of a routine or of the brief (its next time, a pause, why it could not start) is read after its name, not only drawn as the grey line
      say={task.kind === 'brief' || task.kind === 'routine' ? lineOf(t, task, view.now) || undefined : undefined}
      value={task.kind === 'card' ? t('momoTasks.review') : undefined}
      end={task.kind === 'card' || hasPage(task) ? 'chevron' : 'none'}
      trailing={
        task.kind === 'routine' ? (
          <Switch
            accessibilityRole="switch"
            accessibilityLabel={t(task.paused ? 'momoTasks.routineOff' : 'momoTasks.routineOn', { name: task.title })}
            accessibilityState={{ checked: !task.paused, disabled: busy }}
            value={!task.paused}
            disabled={busy}
            trackColor={{ true: theme.ok, false: theme.sunken }}
            onValueChange={() => toggle(task)}
          />
        ) : undefined
      }
      onPress={task.kind === 'card' ? () => review(task) : hasPage(task) ? () => open(task) : undefined}
    />
  );
  const inTab = view.tasks.filter((x) => x.tab === tab);
  const groups: [string, (x: PanelTask) => boolean][] = [
    [t('momoTasks.needsYou'), (x) => x.state === 'needs-you'],
    [t('momoTasks.working'), (x) => x.state === 'running'],
    [t('momoTasks.didntFinish'), (x) => x.state === 'failed'],
    [t('momoTasks.ready'), (x) => x.state === 'review'],
  ];
  const empty = { active: 'empty', next: 'nextEmpty', scheduled: 'scheduledEmpty', resolved: 'resolvedEmpty' } as const;
  return (
    <View style={{ opacity: stale ? 0.5 : 1 }}>
      <View style={{ marginBottom: 16 }}>
        <Segmented items={TABS.map((id) => ({ key: id, label: words[id], onPress: () => setTab(id) }))} selected={tab} />
      </View>
      {tab === 'active' && inTab.length > 0 ? (
        groups.map(([label, has]) => {
          const list = inTab.filter(has);
          return (
            list.length > 0 && (
              <View key={label}>
                <GroupLabel>{label}</GroupLabel>
                <Group>{list.map(row)}</Group>
              </View>
            )
          );
        })
      ) : (
        <View>
          {tab === 'next' && !!suggestions && !!openSuggestion && <SuggestionGroups view={suggestions} open={openSuggestion} />}
          {tab === 'next' && (suggestions?.suggestions.length ?? 0) > 0 && inTab.length === 0 ? null : (
            <Group>
              {tab === 'scheduled' && inTab.length > 0 && (
                <GroupItem
                  key="all"
                  title={view.paused ? t('momoTasks.resumeAll') : t('momoTasks.pauseAll')}
                  tone="link"
                  onPress={pauseAll}
                />
              )}
              {inTab.length ? inTab.map(row) : <GroupItem key="none" title={t(`momoTasks.${empty[tab]}`)} />}
            </Group>
          )}
        </View>
      )}
    </View>
  );
}

/** A task's own page: the user's calls on it, each the Mac's own (a loop's act, a run's mark, a routine's pause). */
export function PanelTaskPage({
  task,
  act,
  busy,
  done,
  mark,
  now,
}: {
  task: PanelTask;
  act: Act;
  busy: boolean;
  done: () => void;
  /** marks a run and starts its Undo line */
  mark: (task: PanelTask, what: PanelMark) => void;
  /** the Mac's clock when it listed the task (the page's times read from it, not from this phone's) */
  now: number;
}) {
  const { t } = useTranslation();
  const go = (work: () => void) => (busy ? undefined : work);
  const line = lineOf(t, task, now);
  const loop = (action: 'done' | 'snooze' | 'dismiss' | 'reopen') => go(() => act((api) => api.loopAct(task.ref, action), done));
  const resolved = task.tab === 'resolved';
  return (
    <View>
      {!!line && <GroupLabel>{line}</GroupLabel>}
      <Group>
        {task.kind === 'loop' && resolved && <GroupItem key="reopen" title={t('momoTasks.reopen')} tone="link" onPress={loop('reopen')} />}
        {task.kind === 'loop' && !resolved && <GroupItem key="done" title={t('momoTasks.done')} tone="link" onPress={loop('done')} />}
        {task.kind === 'loop' && !resolved && <GroupItem key="snooze" title={t('momoTasks.snooze')} onPress={loop('snooze')} />}
        {task.kind === 'loop' && !resolved && (
          <GroupItem key="dismiss" title={t('momoTasks.dismiss')} tone="danger" onPress={loop('dismiss')} />
        )}
        {task.kind === 'run' && resolved && (
          <GroupItem key="reopen" title={t('momoTasks.reopen')} tone="link" onPress={go(() => mark(task, 'reopen'))} />
        )}
        {task.kind === 'run' && !resolved && (
          <GroupItem key="markDone" title={t('momoTasks.markDone')} tone="link" onPress={go(() => mark(task, 'done'))} />
        )}
        {task.kind === 'run' && !resolved && (
          <GroupItem key="archive" title={t('momoTasks.archive')} onPress={go(() => mark(task, 'archive'))} />
        )}
        {task.kind === 'brief' && (
          <GroupItem key="retry" title={t('momoBrief.tryAgain')} tone="link" onPress={go(() => act((api) => api.runBrief(), done))} />
        )}
        {task.kind === 'routine' && (
          <GroupItem
            key="pause"
            title={task.paused ? t('momoTasks.resume') : t('momoTasks.pause')}
            tone="link"
            onPress={go(() => act((api) => api.routine(task.paused ? 'resume' : 'pause', task.ref), done))}
          />
        )}
      </Group>
    </View>
  );
}

/** The line after a mark: what was done, with Undo for a minute (a new mark mounts a new line, so the minute starts again). */
export function UndoLine({ label, undo, expire }: { label: string; undo: () => void; expire: () => void }) {
  const { t } = useTranslation();
  const latest = useRef(expire);
  latest.current = expire;
  useEffect(() => {
    const timer = setTimeout(() => latest.current(), UNDO_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Group>
      <GroupItem key="undo" title={label} value={t('momoTasks.undo')} tone="link" onPress={undo} />
    </Group>
  );
}
