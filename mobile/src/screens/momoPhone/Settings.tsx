// MoMo's settings pages on the phone: Rules, Morning brief, the notification permission prompt and previews on or off, and the "Why you saw this" page.
import { say } from '../../momoPhone/say';
import { Switch, Text, View } from 'react-native';
import { Group, GroupItem } from '../../components/Grouped';
import { Tap } from '../../ui/ds/Tap';
import { Pill } from '../MomoPill';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import { switchColors } from '../../ui/ds/tokens';
import type { PhoneView } from '../../momoPhone/types';
import type { MomoDecisionView } from '../../../../shared/momoView';
import {
  briefView,
  clampCap,
  decisionView,
  permissionView,
  previewSample,
  previewView,
  ruleRows,
  rulesEmpty,
} from '../../momoPhone/workModels';
import { ActPill, ButtonRow, Body, Title, type Act } from './parts';

export function RulesScreen({ view, act }: { view: PhoneView; act: Act }) {
  const rows = ruleRows(view);
  if (!rows.length) {
    return (
      <View>
        <Title>{rulesEmpty().title}</Title>
        <Body>{rulesEmpty().body}</Body>
      </View>
    );
  }
  return (
    <Group>
      {rows.map((r) => (
        <GroupItem
          key={r.id}
          title={r.words}
          detail={r.detail}
          trailing={
            <Switch value={r.on} onValueChange={(on) => act({ kind: 'rule-set', ruleId: r.id, on })} accessibilityLabel={r.words} />
          }
        />
      ))}
    </Group>
  );
}

/** One end of the daily-cap stepper: a 44 pt round button. */
function Step({ label, glyph, onPress }: { label: string; glyph: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: 44,
        minWidth: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.sunken,
      }}
    >
      <Text style={{ ...typo.title3, color: theme.ink }}>{glyph}</Text>
    </Tap>
  );
}

export function BriefSettings({ view, act }: { view: PhoneView; act: Act }) {
  const theme = useTheme();
  const b = briefView(view.view.settings);
  const colors = switchColors(theme);
  return (
    <View>
      <Title>{say('morningBrief')}</Title>
      <Group>
        <GroupItem
          key="on"
          title={b.toggle.label}
          trailing={
            <Switch
              value={b.on}
              trackColor={{ false: colors.off, true: colors.on }}
              onValueChange={() => act(b.toggle.intent)}
              accessibilityLabel={b.toggle.label}
            />
          }
        />
        {b.rows.map((r) => (
          <GroupItem
            key={r.label}
            title={r.label}
            value={r.value}
            trailing={
              r.id === 'cap' ? (
                <View style={{ flexDirection: 'row', gap: 4 }}>
                  <Step
                    label={say('fewer')}
                    glyph="−"
                    onPress={() => act({ kind: 'prefs', patch: { dailyCap: clampCap(view.view.settings.dailyCap - 1) } })}
                  />
                  <Step
                    label={say('more')}
                    glyph="+"
                    onPress={() => act({ kind: 'prefs', patch: { dailyCap: clampCap(view.view.settings.dailyCap + 1) } })}
                  />
                </View>
              ) : undefined
            }
          />
        ))}
      </Group>
      <Body>{b.note}</Body>
    </View>
  );
}

export function PermissionPrompt({ view, act, notNow }: { view: PhoneView; act: Act; notNow: () => void }) {
  const p = permissionView(view);
  return (
    <View>
      <Title>{p.title}</Title>
      <Body>{p.body}</Body>
      <View style={{ gap: 8, marginTop: 12 }}>
        {p.actions.map((a, i) =>
          a.intent ? (
            <ActPill key={a.label} strong={i === 0} title={a.label} intent={a.intent} act={act} />
          ) : (
            <Pill key={a.label} strong={i === 0} disabled={false} title={a.label} onPress={notNow} />
          ),
        )}
      </View>
    </View>
  );
}

export function PreviewSettings({ view, act }: { view: PhoneView; act: Act }) {
  const theme = useTheme();
  const p = previewView(view.view.settings, previewSample(view));
  return (
    <View>
      <Title>{p.toggle.label}</Title>
      <Group>
        <GroupItem
          key="t"
          title={p.toggle.label}
          trailing={<Switch value={p.on} onValueChange={() => act(p.toggle.intent)} accessibilityLabel={p.toggle.label} />}
        />
      </Group>
      <View style={{ borderRadius: 18, padding: 12, backgroundColor: theme.surface }}>
        <Text style={{ ...typo.footnote, color: theme.ink2 }}>{say('momoNow')}</Text>
        <Text style={{ ...typo.calloutMedium, color: theme.ink }}>{p.title}</Text>
      </View>
      <Body>{p.note}</Body>
    </View>
  );
}

export function WhyYouSawThis({
  row,
  onNotNeeded,
  act,
}: {
  row: { whyTold: string | null; decision?: MomoDecisionView | null };
  onNotNeeded: () => void;
  act: Act;
}) {
  const why = decisionView(row);
  return (
    <View>
      <Title>{say('whyYouSawThis')}</Title>
      <Body dim={false}>{why.reason}</Body>
      {why.lines.map((l) => (
        <Body key={l.label}>{`${l.label}  ${l.value}`}</Body>
      ))}
      {why.checks.length > 0 && <Body>{say('checkedLabel')}</Body>}
      {why.checks.map((c) => (
        <Body key={c} dim={false}>
          {c}
        </Body>
      ))}
      <ButtonRow>
        <Pill disabled={false} title={say('notNeeded')} onPress={onNotNeeded} />
        {why.editRule && <ActPill title={why.editRule.label} intent={why.editRule.intent} act={act} />}
      </ButtonRow>
      <Body>{say('theReasonIsMomoS')}</Body>
    </View>
  );
}
