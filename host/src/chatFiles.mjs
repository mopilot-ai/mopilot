// Gives the agent the files and folders a message carries: copies the uploaded blobs into a private folder per message and chat, atomically, and hands back the paths; the caller's names never choose a location outside it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EMPTY_ID, MAX_MESSAGE_FILES, MAX_MESSAGE_FILE_BYTES } from '../../shared/host/files.mjs';
import { HostRefusal } from './hostFs.mjs';
const bad = (message) => new HostRefusal('image_unavailable', message);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exists = (file) =>
  fs.promises.lstat(file).then(
    () => true,
    () => false,
  );

/** @param {{ dir: string, blobs: { blobPaths: Function, release: Function } }} o */
export function createHostFiles({ dir, blobs }) {
  /** One attachment (a file, or a folder of files) built beside its place and renamed into it, so a crash leaves no half folder. */
  async function build(home, name, group, held, check) {
    const scratch = `${home}.part`;
    await fs.promises.rm(scratch, { recursive: true, force: true });
    await fs.promises.mkdir(scratch, { recursive: true, mode: 0o700 });
    for (const ref of group) {
      check();
      const to = path.join(scratch, name, ref.rel);
      await fs.promises.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      if (ref.id === EMPTY_ID) await fs.promises.writeFile(to, '', { mode: 0o600 });
      else await fs.promises.copyFile(held.get(ref.id).path, to, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(to, 0o600);
    }
    check();
    await fs.promises.rename(scratch, home);
  }
  let tail = Promise.resolve();
  /** One message's files, built once: a later delivery of the same message finds its folders and sends nothing again. */
  async function place(owner, chatId, key, refs, check) {
    if (refs.length > MAX_MESSAGE_FILES) throw bad('Attach fewer files.');
    const groups = new Map();
    for (const ref of refs) groups.set(ref.name, [...(groups.get(ref.name) ?? []), ref]);
    for (const [name, group] of groups)
      if (group.length > 1 && group.some((r) => r.rel === '')) throw bad(`${name} is attached as a file and a folder at once.`);
    const root = path.join(dir, hash([owner, chatId]), hash(key));
    const places = [...groups].map(([name, group], index) => ({ name, group, home: path.join(root, String(index)) }));
    const out = places.map((p) => ({ kind: /** @type {const} */ ('file'), path: path.join(p.home, p.name), name: p.name }));
    const ids = [...new Set(refs.map((r) => r.id).filter((id) => id !== EMPTY_ID))];
    if ((await Promise.all(places.map((p) => exists(p.home)))).every(Boolean)) {
      // a retry uploaded the same bytes again: they are freed too
      await blobs.release(owner, chatId, ids);
      return out;
    }
    const held = new Map((await blobs.blobPaths(owner, chatId, ids, check)).map((b) => [b.id, b]));
    let total = 0;
    for (const ref of refs) total += held.get(ref.id)?.size ?? 0;
    if (total > MAX_MESSAGE_FILE_BYTES) throw bad('The files are larger than 50 MB together. Attach fewer or smaller files.');
    for (const p of places) {
      check();
      await fs.promises.rm(p.home, { recursive: true, force: true });
      await build(p.home, p.name, p.group, held, check);
    }
    await blobs.release(owner, chatId, ids);
    return out;
  }
  return {
    /**
     * @param {string} owner @param {string} chatId @param {string} key the message's own key: a retry of it lands in the same folder
     * @param {{ id: string, name: string, rel: string }[]} refs @param {() => void} check
     * @returns {Promise<{ kind: 'file', path: string, name: string }[]>}
     */
    materialize(owner, chatId, key, refs, check = () => undefined) {
      const next = tail.then(() => place(owner, chatId, key, refs, check));
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    /** A deleted chat's copies leave the disk: every message's folder these clients made for it (a message's folders are kept where they were built until the chat is deleted). @param {string[]} owners @param {string} chatId */
    forget(owners, chatId) {
      const next = tail.then(() =>
        Promise.all(owners.map((owner) => fs.promises.rm(path.join(dir, hash([owner, chatId])), { recursive: true, force: true }))),
      );
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
