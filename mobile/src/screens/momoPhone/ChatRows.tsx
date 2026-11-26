// MoMo's chat rows: its words in serif, your bubbles with what the home knows of each, the brief, the catch-up and approval cards; the last page of them is drawn, earlier ones come on a tap, and a row draws again only when its own words change.
import { memo } from 'react';
import { Text, View } from 'react-native';
import { EarlierRow } from '../../components/EarlierRow';
import { CHAT_PAGE } from '../../chatPages';
import { usePerfRender } from '../../perfLog';
import { homeName } from '../../momoPhone/common';
import { say } from '../../momoPhone/say';
import type { PhoneView } from '../../momoPhone/types';
import { briefCard, catchUpCard, turnStatus } from '../../momoPhone/viewModels';
import { keptQuietLines } from '../../momoPhone/rowModels';
import { notNeeded } from '../../momoPhone/workModels';
import { chatRef } from '../../push/chatRef';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import { Pill } from '../MomoPill';
import { ApprovalCardView, SuggestionLine } from './Approval';
import { DraftRowView, RowCardView } from './RowCards';
import { Boundary } from './Boundary';
import { ActPill, Actions, Body, Card, Serif, Title, type Act } from './parts';

type Row = PhoneView['view']['chat'][number];
type Why = (id: string) => void;

const sameRow = (a: Row, b: Row) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** One row. It is drawn again only when the row, or something it reads besides itself (`ctx`), changed. */
const RowView = memo(
  function RowView({
    row,
    view,
    act,
    why,
    aimed,
    pairId,
    onAimedLayout,
  }: {
    row: Row;
    view: PhoneView;
    act: Act;
    why: Why;
    aimed: boolean;
    pairId: string | null;
    ctx: string;
    onAimedLayout?: (y: number) => void;
  }) {
    usePerfRender('MomoRow');
    const theme = useTheme();
    switch (row.kind) {
      case 'assistant':
        return (
          <View style={{ marginBottom: 12 }}>
            <Serif>{row.text}</Serif>
            {(!!row.whyTold || !!row.decision) && (
              <View style={{ marginTop: 8 }}>
                <Pill disabled={false} title={say('whyYouSawThis')} onPress={() => why(row.id)} />
              </View>
            )}
            {row.notNeeded && !row.notNeeded.suggestion && (
              <ActPill title={say('notNeeded')} intent={notNeeded(row.id, row.decision?.decisionId)} act={act} />
            )}
            <SuggestionLine view={view} suggestion={row.notNeeded?.suggestion ?? null} act={act} />
          </View>
        );
      case 'user': {
        const status = turnStatus(view, row);
        return (
          <View style={{ alignItems: 'flex-end', marginBottom: 12 }}>
            <View style={{ backgroundColor: theme.sunken, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, maxWidth: '85%' }}>
              <Text style={{ ...typo.body, color: theme.ink }}>{row.text}</Text>
            </View>
            {status && (
              <>
                <Text style={{ ...typo.footnote, color: theme.ink2, marginTop: 4 }}>{status.status}</Text>
                {!!status.sub && <Text style={{ ...typo.footnote, color: theme.ink2 }}>{status.sub}</Text>}
                <Actions actions={status.actions} act={act} />
                {row.delivery === 'not-sure' && <Text style={{ ...typo.footnote, color: theme.ink3 }}>{say('momoNeverSendsTheSame')}</Text>}
              </>
            )}
          </View>
        );
      }
      case 'waiting':
        return (
          <Text style={{ ...typo.subhead, color: theme.ink2, marginBottom: 12, textAlign: 'right' }}>
            {say('waitingFor', { name: row.machine.name })}
          </Text>
        );
      case 'brief': {
        const c = briefCard(view, row.brief);
        const quiet = keptQuietLines(row.brief);
        return (
          <Card>
            <Title>{c.greeting}</Title>
            {!!c.attention && <Body dim={false}>{c.attention}</Body>}
            {c.offers.map((o) => (
              <View key={o.id}>
                <Body dim={false}>{o.title}</Body>
                <Body>{o.why}</Body>
                <Actions actions={o.actions} act={act} />
              </View>
            ))}
            <Body>{c.overnight}</Body>
            {quiet.length > 0 && (
              <View style={{ marginTop: 12 }}>
                <Title>{say('keptQuiet')}</Title>
              </View>
            )}
            {quiet.map((k) => (
              <View key={k.id}>
                <Body dim={false}>{k.title}</Body>
                <Body>{k.label}</Body>
                {k.undo && <Actions actions={[k.undo]} act={act} />}
              </View>
            ))}
          </Card>
        );
      }
      case 'catch-up': {
        const c = catchUpCard(row.catchUp);
        return (
          <Card>
            <Title>{c.title}</Title>
            <Body>{c.body}</Body>
          </Card>
        );
      }
      case 'approval':
        return (
          <View
            key={row.approval.body}
            style={aimed && pairId ? { borderWidth: 2, borderColor: theme.accent, borderRadius: 24 } : undefined}
            onLayout={aimed ? (e) => onAimedLayout?.(e.nativeEvent.layout.y) : undefined}
          >
            <ApprovalCardView card={row.approval} now={view.now} act={act} />
          </View>
        );
      case 'question':
      case 'result':
      case 'watch-changed':
        return <RowCardView row={row} now={view.now} act={act} />;
      case 'draft':
        return <DraftRowView row={row} />;
      default:
        // a row a newer home added: nothing here knows how to draw it, so it is left out rather than drawn as something else
        return null;
    }
  },
  (a, b) => a.ctx === b.ctx && a.aimed === b.aimed && sameRow(a.row, b.row),
);

/** What a row reads besides itself: the home's name, whether it is the last row, the clock for a card, and the state of the rule it suggested. */
const contextOf = (view: PhoneView, row: Row, last: boolean): string =>
  [
    homeName(view),
    last,
    row.kind === 'approval' || row.kind === 'question' ? view.now : '',
    row.kind === 'assistant' && row.notNeeded?.suggestion
      ? view.view.rules.find((r) => r.id === row.notNeeded?.suggestion?.ruleId)?.state
      : '',
  ].join('|');

export function ChatRows({
  view,
  act,
  why,
  aimed = null,
  pairId = null,
  shown,
  earlier,
  onAimedLayout,
}: {
  view: PhoneView;
  act: Act;
  why: Why;
  /** The card a push tap named, as `chatRef` writes it; it is outlined. */
  aimed?: string | null;
  pairId?: string | null;
  /** How many of the latest rows are drawn; `earlier` draws more. */
  shown: number;
  earlier: () => void;
  /** Where the outlined card sits, so the page can scroll to it. */
  onAimedLayout?: (y: number) => void;
}) {
  const rows = view.view.chat;
  const hidden = Math.max(0, rows.length - shown);
  return (
    <>
      {hidden > 0 && <EarlierRow more omitted={false} busy={false} error={null} load={earlier} />}
      {rows.slice(hidden).map((row, i, drawn) => (
        <Boundary
          key={row.id}
          resetKey={row}
          // a row that cannot be drawn says so in a line: it never just disappears from the chat
          fallback={
            <View style={{ marginBottom: 12 }}>
              <Body>{say('couldNotShow')}</Body>
            </View>
          }
        >
          <RowView
            row={row}
            view={view}
            act={act}
            why={why}
            pairId={pairId}
            onAimedLayout={onAimedLayout}
            aimed={row.kind === 'approval' && !!aimed && !!pairId && chatRef(pairId, row.approval.id) === aimed}
            ctx={contextOf(view, row, hidden + i === rows.length - 1)}
          />
        </Boundary>
      ))}
    </>
  );
}

export { CHAT_PAGE };
