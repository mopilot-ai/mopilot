// The connection log page's body: lines newest first with elapsed time, and Copy; the rows come from the ported log rows.
import { Text, View } from 'react-native';
import { Pressable } from '../ds';
import { LogRows, type LogRowEntry } from '../../../vendor/orca/support/LogRows';
import { monoFamily } from '../../fonts';
import { t, typo, useLanguage, useTokens } from './adapters';
import type { LogLevel, LogLine } from './connectionLog';

const LEVEL: Record<LogLevel, LogRowEntry['level']> = {
  info: 'info',
  ok: 'success',
  warn: 'warn',
  bad: 'error',
};

export function ConnectionLogView({ lines, copied, onCopy }: { lines: readonly LogLine[]; copied: boolean; onCopy: () => void }) {
  useLanguage();
  const tk = useTokens();
  if (!lines.length) return <Text style={{ ...typo.body, color: tk.ink2, paddingHorizontal: 16 }}>{t('log.empty')}</Text>;
  const entries = lines.map<LogRowEntry>((l) => ({
    id: l.id,
    ts: l.at,
    level: LEVEL[l.level],
    message: l.text,
  }));
  // lines are newest first: the oldest is the last
  const base = lines[lines.length - 1].at;
  return (
    <View style={{ gap: 12 }}>
      <Pressable
        label={t('log.copy')}
        onPress={onCopy}
        style={{
          alignSelf: 'flex-end',
          minHeight: 44,
          justifyContent: 'center',
          paddingHorizontal: 16,
        }}
      >
        <Text style={{ ...typo.body, color: tk.accent }}>{copied ? t('log.copied') : t('log.copy')}</Text>
      </Pressable>
      <View
        style={{
          borderRadius: 22,
          backgroundColor: tk.surface,
          paddingHorizontal: 16,
          paddingVertical: 8,
        }}
      >
        <LogRows
          entries={entries}
          baseTs={base}
          mono={monoFamily()}
          colors={{
            info: tk.ink2,
            success: tk.ok,
            warn: tk.warn,
            error: tk.bad,
            muted: tk.ink3,
          }}
        />
      </View>
    </View>
  );
}
