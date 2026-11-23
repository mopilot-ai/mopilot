// Device storage for the launch and chat-open timings Settings › About lists: a SQLite table of step names and milliseconds, nothing else.
import { openDatabase } from './sqliteOpen';
import { KEPT, type TraceRecord, type TraceStore } from '../launchTrace';

export async function openTraceStore(): Promise<TraceStore> {
  const db = await openDatabase('mobile-remote-trace.db');
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS trace (kind TEXT NOT NULL, id INTEGER NOT NULL, at INTEGER NOT NULL, steps TEXT NOT NULL, PRIMARY KEY (kind, id))',
  );
  return {
    load: async () =>
      (await db.getAllAsync<{ kind: string; id: number; at: number; steps: string }>('SELECT kind, id, at, steps FROM trace')).map((r) => ({
        kind: r.kind as TraceRecord['kind'],
        id: r.id,
        at: r.at,
        steps: JSON.parse(r.steps) as TraceRecord['steps'],
      })),
    save: async (record) => {
      await db.runAsync(
        'INSERT OR REPLACE INTO trace (kind, id, at, steps) VALUES (?, ?, ?, ?)',
        record.kind,
        record.id,
        record.at,
        JSON.stringify(record.steps),
      );
      // only the last few of each kind stay
      await db.runAsync(
        'DELETE FROM trace WHERE kind = ? AND id NOT IN (SELECT id FROM trace WHERE kind = ? ORDER BY id DESC LIMIT ?)',
        record.kind,
        record.kind,
        KEPT[record.kind],
      );
    },
  };
}
