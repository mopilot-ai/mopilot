// A chat's ⋯ in a 48 pt glass capsule: on iOS the system menu anchored to it (icons, sections, a red Archive, entries the Mac cannot do greyed), a small list under it elsewhere.
import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { SFSymbol } from 'expo-symbols';
import { Button as Entry, Host, Image, Menu, Section } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled as off } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { typo } from '../typography';

export type ChatMenuItem = {
  label: string;
  icon: SFSymbol;
  onPress: () => void;
  /** greyed out: the Mac cannot do it */
  disabled?: boolean;
  /** red, as Archive is */
  destructive?: boolean;
};

/** One group of entries; `title` is the small grey line above it (what the entries under it need). */
export type ChatMenuSection = { title?: string; items: ChatMenuItem[] };

/** The menu in sections (a rule between them), as the baseline's ⋯ groups Changes and Terminal, then the chat's settings, then Archive. */
export function ChatMenu({ sections }: { sections: ChatMenuSection[] }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const capsule = {
    minHeight: 48,
    minWidth: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassLine,
  } as const;
  if (Platform.OS === 'ios')
    return (
      <View style={capsule}>
        {/* a 40 pt box with the SwiftUI content centred in it (a host anchors it top-leading by default) */}
        <Host alignment="center" style={{ minWidth: 40, minHeight: 40 }}>
          <Menu label={<Image systemName="ellipsis" size={20} color={theme.ink} />} modifiers={[accessibilityLabel('Chat menu')]}>
            {sections.map((section) => (
              <Section key={section.items.map((item) => item.label).join()} title={section.title}>
                {section.items.map((item) => (
                  <Entry
                    key={item.label}
                    label={item.label}
                    systemImage={item.icon}
                    role={item.destructive ? 'destructive' : 'default'}
                    modifiers={item.disabled ? [off(true)] : undefined}
                    onPress={item.onPress}
                  />
                ))}
              </Section>
            ))}
          </Menu>
        </Host>
      </View>
    );
  return (
    <View>
      <Tap
        accessibilityRole="button"
        accessibilityLabel="Chat menu"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={capsule}
      >
        <Icon name="ellipsis" glyph="⋯" size={20} />
      </Tap>
      {open && (
        <View
          style={{
            position: 'absolute',
            top: 54,
            right: 0,
            minWidth: 240,
            borderRadius: 24,
            backgroundColor: theme.surface,
            borderWidth: 1,
            borderColor: theme.glassLine,
            overflow: 'hidden',
            zIndex: 10,
          }}
        >
          {sections.map((section, i) => (
            <View
              key={section.items.map((item) => item.label).join()}
              style={i > 0 ? { borderTopWidth: 8, borderTopColor: theme.sunken } : undefined}
            >
              {!!section.title && (
                <Text style={{ ...typo.footnote, color: theme.ink2, paddingHorizontal: 16, paddingTop: 10 }}>{section.title}</Text>
              )}
              {section.items.map((item) => (
                <Tap
                  key={item.label}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.label}
                  accessibilityState={{ disabled: !!item.disabled }}
                  disabled={item.disabled}
                  onPress={() => {
                    setOpen(false);
                    item.onPress();
                  }}
                  style={[
                    { minHeight: 46, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
                    item.disabled && { opacity: 0.4 },
                  ]}
                >
                  <Text style={{ flex: 1, ...typo.body, color: item.destructive ? theme.bad : theme.ink }}>{item.label}</Text>
                  <Icon name={item.icon} glyph="" size={18} color={item.destructive ? theme.bad : theme.ink} />
                </Tap>
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
