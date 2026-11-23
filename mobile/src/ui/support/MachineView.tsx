// The machine page's body: the Host's own state first, how this phone reaches it, the Mac's state when it matters, its agents, and the one action; waiting cards come in through a slot so they stay the existing card code.
import type { ReactNode } from 'react';
import Animated from 'react-native-reanimated';
import { Text, View } from 'react-native';
import { Pressable } from '../ds';
import { t, typo, useLanguage, useAppear, useTokens } from './adapters';

export type MachineViewModel = {
  name: string;
  line: string;
  tone: 'ok' | 'warn' | 'off';
  reach: string | null;
  keepRunning: boolean | null;
  /** What the Mac's state adds while this page is reached directly; null when nothing. */
  notice: string | null;
  waiting: number;
  /** Opens New chat on this machine; null when the machine cannot start one. */
  newChat: (() => void) | null;
  agents: readonly { id: string; label: string; line: string }[];
  /** A step of setting up direct access: its words, and its button when there is one. */
  setup: {
    line: string | null;
    action: { title: string; onPress: () => void } | null;
  };
};

function Line({ title, value, children }: { title: string; value?: string | null; children?: ReactNode }) {
  const tk = useTokens();
  return (
    <View
      accessible
      accessibilityLabel={value ? `${title}, ${value}` : title}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        minHeight: 48,
        paddingHorizontal: 16,
      }}
    >
      <Text style={{ ...typo.body, color: tk.ink }}>{title}</Text>
      {children ?? <Text style={{ ...typo.body, color: tk.ink2, flexShrink: 1 }}>{value}</Text>}
    </View>
  );
}

export function MachineView({ vm, children }: { vm: MachineViewModel; children?: ReactNode }) {
  useLanguage();
  const tk = useTokens();
  const appear = useAppear(0);
  const dot = vm.tone === 'ok' ? tk.ok : vm.tone === 'warn' ? tk.warn : tk.ink3;
  return (
    <Animated.View entering={appear} style={{ gap: 16 }}>
      <View
        style={{
          borderRadius: 22,
          backgroundColor: tk.surface,
          overflow: 'hidden',
        }}
      >
        <Line title={t('machine.status')}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              flexShrink: 1,
            }}
          >
            <View
              style={{
                width: 8,
                aspectRatio: 1,
                borderRadius: 4,
                backgroundColor: dot,
              }}
            />
            <Text numberOfLines={2} style={{ ...typo.callout, color: tk.ink2, flexShrink: 1 }}>
              {vm.line}
            </Text>
          </View>
        </Line>
        {vm.reach !== null ? <Line title={t('machine.reach')} value={vm.reach} /> : null}
        {vm.keepRunning !== null ? <Line title={t('machine.keep')} value={vm.keepRunning ? t('machine.on') : t('machine.off')} /> : null}
      </View>
      {vm.notice ? <Text style={{ ...typo.footnote, color: tk.ink2, paddingHorizontal: 16 }}>{vm.notice}</Text> : null}
      {vm.newChat ? (
        <View style={{ borderRadius: 22, backgroundColor: tk.surface, overflow: 'hidden' }}>
          <Pressable label={t('machine.newChat')} onPress={vm.newChat} style={{ minHeight: 48, paddingHorizontal: 16 }}>
            <Text style={{ ...typo.body, color: tk.accent }}>{t('machine.newChat')}</Text>
          </Pressable>
        </View>
      ) : null}
      {children}
      {vm.setup.line || vm.setup.action ? (
        <View
          style={{
            borderRadius: 22,
            backgroundColor: tk.surface,
            overflow: 'hidden',
          }}
        >
          {vm.setup.line ? <Line title={vm.setup.line} /> : null}
          {vm.setup.action ? (
            <Pressable
              label={vm.setup.action.title}
              onPress={vm.setup.action.onPress}
              style={{
                minHeight: 48,
                justifyContent: 'center',
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ ...typo.body, color: tk.accent }}>{vm.setup.action.title}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {vm.agents.length ? (
        <View style={{ gap: 6 }}>
          <Text style={{ ...typo.footnote, color: tk.ink2, paddingHorizontal: 16 }}>{t('machine.agents')}</Text>
          <View
            style={{
              borderRadius: 22,
              backgroundColor: tk.surface,
              overflow: 'hidden',
            }}
          >
            {vm.agents.map((a) => (
              <Line key={a.id} title={a.label} value={a.line} />
            ))}
          </View>
        </View>
      ) : null}
      <Text style={{ ...typo.footnote, color: tk.ink2, paddingHorizontal: 16 }}>{t('machine.footer')}</Text>
    </Animated.View>
  );
}
