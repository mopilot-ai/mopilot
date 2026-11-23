// The instruction files /init looks for in a chat's folder (AGENTS.md, CLAUDE.md): read on this Mac for a chat here, and on the chat's machine through the Host's read-only `fs.read` for a chat there. Nothing is written by either: the command's own agent writes the file.
import { native } from './native';

/** What /init asks of a folder. */
export interface InitFolder {
  /** whether the file is there */
  exists(file: string): Promise<boolean>;
  /** the file's text, or null when it is not there */
  text(file: string): Promise<string | null>;
  /** the file's path in this folder */
  path(file: string): string;
}

const join = (cwd: string, file: string) => `${cwd.replace(/\/+$/, '')}/${file}`;

/** The folder of a chat on this Mac. */
export function localInitFolder(cwd: string): InitFolder {
  const path = (file: string) => join(cwd, file);
  return { exists: (file) => native.fs.exists(path(file)), text: (file) => native.fs.readText(path(file)), path };
}

/** The Host's words for "there is no such file" (a path that does not exist, or one that is not a file); any other refusal is a read that did not work. */
const ABSENT = new Set(['directory_missing', 'not_a_file']);
/** How much of a file is read: enough to tell whether it holds the pointer line. */
const READ_LIMIT = 64 * 1024;

/** The folder of a chat on the machine `hostId`, read there and never written. A read that fails for any other reason than the file being absent rejects, so /init never plans from a guess. */
export function machineInitFolder(hostId: string, cwd: string): InitFolder {
  const path = (file: string) => join(cwd, file);
  const text = async (file: string) => {
    const r = await native.host.fsRead(hostId, { path: path(file), limit: READ_LIMIT });
    if (r.error) {
      if (r.error.code && ABSENT.has(r.error.code)) return null;
      throw new Error(r.error.message);
    }
    // a file that is not text is there, with nothing to read
    return r.value.kind === 'text' ? r.value.text : '';
  };
  return { text, exists: async (file) => (await text(file)) !== null, path };
}
