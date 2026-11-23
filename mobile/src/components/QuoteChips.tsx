// The words a person asked about (#5359), one chip each above the composer's field: a quote mark, the words cut to one line, and a button that takes the quote out.
import { Text, View } from 'react-native';
import { useTheme } from '../theme';
import { typo } from '../typography';
import { t } from '../ui/i18n';
import { Tap } from '../ui/ds/Tap';
import { chipText } from '../presentation/quoteChips';
import { Icon } from './Icon';

export function QuoteChips({ quotes, remove }: { quotes: string[]; remove: (index: number) => void }) {
  const theme = useTheme();
  if (!quotes.length) return null;
  return (
    <View style={{ gap: 6 }}>
      {quotes.map((block, index) => (
        <View
          // the same words may be quoted once only (`withQuote`), so the words are the key
          key={block}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            backgroundColor: theme.sunken,
            borderRadius: 12,
            paddingVertical: 6,
            paddingLeft: 10,
            paddingRight: 4,
          }}
        >
          <Icon name="quote.opening" glyph="“" size={14} color={theme.ink} />
          <Text
            numberOfLines={1}
            accessibilityLabel={`${t('composer.quoted')}: ${chipText(block)}`}
            style={[typo.footnote, { color: theme.ink, flex: 1 }]}
          >
            {chipText(block)}
          </Text>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={t('composer.removeQuote')}
            hitSlop={8}
            onPress={() => remove(index)}
            style={{ minWidth: 28, minHeight: 28, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="xmark" glyph="×" size={12} color={theme.ink} />
          </Tap>
        </View>
      ))}
    </View>
  );
}
