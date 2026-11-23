// The connection log: plain-word lines the phone adds as it checks and pairs, kept short and newest first, with every secret and pairing code scrubbed before a line is stored.
import { redactConnectionLogText } from '../../../vendor/orca/support/redactLog';

export type LogLevel = 'info' | 'ok' | 'warn' | 'bad';
export type LogLine = { id: string; at: number; level: LogLevel; text: string };

const PAIR_LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S*pair\S*/gi;
const LONG_RUN = /[A-Za-z0-9_\-+/=]{24,}/g;
const SAFETY = /\b\d{4}(?: \d{4}){4}\b|\b\d{20}\b/g;

/** A line with tokens, credentials, pairing links, long key-like runs and safety numbers taken out. */
export function scrubLine(text: string): string {
  return redactConnectionLogText(text).replace(PAIR_LINK, '[code]').replace(SAFETY, '[number]').replace(LONG_RUN, '[hidden]');
}

export function createConnectionLog({ limit = 200, now = Date.now }: { limit?: number; now?: () => number } = {}) {
  let lines: LogLine[] = [];
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    add(level: LogLevel, text: string) {
      lines = [{ id: `l${++seq}`, at: now(), level, text: scrubLine(text) }, ...lines].slice(0, limit);
      emit();
    },
    /** Newest first. */
    lines: (): readonly LogLine[] => lines,
    clear() {
      lines = [];
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** The text Copy shares: one line each, time then words. */
    report: () => lines.map((l) => `${new Date(l.at).toISOString().slice(11, 19)} ${l.text}`).join('\n'),
  };
}
export type ConnectionLogStore = ReturnType<typeof createConnectionLog>;

/** The app's one log. */
export const connectionLog = createConnectionLog();
