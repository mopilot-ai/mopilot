// The troubleshoot checklist: steps appear one after another with their result, one step names what failed, and Run again and Copy log sit under it.
import Animated from 'react-native-reanimated';
import { Text, View } from 'react-native';
import { Pressable } from '../ds';
import { t, typo, useLanguage, useAppear, useTokens } from './adapters';
import type { Check, Diagnosis } from './supportModel';

const MARK = { pass: '✓', fail: '✗', skip: '–' } as const;

function Row({ check, index }: { check: Check; index: number }) {
  const tk = useTokens();
  const appear = useAppear(index);
  const color = check.status === 'pass' ? tk.ok : check.status === 'fail' ? tk.bad : tk.ink3;
  return (
    <Animated.View
      accessible
      accessibilityLabel={[check.label, { pass: 'ok', fail: 'problem', skip: 'not checked' }[check.status], check.hint]
        .filter(Boolean)
        .join(', ')}
      entering={appear}
      style={{
        flexDirection: 'row',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
      }}
    >
      <Text style={{ ...typo.body, color, width: 18 }}>{MARK[check.status]}</Text>
      <View style={{ flex: 1 }}>
        <Text
          style={{
            ...typo.body,
            color: check.status === 'skip' ? tk.ink3 : tk.ink,
          }}
        >
          {check.label}
        </Text>
        {check.hint ? <Text style={{ ...typo.footnote, color: tk.bad }}>{check.hint}</Text> : null}
      </View>
    </Animated.View>
  );
}

function Action({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  const tk = useTokens();
  return (
    <Pressable
      label={title}
      onPress={onPress}
      disabled={disabled}
      style={{
        flex: 1,
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 24,
        backgroundColor: tk.sunken,
      }}
    >
      <Text style={{ ...typo.callout, color: tk.ink }}>{title}</Text>
    </Pressable>
  );
}

export function TroubleshootView({
  checks,
  diagnosis,
  running,
  copied,
  onRun,
  onCopy,
  onOpenLog,
}: {
  checks: readonly Check[];
  diagnosis: Diagnosis | null;
  running: boolean;
  copied: boolean;
  onRun: () => void;
  onCopy: () => void;
  onOpenLog: () => void;
}) {
  useLanguage();
  const tk = useTokens();
  return (
    <View style={{ gap: 16 }}>
      {diagnosis && !running ? (
        <View accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, gap: 2 }}>
          <Text
            style={{
              ...typo.title3,
              color: diagnosis.kind === 'ok' ? tk.ok : tk.ink,
            }}
          >
            {diagnosis.title}
          </Text>
          {diagnosis.hint ? <Text style={{ ...typo.subhead, color: tk.ink2 }}>{diagnosis.hint}</Text> : null}
        </View>
      ) : null}
      <View
        style={{
          borderRadius: 22,
          backgroundColor: tk.surface,
          overflow: 'hidden',
        }}
      >
        {checks.map((c, i) => (
          <Row key={c.id} check={c} index={i} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Action title={running ? t('troubleshoot.running') : t('troubleshoot.run')} disabled={running} onPress={onRun} />
        <Action title={copied ? t('troubleshoot.copied') : t('troubleshoot.copy')} onPress={onCopy} />
      </View>
      <Pressable
        label={t('troubleshoot.log')}
        onPress={onOpenLog}
        style={{
          minHeight: 44,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ ...typo.body, color: tk.accent }}>{t('troubleshoot.log')}</Text>
      </Pressable>
    </View>
  );
}
