// Bounded file and folder references of a Host chat message: the limits both ends enforce, and the parser of a message's `files`; each file rides the image upload channel as an opaque content digest, never as a path.
export const FILE_FEATURE = 'chatFiles';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_FILES = 200;
export const MAX_MESSAGE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_ATTACHMENTS = 16;
/** The one MIME type of an uploaded file: the Host keeps the bytes, and the agent reads them from the folder it is given. */
export const FILE_MIME = 'application/octet-stream';
/** The digest of no bytes: an empty file has nothing to upload. */
export const EMPTY_ID = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ID = /^[a-f0-9]{64}$/;
const SEGMENT = /^[^\\/\0]{1,255}$/;
/** A name with a line break or another control character would start a line of its own where an agent reads it (a prompt appends "@<path>"). */
export const hasControl = (s) => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const NAME = (s) => SEGMENT.test(s) && s !== '.' && s !== '..' && !hasControl(s);
const REL = (rel) => rel === '' || (rel.length <= 1024 && rel.split('/').every(NAME));

/**
 * `files` of a message: `{ id, name, rel }` where `name` is the attachment's own name (a file, or a folder) and `rel` the entry's place inside a folder ('' for a plain file).
 * @param {unknown} value @param {(m: string) => Error} bad
 */
export function fileRefs(value, bad) {
  if (value == null) return {};
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_FILES) throw bad('Attach fewer files.');
  if (!value.length) return {};
  const seen = new Set();
  const files = value.map((f) => {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !ID.test(f.id) || typeof f.name !== 'string' || !NAME(f.name))
      throw bad('That file reference is not available.');
    const rel = f.rel ?? '';
    if (typeof rel !== 'string' || !REL(rel)) throw bad('That file reference is not available.');
    const at = JSON.stringify([f.name, rel]);
    if (seen.has(at)) throw bad('That file was attached twice.');
    seen.add(at);
    return { id: f.id, name: f.name, rel };
  });
  return { files };
}
