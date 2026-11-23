// Bounded binary document reads validate the opened file and return either bytes or legacy Office text.
const fs = require('node:fs/promises');
const path = require('node:path');
const { isBinaryPreviewPath, previewExtension } = require('../../shared/filePreview.mjs');
const { legacyOfficeText } = require('./legacyOffice.cjs');
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

async function readPreview(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !isBinaryPreviewPath(file))
    throw new Error('Choose a supported local document.');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Choose a document file.');
    if (stat.size > MAX_PREVIEW_BYTES) throw new Error('Document is too large to preview (25 MB maximum).');
    // Read at most the admitted size plus one byte: a file growing during the read cannot bypass the limit.
    const data = Buffer.alloc(Math.min(stat.size + 1, MAX_PREVIEW_BYTES + 1));
    let length = 0;
    while (length < data.length) {
      const read = await handle.read(data, length, data.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > stat.size) throw new Error('The document changed while reading. Retry the preview.');
    const bytes = data.subarray(0, length);
    const ext = previewExtension(file);
    return ext === 'doc' || ext === 'ppt' ? { kind: 'text', text: await legacyOfficeText(bytes, ext) } : { kind: 'binary', data: bytes };
  } finally {
    await handle.close();
  }
}

module.exports = { readPreview, MAX_PREVIEW_BYTES };
