// Opens the Superagent database; a damaged one is set aside and the store stops, so damage is never read as "empty" and work is neither lost nor repeated.
// A stop marker survives restarts and is cleared only by an explicit acknowledge (a person's action), after which a fresh database is created.
class StoreDamagedError extends Error {
  constructor(message, setAside) {
    super(message);
    this.name = 'StoreDamagedError';
    this.setAside = setAside;
  }
}

class IntegrityError extends Error {}
/** SQLITE_CORRUPT (11) and SQLITE_NOTADB (26), in any extended form (779 is CORRUPT_INDEX), or a failed integrity check. */
const isDamage = (e) => e instanceof IntegrityError || (typeof e?.errcode === 'number' && [11, 26].includes(e.errcode & 0xff));

const SUFFIXES = ['', '-wal', '-shm'];
const markerOf = (file) => `${file}.stopped`;

const defaultOpen = (file) => new (require('node:sqlite').DatabaseSync)(file);

/**
 * Opens (creating on first run), checks and migrates the database.
 * @param {object} o
 * @param {string} o.file
 * @param {() => number} o.now injected clock, epoch ms
 * @param {(file: string) => import('node:sqlite').DatabaseSync} [o.openDb]
 * @param {Pick<typeof import('node:fs'), 'existsSync' | 'renameSync' | 'writeFileSync' | 'readFileSync'>} o.fsOps injected: this domain requires no platform module (main passes node:fs)
 * @param {(db: any) => void} o.migrate
 * @param {(db: any) => void} o.assertKnown throws for a schema from a newer app; runs before anything changes the file
 */
function openDatabase({ file, now, openDb = defaultOpen, fsOps, migrate, assertKnown }) {
  if (fsOps.existsSync(markerOf(file))) {
    throw new StoreDamagedError(`Superagent is stopped: ${fsOps.readFileSync(markerOf(file), 'utf8')}`, null);
  }
  let db;
  try {
    db = openDb(file);
    db.exec('PRAGMA busy_timeout = 5000');
    const check = db.prepare('PRAGMA quick_check').get().quick_check;
    if (check !== 'ok') throw new IntegrityError(`integrity check failed: ${check}`);
    // a file from a newer app is refused before journal_mode (which is stored in the file) is touched
    assertKnown(db);
    db.exec('PRAGMA journal_mode = WAL');
    migrate(db);
    return db;
  } catch (e) {
    let closeNote = '';
    try {
      db?.close();
    } catch (closeError) {
      closeNote = `; closing it also failed (${closeError.message})`;
    }
    // Only corruption is damage. A locked file, a missing folder, a full disk or a newer schema leaves a healthy database where it is.
    if (!isDamage(e)) throw e;
    const setAside = `${file}.damaged-${now()}`;
    const message = `the database could not be read (${e.message}${closeNote}); it was kept as ${setAside}`;
    // the marker first: a crash between it and the renames still leaves Superagent stopped, never a fresh empty database
    fsOps.writeFileSync(markerOf(file), message, { mode: 0o600 });
    const moved = [];
    try {
      for (const sfx of SUFFIXES) {
        if (fsOps.existsSync(file + sfx)) {
          fsOps.renameSync(file + sfx, setAside + sfx);
          moved.push(sfx);
        }
      }
    } catch (renameError) {
      // all or nothing: put back what moved, and stay stopped
      for (const sfx of moved) fsOps.renameSync(setAside + sfx, file + sfx);
      fsOps.writeFileSync(
        markerOf(file),
        `the database could not be read (${e.message}) and could not be set aside (${renameError.message}); it was left in place`,
        { mode: 0o600 },
      );
      throw new StoreDamagedError(`Superagent stopped: could not set the damaged database aside (${renameError.message})`, null);
    }
    throw new StoreDamagedError(`Superagent stopped: ${message}`, setAside);
  }
}

/** A person's explicit action: lets the next open create a fresh database. The set-aside file stays on disk. */
function acknowledgeDamage(file, fsOps) {
  if (!fsOps.existsSync(markerOf(file))) return false;
  fsOps.renameSync(markerOf(file), `${markerOf(file)}.acknowledged`);
  return true;
}

module.exports = { openDatabase, acknowledgeDamage, StoreDamagedError };
