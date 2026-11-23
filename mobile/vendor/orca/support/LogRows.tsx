// The rows of a connection log: elapsed time, a level glyph and the line with its detail; colours and spacing come in as props so the file reaches no theme.
import { Text, View } from "react-native";

export type LogRowEntry = {
  id: string;
  ts: number;
  level: "info" | "success" | "warn" | "error";
  message: string;
  detail?: string;
};

export type LogRowColors = {
  info: string;
  success: string;
  warn: string;
  error: string;
  muted: string;
};

const LEVEL_GLYPH: Record<LogRowEntry["level"], string> = {
  info: "•",
  success: "✓",
  warn: "!",
  error: "✕",
};

export function formatElapsed(ts: number, baseTs: number): string {
  // Elapsed seconds expose connection stalls better than wall-clock time.
  const elapsed = Math.max(0, ts - baseTs) / 1000;
  if (elapsed < 10) {
    return `+${elapsed.toFixed(2)}s`;
  }
  if (elapsed < 100) {
    return `+${elapsed.toFixed(1)}s`;
  }
  return `+${Math.round(elapsed)}s`;
}

export function LogRows({
  entries,
  baseTs,
  colors,
  mono,
}: {
  entries: readonly LogRowEntry[];
  baseTs: number;
  colors: LogRowColors;
  mono?: string;
}) {
  const seen = new Map<string, number>();
  return (
    <View>
      {entries.map((entry) => {
        const occurrence = seen.get(entry.id) ?? 0;
        seen.set(entry.id, occurrence + 1);
        const key = occurrence === 0 ? entry.id : `${entry.id}:${occurrence}`;
        return (
          <View
            key={key}
            style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}
          >
            <Text
              style={{
                width: 64,
                fontSize: 12,
                color: colors.muted,
                fontFamily: mono,
              }}
            >
              {formatElapsed(entry.ts, baseTs)}
            </Text>
            <Text
              style={{ width: 14, fontSize: 12, color: colors[entry.level] }}
            >
              {LEVEL_GLYPH[entry.level]}
            </Text>
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 14,
                  lineHeight: 19,
                  color: colors[entry.level],
                }}
              >
                {entry.message}
              </Text>
              {entry.detail ? (
                <Text
                  numberOfLines={2}
                  style={{ fontSize: 12, lineHeight: 16, color: colors.muted }}
                >
                  {entry.detail}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
