// Durable copies of the pictures a chat sent (#5183): a pasted, sketched or annotated picture lives in the temp folder (fs:saveTempImage), which is pruned after a day, so it is copied into <userData>/chat-pictures/<chat> when its message is sent and every adapter and journal records that path; the folder goes with the chat.
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { fs } = require('./ports/fs.cjs');
const { mkdirPrivate } = require('./privateFiles.cjs');
const { writePrivate } = require('./fsutil.cjs');
const { ignoring, noteIgnored } = require('../ignored.cjs');

/** Chats forked from this folder's chat, by native id: their history names these pictures by path, so the folder stays while one lives. */
const FORKS = '.forks';
/** Marks a folder whose chat was deleted but which a fork still needs. */
const GONE = '.deleted';

const sha = (/** @type {string | Buffer} */ data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * @param {object} o
 * @param {() => string} o.root where the folders go (the app's data folder, chat-pictures)
 * @param {() => string} [o.tmp] the folder the picture paths of a paste, sketch or annotation are in
 */
function createChatPictures({ root, tmp = () => path.join(os.tmpdir(), 'sage-codex-attachments') }) {
  const folderOf = (/** @type {string} */ chatId) => path.join(root(), sha(String(chatId)).slice(0, 32));
  /** Whether the attachment is a picture the temp folder holds. */
  const temporary = (/** @type {any} */ a) => {
    if (a?.kind !== 'image' || typeof a.path !== 'string') return false;
    const rel = path.relative(tmp(), path.resolve(a.path));
    // outside when it climbs out, or on another drive (an absolute answer)
    return !!rel && !/^(\.\.|[A-Za-z]:|[\\/])/.test(rel);
  };
  const exists = (/** @type {string} */ file) =>
    fs.promises.access(file).then(
      () => true,
      () => false,
    );
  /** The folders there are (none when the root is not made yet). */
  const names = async () => {
    try {
      return await fs.promises.readdir(root());
    } catch (error) {
      if (/** @type {any} */ (error).code !== 'ENOENT') throw error;
      return [];
    }
  };
  const forksOf = async (/** @type {string} */ dir) => {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(dir, FORKS), 'utf8'));
    } catch {
      return [];
    }
  };
  /** Work on one key at a time, in the order asked: a chat's copies and its removal, and the fork lists. */
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();
  const chain = (/** @type {string} */ key, /** @type {() => Promise<any>} */ work) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(work);
    const tail = run.then(undefined, ignoring('order the chat pictures work'));
    tails.set(key, tail);
    void tail.then(() => tails.get(key) === tail && tails.delete(key));
    return run;
  };

  /** The attachment with a path that stays; the original when it can't be copied, which never stops the message. */
  async function copy(/** @type {string} */ chatId, /** @type {any} */ a) {
    try {
      if (!(await fs.promises.lstat(a.path)).isFile()) return a;
      const bytes = await fs.promises.readFile(a.path);
      // the file keeps its name, which the harness shows, in a folder of its content's digest (the same bytes are kept once)
      const file = path.join(folderOf(chatId), sha(bytes), path.basename(a.path));
      if (await exists(file)) return { ...a, path: file };
      mkdirPrivate(path.dirname(file));
      writePrivate(file, bytes);
      return { ...a, path: file };
    } catch (error) {
      noteIgnored('keep a sent picture', error);
      return a;
    }
  }

  return {
    /** Whether a message's attachments have a picture to keep. */
    wants: (/** @type {any[] | undefined} */ attachments) => !!attachments?.some(temporary),
    /** The attachments, the temp folder's pictures replaced by their durable copy. */
    keep: (/** @type {string} */ chatId, /** @type {any[]} */ attachments) =>
      chain(`chat:${chatId}`, () => Promise.all(attachments.map((a) => (temporary(a) ? copy(chatId, a) : a)))),
    /**
     * A fork (its native id) of a chat shares the pictures its history names: the chat's folder, and the folder of any chat
     * that `ids` (the parent's ids) are themselves forks of. They stay until the fork is deleted too.
     */
    share: (/** @type {string} */ chatId, /** @type {string} */ fork, /** @type {string[]} */ ids = [chatId]) =>
      chain('forks', async () => {
        for (const name of await names()) {
          const dir = path.join(root(), name);
          const forks = await forksOf(dir);
          if ((dir === folderOf(chatId) || forks.some((/** @type {string} */ id) => ids.includes(id))) && !forks.includes(fork))
            writePrivate(path.join(dir, FORKS), JSON.stringify([...forks, fork]));
        }
      }),
    /**
     * The chat was deleted: its folder goes, unless a fork lives (it goes with the last one); the folders this chat's
     * ids were a fork of lose it. `ids`: the chat's native ids. It waits for the chat's own copies in flight.
     */
    remove: (/** @type {string} */ chatId, /** @type {string[]} */ ids = [chatId]) =>
      chain(`chat:${chatId}`, () =>
        chain('forks', async () => {
          const mine = folderOf(chatId);
          for (const name of await names()) {
            const dir = path.join(root(), name);
            const forks = await forksOf(dir);
            const left = forks.filter((/** @type {string} */ id) => !ids.includes(id));
            if (left.length !== forks.length) writePrivate(path.join(dir, FORKS), JSON.stringify(left));
            if (left.length && dir === mine) writePrivate(path.join(dir, GONE), '');
            else if (!left.length && (dir === mine || (await exists(path.join(dir, GONE)))))
              await fs.promises.rm(dir, { recursive: true, force: true });
          }
        }),
      ),
  };
}

module.exports = { createChatPictures };
