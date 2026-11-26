// The approval card (To, Attached, quoted body; Send, Edit, Don't send; expired; answered on another device) and the inline rule suggestion with Undo.
import { say } from '../../momoPhone/say';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import type { MomoApprovalView } from '../../../../shared/momoView';
import type { PhoneView } from '../../momoPhone/types';
import { approvalView, suggestionView } from '../../momoPhone/viewModels';
import { Pill } from '../MomoPill';
import { ActPill, ButtonRow, Actions, Body, Card, Serif, Title, type Act } from './parts';

export function ApprovalCardView({ card, now, act }: { card: MomoApprovalView; now: number; act: Act }) {
  const theme = useTheme();
  const v = approvalView(card, now);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.body);
  const field = (label: string, value: string | null) =>
    value ? (
      <Text style={{ ...typo.subhead, color: theme.ink2, marginTop: 4 }}>
        {label} <Text style={{ color: theme.ink }}>{value}</Text>
      </Text>
    ) : null;
  const actions = v.actions;
  return (
    <Card>
      <Title>{v.title}</Title>
      {!!v.status && <Body dim={v.status !== say('expired')}>{v.status}</Body>}
      {!!v.statusSub && <Body>{v.statusSub}</Body>}
      {field(say('to'), v.to)}
      {field(say('subject'), v.subject)}
      {field(say('attached'), v.attached)}
      {v.details.map((d) => field(d.label, d.value))}
      {editing ? (
        <TextInput
          accessibilityLabel={say('emailText')}
          multiline
          value={text}
          onChangeText={setText}
          style={{
            ...typo.body,
            color: theme.ink,
            marginTop: 8,
            minHeight: 88,
            borderRadius: 14,
            padding: 10,
            backgroundColor: theme.sunken,
          }}
        />
      ) : (
        <View style={{ marginTop: 8, borderLeftWidth: 2, borderLeftColor: theme.line, paddingLeft: 10 }}>
          <Serif>{v.body}</Serif>
        </View>
      )}
      {editing ? (
        <ButtonRow>
          <ActPill strong title={say('send')} intent={{ kind: 'approval', cardId: card.id, answer: 'edit', body: text }} act={act} />
          <Pill disabled={false} title={say('cancel')} onPress={() => setEditing(false)} />
        </ButtonRow>
      ) : (
        <ButtonRow top={actions.length ? 12 : 0}>
          {actions.map((a) =>
            a.intent.kind === 'approval' && a.intent.answer === 'edit' ? (
              <Pill key={a.label} strong={a.strong} disabled={false} title={a.label} onPress={() => setEditing(true)} />
            ) : (
              <ActPill key={a.label} strong={a.strong} title={a.label} intent={a.intent} act={act} />
            ),
          )}
        </ButtonRow>
      )}
      {!!v.footer && <Body>{v.footer}</Body>}
    </Card>
  );
}

/** "Second time. I will stay quiet about deliveries." with Undo and See rule. */
export function SuggestionLine({
  view,
  suggestion,
  act,
}: {
  view: PhoneView;
  suggestion: { ruleId: string; text: string } | null;
  act: Act;
}) {
  const v = suggestionView(view, suggestion);
  if (!v) return null;
  return (
    <Card>
      <Title>{v.line}</Title>
      <Body>{v.sub}</Body>
      <Actions actions={v.actions} act={act} />
    </Card>
  );
}
