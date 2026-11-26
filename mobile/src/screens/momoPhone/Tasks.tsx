// MoMo's Tasks tab: Needs you, Working, Watching and Done today; a task's detail (result, failure, missing agent, Stop confirmation) and the empty state.
import { say } from '../../momoPhone/say';
import { Text, View } from 'react-native';
import { Group, GroupItem, GroupLabel } from '../../components/Grouped';
import { useHardwareBack } from '../../useHardwareBack';
import { Pill } from '../MomoPill';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import type { MomoTaskView } from '../../../../shared/momoView';
import type { PhoneView } from '../../momoPhone/types';
import { pickRows } from '../../momoPhone/viewModels';
import { stopSheet, taskDetail, taskSections } from '../../momoPhone/workModels';
import { ActPill, ButtonRow, Actions, actionKeys, Body, Card, Title, type Act } from './parts';
import { useBusy } from './useMomoStore';

export function TasksScreen({ view, act, open, ask }: { view: PhoneView; act: Act; open: (taskId: string) => void; ask: () => void }) {
  const { sections, empty } = taskSections(view.view.tasks);
  if (empty) {
    return (
      <View>
        <Title>{say('tasks')}</Title>
        <Body>{empty.title}</Body>
        <Body>{empty.body}</Body>
        <Pill strong disabled={false} title={empty.cta} onPress={ask} />
      </View>
    );
  }
  return (
    <View>
      {sections.map((s) => (
        <View key={s.key}>
          <GroupLabel>{s.title}</GroupLabel>
          <Group>
            {s.tasks.map((t) => (
              <GroupItem key={t.id} title={t.title} detail={t.step ?? t.doneMeans} end="chevron" onPress={() => open(t.id)} />
            ))}
          </Group>
        </View>
      ))}
    </View>
  );
}

export function TaskDetailScreen({ view, task, act, askStop }: { view: PhoneView; task: MomoTaskView; act: Act; askStop: () => void }) {
  const theme = useTheme();
  const d = taskDetail(view, task);
  const keys = actionKeys(d.actions);
  return (
    <View>
      <Title>{d.title}</Title>
      <Body>{d.status}</Body>
      {d.facts.map((f) => (
        <Text key={f.label} style={{ ...typo.subhead, color: theme.ink2, marginTop: 6 }}>
          {f.label} <Text style={{ color: theme.ink }}>{f.value}</Text>
        </Text>
      ))}
      {!!d.step && <Body dim={false}>{d.step}</Body>}
      {!!d.watchNote && <Body>{d.watchNote}</Body>}
      {d.result && (
        <Card>
          <Title>{d.result.headline}</Title>
          <Body>{d.result.summary}</Body>
          <Body>{d.result.checked}</Body>
        </Card>
      )}
      {d.awayNote && <Body>{d.awayNote}</Body>}
      {d.problem && (
        <Card tone="warn">
          <Title>{d.problem.title}</Title>
          {!!d.problem.body && <Body>{d.problem.body}</Body>}
          <Actions actions={d.problem.actions} act={act} />
        </Card>
      )}
      <ButtonRow>
        {d.actions.map((a, i) =>
          // the confirm is for the intent that stops a running session; Stop watching runs at once, as on the Mac
          a.intent.kind === 'task-stop' ? (
            <Pill key={keys[i]} title={a.label} strong={a.strong} disabled={false} onPress={askStop} />
          ) : (
            <ActPill key={keys[i]} title={a.label} strong={a.strong} intent={a.intent} act={act} />
          ),
        )}
      </ButtonRow>
    </View>
  );
}

export function StopConfirm({ task, act, close }: { task: MomoTaskView; act: Act; close: () => void }) {
  useHardwareBack(close);
  const s = stopSheet(task);
  return (
    <Card>
      <Title>{s.title}</Title>
      <Body>{s.body}</Body>
      <ButtonRow>
        <Pill
          strong
          disabled={useBusy(s.confirm.intent)}
          title={s.confirm.label}
          onPress={() => {
            act(s.confirm.intent);
            close();
          }}
        />
        <Pill disabled={false} title={s.cancel} onPress={close} />
      </ButtonRow>
    </Card>
  );
}

/** Where this task should run: the machines that are online. */
export function PickMachine({ view, taskId, act, done }: { view: PhoneView; taskId: string; act: Act; done: () => void }) {
  return (
    <View>
      <Title>{say('whereShouldThisRun')}</Title>
      <Group>
        {pickRows(view, taskId).map((r) => (
          <GroupItem
            key={r.id}
            title={r.name}
            detail={r.detail}
            end="chevron"
            onPress={() => {
              act(r.intent);
              done();
            }}
          />
        ))}
      </Group>
    </View>
  );
}
