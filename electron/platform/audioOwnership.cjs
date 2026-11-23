// Window-owned durable audio drafts recover as editable input; collection follows every live, persisted and pending reference.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePrivate, readStoreFile } = require('./fsutil.cjs');
const { labeled } = require('../perf/stalls.cjs');

/** Recovery combines unsent input for review, never tasks or native dispatches. */
function combined(drafts) {
  const texts = [...new Set(drafts.map((d) => d.text).filter(Boolean))];
  const attachments = new Map();
  for (const d of drafts) for (const a of d.attachments) attachments.set(JSON.stringify(a), a);
  return { text: texts.join('\n\n'), attachments: [...attachments.values()], ...(drafts.some((d) => d.goal) ? { goal: true } : {}) };
}

function createAudioOwnership(root, assets, host, sessions, now = Date.now) {
  const file = path.join(root(), 'audio-drafts.json');
  const { data, error: readError } = readStoreFile(file, 'audio drafts');
  const error =
    readError ?? (data?.version != null && data.version !== 1 ? new Error('Audio drafts need a newer version of MoPilot') : null);
  const session = crypto.randomUUID();
  let fragments = Array.isArray(data?.fragments)
    ? data.fragments
    : Object.entries(data ?? {}).map(([key, draft]) => ({ id: crypto.randomUUID(), key, draft, session: null, sender: null }));
  const closed = new Set();
  const unsaved = new Map();
  let revision = 0;
  const save = (next) => {
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    writePrivate(file, JSON.stringify({ version: 1, fragments: next }), fs, { durable: true });
    fragments = next;
    revision++;
  };
  const all = () => [...new Map([...fragments, ...unsaved.values()].map((r) => [r.id, r])).values()];
  return {
    /** @param {number | string} [sender] */
    drafts(sender = 0) {
      if (error) throw error;
      for (const id of closed) host.audioPending?.close(id);
      const eligible = all().filter((r) => r.session !== session || r.sender === sender || closed.has(r.sender));
      const recovered = host.audioPending?.recovered?.(sender) ?? [];
      const groups = new Map();
      for (const r of [...eligible, ...recovered]) groups.set(r.key, [...(groups.get(r.key) ?? []), r.draft]);
      const claimed = [...groups].map(([key, drafts]) => ({ id: crypto.randomUUID(), key, draft: combined(drafts), session, sender }));
      if (claimed.length) {
        const ids = new Set(eligible.map((r) => r.id));
        save([...fragments.filter((r) => !ids.has(r.id)), ...claimed]);
        for (const id of ids) unsaved.delete(id);
        host.audioPending?.consumeRecovered?.(recovered.map((r) => r.id));
      }
      return Object.fromEntries(claimed.map((r) => [r.key, r.draft]));
    },
    /** @param {number | string} [sender] */
    set(key, draft, sender = 0) {
      if (error) throw error;
      if (typeof key !== 'string' || !key || !draft || !Array.isArray(draft.attachments)) throw new Error('Invalid audio draft');
      const previous = all().find((r) => r.session === session && r.sender === sender && r.key === key);
      const record = { id: previous?.id ?? crypto.randomUUID(), key, draft: structuredClone(draft), session, sender };
      const next = fragments.filter((r) => r.id !== record.id);
      if (draft.attachments.some((a) => a.kind === 'audio')) next.push(record);
      try {
        save(next);
        unsaved.delete(record.id);
      } catch (cause) {
        unsaved.set(record.id, record);
        revision++;
        throw cause;
      }
    },
    close(sender) {
      closed.add(sender);
      revision++;
    },
    async collect() {
      if (error) throw error;
      host.audioPending?.prune();
      const before = revision;
      const journal = host.audioDispatch.list();
      const pending = host.audioPending?.list() ?? [];
      const stamp = JSON.stringify([journal, pending]);
      const inHistory = await host.items.audioRefs((await host.items.listAsync()).map(({ id }) => id));
      if (before !== revision || stamp !== JSON.stringify([host.audioDispatch.list(), host.audioPending?.list() ?? []])) return;
      labeled('audio.collect', () =>
        assets.collect(
          [fragments, [...unsaved.values()], journal, pending, [...sessions.all()].map((id) => sessions.get(id).queue)],
          now() - 3_600_000,
          inHistory,
        ),
      );
    },
    delete(key, nativeKeys) {
      if (error) throw error;
      host.audioPending?.delete(key);
      for (const id of nativeKeys) host.audioDispatch.remove(id);
      save(fragments.filter((r) => r.key !== key));
      for (const [id, r] of unsaved) if (r.key === key) unsaved.delete(id);
    },
  };
}
module.exports = { createAudioOwnership };
