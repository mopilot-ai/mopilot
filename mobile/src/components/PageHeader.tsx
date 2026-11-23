// Claude for iOS's page header: a glass control at the left, the title (and a grey line) centred, glass controls at the right; no bar behind it.
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme';
import { typo } from '../typography';

/** `left` is normally a GlassCircle (drawer or Back); `right` a GlassCircle and/or GlassCapsule. An empty side keeps a 48 pt gap so the title stays centred. */
export function PageHeader({
  title,
  subtitle,
  left,
  right,
}: {
  title?: string;
  subtitle?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, backgroundColor: theme.bg }}>
      <View style={{ minWidth: 48, flexDirection: 'row' }}>{left}</View>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
        {!!title && (
          <Text accessibilityRole="header" numberOfLines={1} style={{ ...typo.bodySemibold, color: theme.ink }}>
            {title}
          </Text>
        )}
        {typeof subtitle === 'string' ? (
          <Text numberOfLines={1} style={{ ...typo.caption, color: theme.ink2 }}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      <View style={{ minWidth: 48, flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>{right}</View>
    </View>
  );
}
