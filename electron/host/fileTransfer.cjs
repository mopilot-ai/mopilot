// Main's bounded channel for the files and folders of a message to a negotiated Host: measure everything against the limits first, then upload each distinct content once, by digest, on the image channel; a folder is its regular files, links and special files left out.
const nodePath = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { uploadBytes, digest } = require('./imageTransfer.cjs');
const {
  FILE_FEATURE,
  FILE_MIME,
  EMPTY_ID,
  MAX_FILE_BYTES,
  MAX_FILE_ATTACHMENTS,
  MAX_MESSAGE_FILES,
  MAX_MESSAGE_FILE_BYTES,
  hasControl,
} = require('../../shared/host/files.mjs');
/** A file this app cannot send: a refusal of the message (`app`: the queue shows its words, not blaming the machine). */
const failed = (code, message) => Object.assign(new Error(message), { code, app: true });
const MB = 1024 * 1024;
const PASS = ['stale_epoch', 'host_unreachable', 'request_retired', 'forbidden', 'directory_missing'];
/** The name as shown: a control character is spelled out, so the sentence cannot break its own line. */
const shown = (name) => JSON.stringify(name).slice(1, -1);
const badName = (name) =>
  failed('unsupported', `${shown(name)} has a line break or control character in its name. Rename it and send again.`);
const unreadable = (name) => failed('unsupported', `${name} could not be read. Attach it again.`);

/** A name no other attachment of the message has: "a.txt", "a (2).txt". @param {string} name @param {Set<string>} taken */
function uniqueName(name, taken) {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate);
  return candidate;
}

/** The regular files of a folder in a stable order, with their sizes; refuses past the limits before anything is read. */
async function walk(root, name, budget, check) {
  const found = [];
  const pending = [''];
  while (pending.length) {
    const rel = /** @type {string} */ (pending.shift());
    check();
    const entries = await fs.promises.readdir(nodePath.join(root, rel), { withFileTypes: true });
    check();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (hasControl(entry.name)) throw badName(`${name}/${at}`);
      if (entry.isDirectory()) pending.push(at);
      else if (entry.isFile()) {
        if (budget.files + 1 > MAX_MESSAGE_FILES)
          throw failed('unsupported', `${name} has more than ${MAX_MESSAGE_FILES} files. Attach a smaller folder.`);
        const stat = await fs.promises.stat(nodePath.join(root, at));
        check();
        found.push({ rel: at, size: stat.size, path: nodePath.join(root, at) });
        budget.files++;
        budget.bytes += stat.size;
        if (stat.size > MAX_FILE_BYTES)
          throw failed('unsupported', `${name}/${at} is larger than 25 MB. Remove it from the folder or send a smaller one.`);
        if (budget.bytes > MAX_MESSAGE_FILE_BYTES) throw tooBig();
      }
    }
  }
  if (!found.length) throw failed('unsupported', `${name} has no files in it. Remove it and send again.`);
  return found;
}
const tooBig = () => failed('unsupported', 'These files are larger than 50 MB together. Remove some and send again.');

/** The whole content of one file, read once; a file that changed while it was read is not the file the user attached. */
async function readWhole(path, size, name, check) {
  let file;
  let result;
  let error = /** @type {any} */ (null);
  try {
    check();
    file = await fs.promises.open(path, 'r');
    check();
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      check();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      check();
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== size) throw new Error('changed');
    result = bytes.subarray(0, offset);
  } catch (e) {
    error = PASS.includes(/** @type {any} */ (e).code) ? e : unreadable(name);
  }
  // a failed close never hides the error that ended the read, and never passes for a clean read
  try {
    await file?.close();
  } catch {
    error ??= unreadable(name);
  }
  if (error) throw error;
  return result;
}

/**
 * Uploads what a message attaches and returns the references its `chat.send` / `chat.start` carries. No bytes are read until the connection negotiated the capability.
 * @param {{ host: any, chatId: string, epoch: number, attachments: { kind: string, path: string, name?: string }[], check: () => void }} o
 * @returns {Promise<{ id: string, name: string, rel: string }[]>}
 */
async function uploadFiles({ host, chatId, epoch, attachments, check }) {
  if (!attachments.length) return [];
  check();
  if (!host.speaks?.(FILE_FEATURE) || typeof host.call !== 'function')
    throw failed('feature_missing', "This machine's Host cannot receive files yet. Update it.");
  if (attachments.length > MAX_FILE_ATTACHMENTS)
    throw failed('unsupported', `Attach up to ${MAX_FILE_ATTACHMENTS} files and folders at once. Remove some and send again.`);
  const taken = new Set();
  const budget = { files: 0, bytes: 0 };
  const plan = [];
  for (const attachment of attachments) {
    const path = attachment.path;
    // a path with no last part (the root) is not something to attach
    if (!nodePath.basename(path)) throw unreadable('That item');
    if (hasControl(nodePath.basename(path))) throw badName(nodePath.basename(path));
    const name = uniqueName(nodePath.basename(path), taken);
    let stat;
    try {
      stat = await fs.promises.stat(path);
    } catch {
      throw unreadable(name);
    }
    check();
    if (stat.isDirectory()) {
      const entries = await walk(path, name, budget, check).catch((error) => {
        throw error?.app || PASS.includes(error?.code) ? error : unreadable(name);
      });
      plan.push(...entries.map((e) => ({ ...e, name })));
    } else if (stat.isFile()) {
      if (stat.size > MAX_FILE_BYTES)
        throw failed('unsupported', `${name} is larger than ${MAX_FILE_BYTES / MB} MB. Remove it or send a smaller one.`);
      if (budget.files + 1 > MAX_MESSAGE_FILES) throw tooBig();
      budget.files++;
      budget.bytes += stat.size;
      if (budget.bytes > MAX_MESSAGE_FILE_BYTES) throw tooBig();
      plan.push({ name, rel: '', size: stat.size, path });
    } else throw unreadable(name);
  }
  const done = new Set();
  const refs = [];
  for (const item of plan) {
    if (item.size === 0) {
      refs.push({ id: EMPTY_ID, name: item.name, rel: item.rel });
      continue;
    }
    const data = await readWhole(item.path, item.size, item.name, check);
    const id = digest(data);
    if (!done.has(id)) {
      await uploadBytes({ host, chatId, epoch, data, mime: FILE_MIME, check, kind: 'file' });
      done.add(id);
    }
    refs.push({ id, name: item.name, rel: item.rel });
  }
  return refs;
}

module.exports = { uploadFiles };
