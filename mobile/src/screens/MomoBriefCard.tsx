// A suggestion card of MoMo's morning brief in the classic phone's chat (A7): the suggestion's title and source line with Hide and Start, each the user's own press on the Mac (momo.suggestions.act; Start sends its first step to MoMo's chat as their message). What was done shows in place of the buttons.
import { Text, View } from 'react-native';
import type { BriefCard as Card } from '../../../shared/momoBriefNote.mjs';
import { Icon } from '../components/Icon';
import { Spark } from '../components/Spark';
import { useTheme } from '../theme';
import { typo } from '../typography';
import { useTranslation } from '../ui/i18n';
import type { BriefState } from '../momo/useBriefStates';
import { Pill } from './MomoPill';

export type BriefAction = 'hide' | 'start';

export function BriefCard({
  card,
  disabled,
  state,
  act,
}: {
  card: Card;
  disabled: boolean;
  /** What became of the suggestion, from the Mac's store: the buttons give way to it. */
  state?: BriefState;
  act: (action: BriefAction) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View
      style={{
        backgroundColor: theme.surface,
        borderWidth: 1,
        borderColor: theme.line,
        borderRadius: 20,
        padding: 14,
        marginBottom: 14,
        gap: 8,
      }}
    >
      {/* the title and its source line read as one element, not two */}
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={[card.title, card.source].filter(Boolean).join('. ')}
        style={{ gap: 8 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Spark size={14} />
          <Text style={{ ...typo.calloutSemibold, color: theme.ink }}>{card.title}</Text>
        </View>
        {!!card.source && <Text style={{ ...typo.subhead, color: theme.ink2 }}>{card.source}</Text>}
      </View>
      {state ? (
        <View accessibilityRole="text" style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <Icon name="checkmark" glyph="✓" size={14} color={theme.ink2} />
          <Text style={{ ...typo.subhead, color: theme.ink2 }}>
            {t(state === 'start' ? 'momoBrief.started' : state === 'hide' ? 'momoBrief.hidden' : 'momoBrief.done')}
          </Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Pill
            title={t('momoTasks.hide')}
            label={t('momoTasks.hideNamed', { title: card.title })}
            disabled={disabled}
            onPress={() => act('hide')}
          />
          <Pill
            title={t('momoTasks.start')}
            label={t('momoTasks.startNamed', { title: card.title })}
            strong
            disabled={disabled}
            onPress={() => act('start')}
          />
        </View>
      )}
    </View>
  );
}
