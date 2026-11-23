// Durable audio ownership before chat creation, while queued, and until the native dispatch journal takes over.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePrivate, readStoreFile } = require('./fsutil.cjs');

function createAudioPending(root, now = Date.now, current = (_record, _chatId) => true) {
  const file = path.join(root(), 'audio-pending.json');
  const { data, error: readError } = readStoreFile(file, 'pending audio messages');
  const error =
    readError ?? (data?.version != null && data.version !== 1 ? new Error('Pending audio needs a newer version of MoPilot') : null);
  let records = data?.version === 1 ? data.records : (data ?? {});
  const save = (next) => {
    if (error) throw error;
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    writePrivate(file, JSON.stringify({ version: 1, records: next }), fs, { durable: true });
    records = next;
  };
  return {
    list() {
      if (error) throw error;
      return Object.values(records).filter((r) => typeof r.releasedAt !== 'number' || r.releasedAt > now() - 3_600_000);
    },
    /** @param {any} [claim] Main snapshot of the unsubmitted recipient and configuration. @param {number | string | null} [sender] */
    hold(key, draft, claim = null, sender = null) {
      if (typeof key !== 'string' || !draft?.attachments?.some((a) => a.kind === 'audio')) throw new Error('No audio draft to transfer');
      const id = crypto.randomUUID();
      save({ ...records, [id]: { id, key, draft, claim, sender, phase: 'prepared' } });
      return id;
    },
    admit(chatId, item) {
      if (!item.attachments.some((a) => a.kind === 'audio')) return;
      const old = Object.values(records).find((r) => r.item?.id === item.id);
      if (old) {
        if (old.phase !== 'queued') save({ ...records, [old.id]: { ...old, phase: 'queued', releasedAt: undefined } });
        return;
      }
      const id = item.opts.audioTransfer ?? item.id;
      const prepared = records[id];
      if (prepared && !current(prepared, chatId))
        throw new Error('The audio message account, model or recipient changed. Review the draft before sending.');
      if (item.opts.audioTransfer && (!prepared || prepared.phase !== 'prepared')) throw new Error('Audio submission ownership expired');
      save({
        ...records,
        [id]: {
          id,
          key: prepared?.key ?? chatId,
          draft: prepared?.draft ?? { text: item.text, attachments: item.attachments },
          phase: 'queued',
          chatId,
          item,
        },
      });
    },
    finishTransfer(id, preserve = false) {
      const record = records[id];
      if (record?.phase === 'prepared')
        save({ ...records, [id]: { ...record, phase: preserve ? 'recovered' : 'released', ...(preserve ? {} : { releasedAt: now() }) } });
    },
    remove(itemId) {
      const r = Object.values(records).find((v) => v.item?.id === itemId);
      if (r) save({ ...records, [r.id]: { ...r, phase: 'released', releasedAt: now() } });
    },
    dispatched(itemId) {
      const next = { ...records };
      for (const r of Object.values(next)) if (r.item?.id === itemId) delete next[r.id];
      save(next);
    },
    recover(controller, journal) {
      for (const r of this.list()) {
        if (r.phase === 'prepared' || r.phase === 'recovered') {
          save({ ...records, [r.id]: { ...r, phase: 'recovered', sender: null } });
          continue;
        }
        if (r.phase !== 'queued') continue;
        if (journal.list().some((j) => j.clientId === r.item.id)) {
          this.dispatched(r.item.id);
          continue;
        }
        const state = controller.state.get(r.chatId);
        if (!state.queue.some((q) => q.id === r.item.id))
          controller.state.patch(r.chatId, { queue: [...state.queue, { ...r.item, waitingFor: 'audioRecovery' }] });
      }
    },
    recovered(sender) {
      return this.list().filter((r) => r.phase === 'recovered' && (r.sender == null || r.sender === sender));
    },
    consumeRecovered(ids) {
      const next = { ...records };
      for (const id of ids) if (next[id]?.phase === 'recovered') next[id] = { ...next[id], phase: 'released', releasedAt: now() };
      save(next);
    },
    close(sender) {
      const next = { ...records };
      let changed = false;
      for (const r of Object.values(next))
        if ((r.phase === 'prepared' || r.phase === 'recovered') && r.sender === sender) {
          next[r.id] = { ...r, phase: 'recovered', sender: null };
          changed = true;
        }
      if (changed) {
        try {
          save(next);
        } finally {
          // Logical retirement cannot depend on disk availability. The old file still retains the media for restart recovery.
          records = next;
        }
      }
    },
    prune() {
      const next = Object.fromEntries(
        Object.entries(records).filter(([, r]) => typeof r.releasedAt !== 'number' || r.releasedAt > now() - 3_600_000),
      );
      if (Object.keys(next).length !== Object.keys(records).length) save(next);
    },
    delete(chatId) {
      const next = Object.fromEntries(Object.entries(records).filter(([, r]) => r.chatId !== chatId && r.key !== chatId));
      save(next);
    },
  };
}
module.exports = { createAudioPending };
