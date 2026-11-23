// Durable recorded audio assets, independent of recent dictation clips and their rolling cleanup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePrivate } = require('./fsutil.cjs');
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** Accept the bounded 16 kHz mono PCM WAV our capture path produces, never mislabeled arbitrary bytes. */
function audioDuration(bytes) {
  const b = Buffer.from(bytes);
  if (
    b.length < 46 ||
    b.length > MAX_AUDIO_BYTES ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WAVE' ||
    b.toString('ascii', 12, 16) !== 'fmt ' ||
    b.readUInt32LE(16) !== 16 ||
    b.readUInt16LE(20) !== 1 ||
    b.readUInt16LE(22) !== 1 ||
    b.readUInt32LE(24) !== 16000 ||
    b.readUInt16LE(34) !== 16 ||
    b.readUInt32LE(28) !== 32000 ||
    b.readUInt16LE(32) !== 2 ||
    b.toString('ascii', 36, 40) !== 'data' ||
    b.readUInt32LE(40) !== b.length - 44 ||
    b.readUInt32LE(4) !== b.length - 8 ||
    (b.length - 44) % 2
  )
    throw new Error('Record a non-empty audio message of at most two minutes');
  const ms = (b.length - 44) / 32;
  if (ms > 120_000) throw new Error('Audio messages are limited to two minutes');
  return ms;
}

/** Assets are immutable and retained with draft/history references; recent-recording Clear never owns this folder. */
function createAudioAssets(root) {
  const fileOf = (file) => {
    if (typeof file !== 'string' || path.dirname(file) !== root() || !/^[a-f0-9-]{36}\.wav$/.test(path.basename(file)))
      throw new Error('This audio message is not a saved recording');
    return file;
  };
  return {
    save(bytes) {
      const durationMs = audioDuration(bytes);
      fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
      const file = path.join(root(), `${crypto.randomUUID()}.wav`);
      writePrivate(file, Buffer.from(bytes));
      return { kind: 'audio', path: file, name: 'Audio message', mimeType: 'audio/wav', durationMs };
    },
    /**
     * Removes what is old enough and referenced by neither a path in `values` nor a name in `namedInHistory`.
     * @param {unknown} values @param {number} olderThan @param {string[]} [namedInHistory] file names
     */
    collect(values, olderThan, namedInHistory = []) {
      const refs = new Set();
      const named = new Set(namedInHistory);
      const visit = (v) => {
        if (typeof v === 'string') refs.add(v);
        else if (v && typeof v === 'object') Object.values(v).forEach(visit);
      };
      visit(values);
      let names;
      try {
        names = fs.readdirSync(root());
      } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      for (const name of names) {
        if (!/^[a-f0-9-]{36}\.wav$/.test(name)) continue;
        const file = path.join(root(), name);
        if (!refs.has(file) && !named.has(name) && fs.statSync(file).mtimeMs < olderThan) fs.rmSync(file);
      }
    },
    async read(file) {
      const bytes = await fs.promises.readFile(fileOf(file));
      audioDuration(bytes);
      return { type: 'audio', mimeType: 'audio/wav', data: bytes.toString('base64') };
    },
  };
}
module.exports = { createAudioAssets, audioDuration, MAX_AUDIO_BYTES };
