// Opens the phone's SQLite databases one at a time, so native first-use setup never runs on two threads at once.
import * as SQLite from 'expo-sqlite';

// expo-sqlite runs each open on Swift's concurrent pool; at launch the stores opened together and raced the native file-system
// manager's first initialization into a use-after-free. Opening serially keeps that path single-threaded even without the native patch.
let opening: Promise<unknown> = Promise.resolve();

export function openDatabase(name: string): Promise<SQLite.SQLiteDatabase> {
  const result = opening.then(() => SQLite.openDatabaseAsync(name));
  opening = result.catch(() => undefined);
  return result;
}
