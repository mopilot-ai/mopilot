// Claude for iOS's sheet layout: a glass ✕ circle at the left, the title centred, then the sheet's content on the page colour.
import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { GlassCircle } from './Glass';
import { Icon } from './Icon';
import { typo } from '../typography';

/** The header row of a sheet: ✕ (or ‹ when `back`), the title, and an optional control at the right. */
export function SheetHeader({
  title,
  onClose,
  back = false,
  right,
}: {
  title: string;
  onClose: () => void;
  /** a sheet page reached from another one: ‹ instead of ✕ */
  back?: boolean;
  right?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <GlassCircle label={back ? 'Back' : 'Close'} onPress={onClose}>
        {back ? (
          <Icon name="chevron.left" glyph="‹" size={20} color={theme.ink} />
        ) : (
          <Icon name="xmark" glyph="×" size={18} color={theme.ink} />
        )}
      </GlassCircle>
      <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, textAlign: 'center', ...typo.bodySemibold, color: theme.ink }}>
        {title}
      </Text>
      <View style={{ minWidth: 48, alignItems: 'flex-end' }}>{right}</View>
    </View>
  );
}

/** A whole sheet: the header and its content, scrolling, on the page colour with Claude's 16 pt side inset. */
export function SheetFrame({
  title,
  onClose,
  back,
  right,
  children,
}: {
  title: string;
  onClose: () => void;
  back?: boolean;
  right?: ReactNode;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 26 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <SheetHeader title={title} onClose={onClose} back={back} right={right} />
        {children}
      </ScrollView>
    </View>
  );
}
