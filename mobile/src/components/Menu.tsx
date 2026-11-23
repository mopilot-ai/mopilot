// A "⋯" button (or another trigger) that opens a short menu: on iOS the system menu anchored to the button (an action sheet for a custom trigger), a small list under the button elsewhere.
import { useState, type ReactNode } from 'react';
import { ActionSheetIOS, Platform, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { Icon, IconButton } from './Icon';
import { Button as MenuEntry, Host, Image, Menu } from '@expo/ui/swift-ui';
import { accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { typo } from '../typography';

export type MenuItem = { label: string; onPress: () => void };

/** The references keep a chat's secondary screens behind one "⋯" (Cursor, Claude); this is that control. */
export function MenuButton({ label, items, children }: { label: string; items: MenuItem[]; children?: ReactNode }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  // the ⋯ itself opens iOS's own menu, anchored to it as in Cursor and Claude
  if (Platform.OS === 'ios' && !children)
    return (
      <Host matchContents style={{ minWidth: 38, minHeight: 38, alignItems: 'center', justifyContent: 'center' }}>
        <Menu label={<Image systemName="ellipsis.circle" size={22} color={theme.ink} />} modifiers={[accessibilityLabel(label)]}>
          {items.map((item) => (
            <MenuEntry key={item.label} label={item.label} onPress={item.onPress} />
          ))}
        </Menu>
      </Host>
    );
  const show = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...items.map((item) => item.label), 'Cancel'], cancelButtonIndex: items.length },
        (index) => items[index]?.onPress(),
      );
      return;
    }
    setOpen((was) => !was);
  };
  return (
    <View>
      <IconButton label={label} onPress={show}>
        {children ?? <Icon name="ellipsis.circle" glyph="⋯" />}
      </IconButton>
      {open && (
        <View
          style={{
            position: 'absolute',
            top: 40,
            right: 0,
            minWidth: 180,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.line,
            backgroundColor: theme.surface,
            paddingVertical: 4,
            zIndex: 10,
          }}
        >
          {items.map((item) => (
            <Tap
              key={item.label}
              accessibilityRole="menuitem"
              accessibilityLabel={item.label}
              onPress={() => {
                setOpen(false);
                item.onPress();
              }}
              style={[{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 14 }]}
            >
              <Text style={{ ...typo.callout, color: theme.ink }}>{item.label}</Text>
            </Tap>
          ))}
        </View>
      )}
    </View>
  );
}
