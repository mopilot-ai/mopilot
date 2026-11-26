// The question, result and watch-changed cards of the chat: their words come from the row view models; session text is drawn as plain text.
import { Text, View } from 'react-native';
import { draftOf } from '../../../../shared/momoDraft.mjs';
import type { MomoChatRow, MomoDraftRow } from '../../../../shared/momoView';
import { say } from '../../momoPhone/say';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import { DraftCard } from '../MomoDraft';
import { questionCard, resultCard, watchCard } from '../../momoPhone/rowModels';
import { Actions, Body, Card, Title, type Act } from './parts';

export function RowCardView({
  row,
  now,
  act,
}: {
  row: Extract<MomoChatRow, { kind: 'question' | 'result' | 'watch-changed' }>;
  now: number;
  act: Act;
}) {
  const card =
    row.kind === 'question' ? questionCard(row.question, now) : row.kind === 'result' ? resultCard(row.result) : watchCard(row.watch);
  return (
    <Card>
      <Title>{card.title}</Title>
      {!!card.meta && <Body dim>{card.meta}</Body>}
      {card.lines.map((line) => (
        <Body key={line}>{line}</Body>
      ))}
      <Actions actions={card.actions} act={act} />
    </Card>
  );
}

/**
 * A reply MoMo drafted from a mail: the phone's own draft card (Edit, Copy, Open in Mail), the same one MoMo's chat uses. The body came from outside text, so it
 * is drawn as plain text only and nothing in it is a link; a draft that does not pass the shared check is not drawn, and one cut to its size says so.
 */
export function DraftRowView({ row }: { row: MomoDraftRow }) {
  const theme = useTheme();
  const draft = draftOf(row.draft);
  if (!draft) return null;
  return (
    <View style={{ marginBottom: 12 }}>
      {/* keyed on what the draft says: a Host's update of the same row replaces the text shown, and drops an edit made on the old one */}
      <DraftCard key={JSON.stringify(draft)} draft={draft} />
      {row.truncated && <Text style={{ ...typo.footnote, color: theme.ink2, marginTop: 4 }}>{say('draftCutShort')}</Text>}
    </View>
  );
}
