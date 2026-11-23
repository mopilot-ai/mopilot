// The pairing wait in the new UI: the safety number to compare with the Mac, a pairing that is finishing, or one left unfinished; the handshake and number stay with the runtime.
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Pressable } from '../ds';
import { groupSafety, speakSafety } from '../../../../shared/remote/safetyNumber.mjs';
import { monoFamily } from '../../fonts';
import { t, typo, useLanguage, useAppear, useTokens } from './adapters';
import Animated from 'react-native-reanimated';

export type PairingVM = {
  phase: 'confirm' | 'finishing' | 'unfinished';
  safetyNumber: string | null;
  busy: boolean;
};

function Pill({
  title,
  onPress,
  danger = false,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const tk = useTokens();
  return (
    <Pressable
      label={title}
      onPress={onPress}
      disabled={disabled}
      style={{
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 24,
        backgroundColor: tk.sunken,
      }}
    >
      <Text style={{ ...typo.callout, color: danger ? tk.bad : tk.ink }}>{title}</Text>
    </Pressable>
  );
}

export function PairingConfirm({ vm, onCancel }: { vm: PairingVM; onCancel: () => void }) {
  useLanguage();
  const tk = useTokens();
  const appear = useAppear(0);
  const [open, setOpen] = useState(false);
  if (vm.phase === 'finishing')
    return (
      <Animated.View
        accessibilityLiveRegion="polite"
        entering={appear}
        style={{ borderRadius: 22, backgroundColor: tk.surface, padding: 20 }}
      >
        <Text style={{ ...typo.title3, color: tk.ink }}>{t('pair.finishing')}</Text>
      </Animated.View>
    );
  if (vm.phase === 'unfinished')
    return (
      <Animated.View
        entering={appear}
        style={{
          borderRadius: 22,
          backgroundColor: tk.surface,
          padding: 20,
          gap: 12,
        }}
      >
        <Text style={{ ...typo.title3, color: tk.ink }}>{t('pair.unfinished')}</Text>
        <Text style={{ ...typo.subhead, color: tk.ink2 }}>{t('pair.unfinishedBody')}</Text>
        <Pill title={t('pair.remove')} disabled={vm.busy} onPress={onCancel} />
      </Animated.View>
    );
  return (
    <Animated.View
      entering={appear}
      style={{
        borderRadius: 22,
        backgroundColor: tk.surface,
        padding: 20,
        gap: 12,
      }}
    >
      <Text style={{ ...typo.title3, color: tk.ink }}>{t('pair.title')}</Text>
      <Text style={{ ...typo.subhead, color: tk.ink2 }}>{t('pair.body')}</Text>
      {vm.safetyNumber ? (
        <View style={{ gap: 4 }}>
          <Pressable
            label={t('pair.check')}
            onPress={() => setOpen(!open)}
            style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ ...typo.subhead, color: tk.accent }}>{`${t('pair.check')} ${open ? '▴' : '▾'}`}</Text>
          </Pressable>
          {open && (
            <>
              <Text
                accessibilityLabel={t('pair.safety', {
                  spoken: speakSafety(vm.safetyNumber),
                })}
                style={{ ...typo.title2, fontFamily: monoFamily(), color: tk.ink }}
              >
                {groupSafety(vm.safetyNumber)}
              </Text>
              <Text style={{ ...typo.footnote, color: tk.ink2 }}>{t('pair.same')}</Text>
            </>
          )}
        </View>
      ) : null}
      <Pill title={t('pair.cancel')} danger onPress={onCancel} />
    </Animated.View>
  );
}
