// Durable audio submission intents survive process loss without replaying an ambiguous native prompt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePrivate } = require('./fsutil.cjs');

const UNKNOWN_AUDIO =
  'Delivery could not be confirmed; the agent may have started this audio task. Inspect the chat before sending it again.';
function createAudioDispatch(root) {
  const file = (key, id) =>
    path.join(
      root(),
      `${crypto
        .createHash('sha256')
        .update(JSON.stringify([key, id]))
        .digest('hex')}.json`,
    );
  const save = (record) => {
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    writePrivate(file(record.key, record.clientId), JSON.stringify(record), fs, { durable: true });
  };
  return {
    begin(key, clientId, display, at) {
      // A retained queue item keeps its UUID across restart; never dispatch that intent twice.
      if (fs.existsSync(file(key, clientId))) throw Object.assign(new Error(UNKNOWN_AUDIO), { deliveryUnknown: true });
      const record = { key, clientId, display, at, state: 'dispatched' };
      save(record);
      return record;
    },
    settle(record, state, error, stopReason) {
      save({ ...record, state, error, stopReason });
    },
    list(key) {
      let names;
      try {
        names = fs.readdirSync(root());
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
      return names
        .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
        .map((n) => JSON.parse(fs.readFileSync(path.join(root(), n), 'utf8')))
        .filter((r) => key === undefined || r.key === key);
    },
    remove(key) {
      for (const r of this.list(key)) fs.rmSync(file(r.key, r.clientId), { force: true });
    },
  };
}
module.exports = { createAudioDispatch, UNKNOWN_AUDIO };
