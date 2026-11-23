// The Tasks part of MoMo's page on the classic phone (A1): what needs you and what is running, from the Mac's own list; a loop opens a page with Done, Snooze and Dismiss (the same calls the Mac's reminders use), a card opens the chat where it is answered, a run only shows. Nothing is marked done here but by the user's tap on a loop.
import { View } from 'react-native';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import type { Task } from '../momo/tasksContract';
import { useTranslation } from '../ui/i18n';
import type { Act } from './MomoPageParts';

type Say = ReturnType<typeof useTranslation>['t'];

/** A task's grey line: its due day and the user's own words. */
const lineOf = (t: Say, task: Task) =>
  [task.channel ? `#${task.channel.name}` : null, task.dueDay ? t('momoTasks.due', { day: task.dueDay }) : null, task.detail]
    .filter((s): s is string => !!s)
    .join(' · ');

/** The lists on the page: the tasks that need you, then the runs going. */
export function TasksGroups({ tasks, open }: { tasks: Task[]; open: (task: Task) => void }) {
  const { t } = useTranslation();
  const needs = tasks.filter((x) => x.state === 'needs-you');
  const running = tasks.filter((x) => x.state === 'running');
  const row = (task: Task) => (
    <GroupItem
      key={task.id}
      title={task.title}
      detail={lineOf(t, task) || undefined}
      value={task.kind === 'card' ? t('momoTasks.review') : undefined}
      end={task.kind === 'run' ? 'none' : 'chevron'}
      onPress={task.kind === 'run' ? undefined : () => open(task)}
    />
  );
  return (
    <>
      <GroupLabel>{t('momoTasks.needsYou')}</GroupLabel>
      <Group>{needs.length ? needs.map(row) : <GroupItem key="none" title={t('momoTasks.empty')} />}</Group>
      {running.length > 0 && (
        <>
          <GroupLabel>{t('momoTasks.running')}</GroupLabel>
          <Group>{running.map(row)}</Group>
        </>
      )}
    </>
  );
}

/** A loop's page: the user's own three answers, each the Mac's loop call. */
export function TaskPage({ task, act, busy, done }: { task: Task; act: Act; busy: boolean; done: () => void }) {
  const { t } = useTranslation();
  const go = (action: 'done' | 'snooze' | 'dismiss') => (busy ? undefined : () => act((api) => api.loopAct(task.ref, action), done));
  const line = lineOf(t, task);
  return (
    <View>
      {!!line && <GroupLabel>{line}</GroupLabel>}
      <Group>
        <GroupItem key="done" title={t('momoTasks.done')} tone="link" onPress={go('done')} />
        <GroupItem key="snooze" title={t('momoTasks.snooze')} onPress={go('snooze')} />
        <GroupItem key="dismiss" title={t('momoTasks.dismiss')} tone="danger" onPress={go('dismiss')} />
      </Group>
    </View>
  );
}
