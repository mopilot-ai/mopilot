// MoMo's suggestions on the classic phone's Up next (A7), where the Mac lists momo.suggestions.list and .act: "From your sources" (title and one source line, a tap opens the suggestion) and "Added by you", at most the Mac's `shown` new ones with "Show n more"; a suggestion's page has its reason, the first step and what the ranking used, with Start, Add and Hide, each the user's own press on the Mac. Only Start sends anything, and the Mac sends it as the user's own message to MoMo's chat.
import { useState } from 'react';
import { View } from 'react-native';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import type { Suggestion, SuggestionAction, SuggestionsView } from '../momo/suggestionsContract';
import { useTranslation } from '../ui/i18n';
import type { Act } from './MomoPageParts';

const pct = (n: number) => String(Math.round(n * 100) / 100);

/** Up next's suggestion groups: what MoMo suggested, then what the user kept. */
export function SuggestionGroups({ view, open }: { view: SuggestionsView; open: (s: Suggestion) => void }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const fresh = view.suggestions.filter((s) => s.status === 'new');
  const added = view.suggestions.filter((s) => s.status === 'added');
  const visible = all ? fresh : fresh.slice(0, view.shown);
  const more = fresh.length - visible.length;
  // VoiceOver reads the title and then its source line, as the grey line shows them
  const row = (s: Suggestion) => (
    <GroupItem key={s.id} title={s.title} detail={s.source} say={s.source} end="chevron" onPress={() => open(s)} />
  );
  return (
    <View>
      {visible.length > 0 && (
        <View>
          <GroupLabel>{t('momoTasks.fromSources')}</GroupLabel>
          <Group>
            {visible.map(row)}
            {more > 0 && <GroupItem key="more" title={t('momoTasks.showMore', { n: more })} tone="link" onPress={() => setAll(true)} />}
          </Group>
        </View>
      )}
      {added.length > 0 && (
        <View>
          <GroupLabel>{t('momoTasks.addedByYou')}</GroupLabel>
          <Group>{added.map(row)}</Group>
        </View>
      )}
    </View>
  );
}

/** A suggestion's own page: why MoMo told it, the first step, what the ranking used, and the user's Start, Add and Hide. */
export function SuggestionPage({
  suggestion,
  act,
  busy,
  done,
  started,
}: {
  suggestion: Suggestion;
  act: Act;
  busy: boolean;
  /** after Add or Hide: back to the page */
  done: () => void;
  /** after Start: the sheet closes, so MoMo's chat shows what was sent */
  started: () => void;
}) {
  const { t } = useTranslation();
  const go = (action: SuggestionAction) =>
    busy ? undefined : () => act((api) => api.actSuggestion(suggestion.id, action), action === 'start' ? started : done);
  const { score } = suggestion;
  return (
    <View>
      {/* the title (the sheet's header) and the source line are read as one element */}
      <View accessible accessibilityLabel={`${suggestion.title}. ${suggestion.source}`}>
        <GroupLabel>{suggestion.source}</GroupLabel>
      </View>
      <Group>
        {!!suggestion.why && <GroupItem key="why" title={t('momoTasks.why')} detail={suggestion.why} />}
        {!!suggestion.step && <GroupItem key="step" title={t('momoTasks.firstStep')} detail={suggestion.step} />}
        <GroupItem
          key="ranked"
          title={t('momoTasks.ranked', {
            urgency: pct(score.urgency),
            cost: pct(score.cost),
            confidence: pct(score.confidence),
            novelty: pct(score.novelty),
          })}
        />
      </Group>
      <Group>
        <GroupItem
          key="start"
          title={t('momoTasks.start')}
          label={t('momoTasks.startNamed', { title: suggestion.title })}
          tone="link"
          onPress={go('start')}
        />
        {suggestion.status === 'new' && (
          <GroupItem
            key="add"
            title={t('momoTasks.add')}
            label={t('momoTasks.addNamed', { title: suggestion.title })}
            onPress={go('add')}
          />
        )}
        <GroupItem
          key="hide"
          title={t('momoTasks.hide')}
          label={t('momoTasks.hideNamed', { title: suggestion.title })}
          tone="danger"
          onPress={go('hide')}
        />
      </Group>
    </View>
  );
}
