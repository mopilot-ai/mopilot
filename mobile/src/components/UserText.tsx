// The words of your own message: plain text, or, when it starts with a quote (a Reply on a selection, #4837), the quote as a quote block above what you wrote.
import { Text, View } from 'react-native';
import { splitQuote } from '../../../shared/quotedReply.mjs';
import { useTheme } from '../theme';
import { LinkedText } from './LinkedText';
import { typo } from '../typography';

export function UserText({ text, label, a11y }: { text: string; label: string; a11y?: object }) {
  const theme = useTheme();
  const split = splitQuote(text);
  if (!split)
    return (
      <Text accessibilityLabel={label} {...a11y} style={{ ...typo.body, color: theme.ink }}>
        <LinkedText text={text} color={theme.info} />
      </Text>
    );
  return (
    <View accessible accessibilityLabel={label} {...a11y}>
      <View style={{ borderLeftWidth: 3, borderLeftColor: theme.line, paddingLeft: 10, marginBottom: split.rest ? 8 : 0 }}>
        <Text style={{ ...typo.body, color: theme.ink2 }}>{split.quote}</Text>
      </View>
      {!!split.rest && (
        <Text style={{ ...typo.body, color: theme.ink }}>
          <LinkedText text={split.rest} color={theme.info} />
        </Text>
      )}
    </View>
  );
}
