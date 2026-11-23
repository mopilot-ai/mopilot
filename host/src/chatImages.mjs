// Private, resumable Host image storage: immutable content digests inside exact authenticated-client/chat scopes, bounded chunks and quota, and no caller-supplied paths.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { MAX_IMAGE_BYTES, IMAGE_CHUNK_BYTES, imageIdOf, hostImageUrl, hostImageId } from '../../shared/host/images.mjs';
import { FILE_MIME } from '../../shared/host/files.mjs';
import { createHostFiles } from './chatFiles.mjs';
import { StaleEpochError } from './epochs.mjs';
import { HostRefusal } from './hostFs.mjs';
const require = createRequire(import.meta.url);
const { writeAtomicAsync } = require('../../electron/platform/fsutil.cjs');
const { syncFolderAsync } = require('../../electron/platform/folderSync.cjs');
const bad = (message) => new HostRefusal('image_unavailable', message);
/** A fault of this Host's own disk or store (not "there is no such picture"): the picture may well be there, and asking again may work. */
const fault = (message) => new HostRefusal('image_fault', message);
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp', [FILE_MIME]: 'bin' };
const finalPath = (at, meta) => `${at.image}.${EXT[meta.mime]}`;
const hash = (text) => createHash('sha256').update(text).digest('hex');

/** Read no more than the requested byte count, including filesystems that return short reads. */
async function readChunk(file, offset, limit, check) {
  const bytes = Buffer.alloc(limit);
  let read = 0;
  while (read < limit) {
    check();
    const part = await file.read(bytes, read, limit - read, offset + read);
    check();
    if (!part.bytesRead) break;
    read += part.bytesRead;
  }
  return bytes.subarray(0, read);
}

/** Syncs a folder an image was renamed into (not on Windows, which cannot: electron/platform/folderSync.cjs). */
const syncDirectory = (dir) => syncFolderAsync(dir, { fs: fs.promises });

/** @param {{ dir: string, filesDir?: string, quota?: number, entries?: number }} o */
export function createHostImages({
  dir,
  filesDir = path.join(path.dirname(dir), 'chat-files'),
  quota = 256 * 1024 * 1024,
  entries = 1024,
}) {
  let tail = Promise.resolve();
  let queued = 0;
  let used = 0;
  let count = 0;
  let ready;
  function initialize() {
    return (ready ??= (async () => {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const names = await fs.promises.readdir(dir);
      if (names.length > entries * 3) throw bad('The Host image store is full.');
      const records = new Set();
      for (const name of names) {
        const match = /^([a-f0-9]{64}-[a-f0-9]{64})\.(json|part|image\.(png|jpeg|gif|webp|bin))$/.exec(name);
        if (!match) continue;
        records.add(match[1]);
        if (match[2] === 'json') continue;
        const stat = await fs.promises.lstat(path.join(dir, name));
        if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw fault('The Host image store needs repair.');
        used += stat.size;
      }
      count = records.size;
    })());
  }
  /** A file's upload lives in its own scope of the chat, so a picture and a file with the same bytes are two records. */
  function location(owner, chatId, imageId, file = false) {
    if (typeof owner !== 'string' || !owner || typeof chatId !== 'string' || !chatId) throw bad('Pair this client before sending images.');
    imageIdOf(imageId, bad);
    const base = path.join(dir, `${hash(JSON.stringify(file ? [owner, chatId, 'file'] : [owner, chatId]))}-${imageId}`);
    return { base, meta: `${base}.json`, part: `${base}.part`, image: `${base}.image` };
  }
  async function metadata(at) {
    let file;
    let record;
    try {
      file = await fs.promises.open(at.meta, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const bytes = await readChunk(file, 0, 4097, () => undefined);
      if (bytes.length > 4096) throw fault('The image record could not be read.');
      const meta = JSON.parse(bytes.toString('utf8'));
      if (!Number.isSafeInteger(meta?.size) || meta.size < 1 || meta.size > MAX_IMAGE_BYTES || !Object.hasOwn(EXT, meta.mime))
        throw fault('The image record could not be read.');
      record = meta;
    } catch (error) {
      // a record that is not there is no record; any other fault is one refusal that names no path
      record = error?.code === 'ENOENT' ? null : undefined;
    }
    await file?.close();
    if (record === undefined) throw fault('The image record could not be read.');
    return record;
  }
  async function fileOf(at, meta) {
    for (const file of [...(meta ? [finalPath(at, meta)] : []), at.part]) {
      try {
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw fault('The image record could not be read.');
        return { file, size: stat.size, done: file !== at.part };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return null;
  }
  function serialize(act) {
    if (queued >= 64) return Promise.reject(bad('Images are still uploading. Try again.'));
    queued++;
    const next = tail.then(async () => {
      await initialize();
      return act();
    });
    tail = next.then(
      () => {
        queued--;
      },
      () => {
        queued--;
      },
    );
    return next;
  }
  const service = {
    /** One idempotent chunk; the filesystem's durable length owns progress after a lost acknowledgment or restart. */
    upload(p, check = () => undefined) {
      return serialize(async () => {
        check();
        const at = location(p.owner, p.chatId, p.imageId, p.mime === FILE_MIME);
        const bytes = Buffer.from(p.data, 'base64');
        if (!bytes.length || bytes.length > IMAGE_CHUNK_BYTES || p.offset + bytes.length > p.size || p.size > MAX_IMAGE_BYTES)
          throw bad('That image chunk is too large.');
        let meta = await metadata(at);
        check();
        if (meta && (meta.size !== p.size || meta.mime !== p.mime)) throw bad('That image reference was already used differently.');
        let held = await fileOf(at, meta);
        check();
        if (!held) {
          if (p.offset !== 0) throw bad('Start this image upload again.');
          if ((!meta && count >= entries) || used + bytes.length > quota) throw bad('The Host image store is full.');
          if (!meta) {
            meta = { size: p.size, mime: p.mime };
            await writeAtomicAsync(
              at.meta,
              JSON.stringify(meta),
              () => {
                check();
                return true;
              },
              0o600,
            );
            count++;
            const metadataFile = await fs.promises.open(at.meta, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
              await metadataFile.sync();
            } finally {
              await metadataFile.close();
            }
            await syncDirectory(dir);
          }
          check();
          const file = await fs.promises.open(at.part, 'wx', 0o600);
          await file.close();
          held = { file: at.part, size: 0, done: false };
        }
        if (!meta || held.size > p.size || p.offset > held.size) throw bad('That image upload has a missing chunk.');
        check();
        const file = await fs.promises.open(held.file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        try {
          check();
          const overlap = Math.max(0, Math.min(bytes.length, held.size - p.offset));
          if (overlap) {
            const old = await readChunk(file, p.offset, overlap, check);
            if (!old.equals(bytes.subarray(0, overlap))) throw bad('That image chunk was already uploaded differently.');
          }
          let written = overlap;
          if (written < bytes.length && (held.done || used + bytes.length - overlap > quota)) throw bad('The Host image store is full.');
          while (written < bytes.length) {
            check();
            const part = await file.write(bytes, written, bytes.length - written, p.offset + written);
            if (!part.bytesWritten) throw bad('The image chunk could not be saved.');
            written += part.bytesWritten;
            used += part.bytesWritten;
          }
          await file.sync();
          held.size = Math.max(held.size, p.offset + written);
        } finally {
          await file.close();
        }
        await syncDirectory(dir);
        check();
        if (held.size === p.size && !held.done) {
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(at.part, { highWaterMark: IMAGE_CHUNK_BYTES })) {
            check();
            digest.update(chunk);
          }
          check();
          if (digest.digest('hex') !== p.imageId) {
            await fs.promises.unlink(at.part);
            await fs.promises.unlink(at.meta);
            used -= held.size;
            count--;
            throw bad('The image checksum did not match. Upload it again.');
          }
          await fs.promises.rename(at.part, finalPath(at, meta));
          await syncDirectory(dir);
          held.done = true;
        }
        check();
        return { imageId: p.imageId, received: held.size, done: held.done };
      });
    },
    /**
     * An image chunk is served from the chat's own pictures, whichever client of the account sent them: this client's upload first, then each of `p.owners` (the other clients the Host knows),
     * all in this chat's scope; another chat's picture is never found, and no caller path is read.
     */
    async read(p, check = () => undefined) {
      await initialize();
      check();
      const complete = async (/** @type {string} */ owner, /** @type {boolean} */ own) => {
        /** @type {{ at: ReturnType<typeof location>, meta: any, held: any } | null} */
        let stored = null;
        try {
          const at = location(owner, p.chatId, p.imageId);
          const meta = await metadata(at);
          stored = { at, meta, held: await fileOf(at, meta) };
        } catch (error) {
          // another client's scope that cannot be read holds no picture for this one; this client's own fault is told
          if (own) throw error;
        }
        check();
        return stored?.meta && stored.held?.done && stored.held.size === stored.meta.size ? stored : null;
      };
      let found = await complete(p.owner, true);
      for (const owner of p.owners ?? []) if (!found && owner !== p.owner) found = await complete(owner, false);
      if (!found || p.offset > found.held.size) throw bad('That image is not available on this Host.');
      const { at, meta, held } = found;
      const file = await fs.promises.open(finalPath(at, meta), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        check();
        const bytes = await readChunk(file, p.offset, Math.min(p.limit, held.size - p.offset), check);
        check();
        return {
          imageId: p.imageId,
          size: held.size,
          mime: meta.mime,
          data: bytes.toString('base64'),
          nextOffset: p.offset + bytes.length,
          done: p.offset + bytes.length === held.size,
        };
      } finally {
        await file.close();
      }
    },
    /** Private paths are handed only to this Host's shared controller/adapters, after ownership checks. */
    async attachments(owner, chatId, ids, check = () => undefined) {
      await initialize();
      const out = [];
      for (const imageId of ids) {
        check();
        const at = location(owner, chatId, imageId);
        const meta = await metadata(at);
        const held = await fileOf(at, meta);
        check();
        if (!meta || !held?.done || held.size !== meta.size) throw bad('An image is not uploaded yet. Try again.');
        out.push({ kind: 'image', path: finalPath(at, meta), name: 'Attached image' });
      }
      return out;
    },
    /** The private paths of uploaded file blobs, in the order asked; a blob not complete yet is a refusal. */
    async blobPaths(owner, chatId, ids, check) {
      await initialize();
      const out = [];
      for (const imageId of ids) {
        check();
        const at = location(owner, chatId, imageId, true);
        const meta = await metadata(at);
        const held = await fileOf(at, meta);
        check();
        if (!meta || !held?.done || held.size !== meta.size) throw bad('A file is not uploaded yet. Try again.');
        out.push({ id: imageId, path: finalPath(at, meta), size: held.size });
      }
      return out;
    },
    /** Frees uploaded file blobs once the message that carries them has its own copies. */
    release(owner, chatId, ids) {
      return serialize(async () => {
        for (const imageId of ids) {
          const at = location(owner, chatId, imageId, true);
          const held = await fileOf(at, await metadata(at));
          // an earlier delivery of the same message already freed it
          if (!held) continue;
          await fs.promises.rm(held.file, { force: true });
          await fs.promises.rm(at.meta, { force: true });
          used -= held.size;
          count--;
        }
      });
    },
    /** A deleted chat's uploads leave the disk: what these clients stored for it, whole or half sent, and the copies of its files made for the agent. @param {string} chatId @param {string[]} owners */
    forgetChat(chatId, owners) {
      return serialize(async () => {
        const scopes = owners.flatMap((owner) => [hash(JSON.stringify([owner, chatId])), hash(JSON.stringify([owner, chatId, 'file']))]);
        const bases = new Set();
        for (const name of await fs.promises.readdir(dir)) {
          const match = /^([a-f0-9]{64})-[a-f0-9]{64}\.(json|part|image\.(?:png|jpeg|gif|webp|bin))$/.exec(name);
          if (!match || !scopes.includes(match[1])) continue;
          const size = match[2] === 'json' ? 0 : (await fs.promises.lstat(path.join(dir, name))).size;
          await fs.promises.rm(path.join(dir, name), { force: true });
          used -= size;
          bases.add(name.slice(0, 129));
        }
        count -= bases.size;
        await files.forget(owners, chatId);
      });
    },
    /** A Host's raw display path is replaced before any turn start reaches a client. */
    project(user) {
      if (!Array.isArray(user?.content)) return user;
      return {
        ...user,
        content: user.content.map((part) => {
          if (part?.type === 'image') return hostImageId(part.url) ? { type: 'image', url: part.url } : { type: 'image' };
          if (part?.type !== 'localImage') return part;
          const name = typeof part.path === 'string' && path.dirname(part.path) === dir ? path.basename(part.path) : '';
          const match = /^[a-f0-9]{64}-([a-f0-9]{64})\.image\.(?:png|jpeg|gif|webp)$/.exec(name);
          return match ? { type: 'image', url: hostImageUrl(match[1]) } : { type: 'image' };
        }),
      };
    },
  };
  const safe = async (act) => {
    try {
      return await act();
    } catch (error) {
      if (error instanceof HostRefusal || error instanceof StaleEpochError) throw error;
      throw fault('The image could not be read or saved. Try again.');
    }
  };
  const files = createHostFiles({ dir: filesDir, blobs: service });
  return {
    project: service.project,
    files: (owner, chatId, key, refs, check) => safe(() => files.materialize(owner, chatId, key, refs, check)),
    forgetChat: service.forgetChat,
    upload: (p, check) => safe(() => service.upload(p, check)),
    read: (p, check) => safe(() => service.read(p, check)),
    attachments: (owner, chatId, ids, check) => safe(() => service.attachments(owner, chatId, ids, check)),
  };
}
