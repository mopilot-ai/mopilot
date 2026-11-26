// Where MoMo runs, the move in progress, failed or finished late, and the first-run choice of machine.
import { say } from '../../momoPhone/say';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Pill } from '../MomoPill';
import { Group, GroupItem, GroupLabel } from '../../components/Grouped';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import type { PhoneView } from '../../momoPhone/types';
import { firstRun, homeCardLines, movePanel, whereRows } from '../../momoPhone/viewModels';
import { ActPill, ButtonRow, Actions, Body, Card, Title, type Act } from './parts';

export function WhereMomoRuns({
  view,
  act,
  go,
  classic,
}: {
  view: PhoneView;
  act: Act;
  go: (page: 'rules' | 'brief' | 'permission' | 'previews') => void;
  /** Opens the classic screen, which holds the channels, Pause MoMo and MoMo's page. */
  classic?: () => void;
}) {
  const rows = whereRows(view);
  const lines = homeCardLines(view);
  return (
    <View>
      <GroupLabel>{say('whereMomoRuns')}</GroupLabel>
      {rows.here && (
        <Card>
          <Title>{rows.here.name}</Title>
          <Body dim={false}>{rows.here.subtitle}</Body>
          {lines.map((l) => (
            <Body key={l}>{l}</Body>
          ))}
        </Card>
      )}
      <GroupLabel>{say('moveMomoTo')}</GroupLabel>
      <Group>
        {rows.others.map((r) => (
          <GroupItem
            key={r.id}
            title={r.name}
            detail={r.subtitle}
            value={r.action?.label}
            end={r.action ? 'chevron' : 'none'}
            onPress={r.action ? () => act(r.action!.intent) : undefined}
          />
        ))}
        <GroupItem key="add" title={say('addAMachine')} tone="link" onPress={() => act({ kind: 'add-machine' })} />
      </Group>
      <Body>{rows.footnote}</Body>
      <GroupLabel>{say('settings')}</GroupLabel>
      <Group>
        <GroupItem key="rules" title={say('rules')} end="chevron" onPress={() => go('rules')} />
        <GroupItem key="brief" title={say('morningBrief')} end="chevron" onPress={() => go('brief')} />
        <GroupItem key="permission" title={say('notifications')} end="chevron" onPress={() => go('permission')} />
        <GroupItem key="previews" title={say('showTextOnTheLock')} end="chevron" onPress={() => go('previews')} />
        {classic && <GroupItem key="classic" title={say('channelsAndPause')} end="chevron" onPress={classic} />}
      </Group>
    </View>
  );
}

/** The move card: steps with Cancel, or why it failed with Retry and Stay, or that it finished while the old machine was away. */
export function MoveCard({ view, act }: { view: PhoneView; act: Act }) {
  const theme = useTheme();
  const panel = movePanel(view);
  if (!panel) return null;
  if (panel.kind === 'moving') {
    return (
      <Card>
        <Title>{panel.title}</Title>
        <Body>{panel.from}</Body>
        {panel.steps.map((s) => (
          <Text
            key={s.label}
            accessibilityLabel={say('stepLabel', {
              label: s.label,
              state: s.state === 'done' ? say('stepDone') : s.state === 'current' ? say('stepCurrent') : say('stepWaiting'),
            })}
            accessibilityState={{ selected: s.state === 'current' }}
            style={{ ...typo.body, color: s.state === 'todo' ? theme.ink3 : theme.ink, marginTop: 6 }}
          >
            {s.state === 'done' ? '✓ ' : s.state === 'current' ? '● ' : '○ '}
            {s.label}
          </Text>
        ))}
        <Body>{panel.note}</Body>
        {panel.cancel && <Actions actions={[panel.cancel]} act={act} />}
        {panel.cancelling && (
          <View style={{ marginTop: 12, flexDirection: 'row' }}>
            <ActPill off title={say('cancelling')} intent={{ kind: 'move-cancel', moveId: panel.moveId }} act={act} />
          </View>
        )}
        <Body>{panel.cancelNote}</Body>
      </Card>
    );
  }
  if (panel.kind === 'failed') {
    return (
      <Card tone="warn">
        <Title>{panel.title}</Title>
        <Body>{panel.cause}</Body>
        {!!panel.lastStep && <Body>{panel.lastStep}</Body>}
        {!!panel.tried && <Body>{panel.tried}</Body>}
        <Actions actions={panel.actions} act={act} />
        {panel.reclaim && <Reclaim reclaim={panel.reclaim} act={act} />}
      </Card>
    );
  }
  return (
    <Card>
      <Title>{panel.title}</Title>
      <Body>{panel.body}</Body>
      <Actions actions={[panel.ack]} act={act} />
    </Card>
  );
}

/** First run: the machines as a list, the recommended one chosen, Continue with it. */
export function FirstRun({
  view,
  act,
  chosen,
  choose,
}: {
  view: PhoneView;
  act: Act;
  chosen: string | null;
  choose: (id: string) => void;
}) {
  const fr = firstRun(view);
  const picked = chosen ?? fr.chosen;
  const name = fr.rows.find((r) => r.id === picked)?.name;
  return (
    <View>
      <Title>{say('whereShouldMomoLive')}</Title>
      <Body>{say('pickTheMachineThatStays')}</Body>
      <Group>
        {fr.rows.map((r) => (
          <GroupItem
            key={r.id}
            title={r.name}
            detail={r.subtitle}
            badge={r.recommended ? say('recommended') : undefined}
            end={r.id === picked ? 'check' : 'none'}
            onPress={() => choose(r.id)}
          />
        ))}
      </Group>
      {name && <ActPill strong title={say('continueWith', { name })} intent={{ kind: 'choose-home', machineId: picked! }} act={act} />}
      <Body>{say('everythingMomoKnowsStaysOn')}</Body>
    </View>
  );
}

/** Run MoMo here again: the home's own words for the confirmation come first, and only its button sends the reclaim. */
function Reclaim({
  reclaim,
  act,
}: {
  reclaim: NonNullable<Extract<NonNullable<ReturnType<typeof movePanel>>, { kind: 'failed' }>['reclaim']>;
  act: Act;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <View style={{ marginTop: 12 }}>
        <Pill disabled={false} title={reclaim.action.label} onPress={() => setAsking(true)} />
      </View>
    );
  return (
    <View style={{ marginTop: 16 }}>
      <Title>{reclaim.sheet.title}</Title>
      <Body dim={false}>{reclaim.sheet.body}</Body>
      <ButtonRow>
        <ActPill strong title={reclaim.sheet.confirm} intent={reclaim.action.intent} act={act} />
        <Pill disabled={false} title={say('cancel')} onPress={() => setAsking(false)} />
      </ButtonRow>
    </View>
  );
}
