// A starter keeps the shared notes grant in its own saved configuration and, where supported, adds it to the current native process.
const { byFamily } = require('../contract/route.cjs');

/** Native runtime updates are a Claude capability; the other adapters retain the directory for future native turns. */
const RUNTIME_GRANT = { claude: (live) => live.claudeTurns.api, codex: () => null, acp: () => null };
const DEFERRED_GRANT = {
  claude: null,
  codex:
    'The shared notes directory is granted to future turns; this native process may still ask for permission when accessing it during the current turn.',
  acp: 'This harness cannot grant shared notes access automatically; accessing the saved directory may require native approval in current and future turns.',
};

function createParentNotesGrant({ live }) {
  return async (parentId, directory) => {
    const previousRecord = live.chats.records.get(parentId);
    if (!previousRecord) throw new Error('The session that requested shared notes no longer exists');
    const ref = live.controller.ref(parentId);
    const config = previousRecord.meta.config ?? {};
    const existing = Array.isArray(config.additionalDirectories) ? config.additionalDirectories : [];
    const directories = [...new Set([...existing, directory])];
    let record = previousRecord;
    if (!existing.includes(directory)) {
      // patchMeta-changes: the directory is not yet in the list, so the config changes
      if (!live.chats.patchMeta(parentId, { config: { ...config, additionalDirectories: directories } }))
        return {
          previousRecord,
          record,
          granted: false,
          degraded:
            'Shared notes are available, but this session could not save their directory grant; native file access may ask for permission.',
        };
      record = live.chats.records.get(parentId);
    }
    const result = { previousRecord, record };
    const api = byFamily(RUNTIME_GRANT, ref.kind)(live);
    if (!api)
      return {
        ...result,
        granted: false,
        degraded: byFamily(DEFERRED_GRANT, ref.kind),
      };
    if (!api.isLive(ref.key)) return { ...result, granted: true, degraded: null };
    if (live.controller.ref(parentId).key !== ref.key)
      return {
        ...result,
        granted: false,
        degraded: 'The session changed while its shared notes were prepared; its current process was not changed.',
      };
    try {
      let requested = directories;
      for (let attempt = 0; attempt < 3; attempt++) {
        await api.control(ref.key, 'addDirectories', requested);
        if (live.controller.ref(parentId).key !== ref.key)
          return {
            ...result,
            granted: false,
            degraded: 'The session changed while its shared notes were prepared; its new process uses its own saved settings.',
          };
        const latest = live.chats.records.get(parentId)?.meta?.config?.additionalDirectories;
        if (!Array.isArray(latest) || latest.every((dir) => requested.includes(dir))) return { ...result, granted: true, degraded: null };
        requested = [...new Set([...requested, ...latest])];
      }
      return {
        ...result,
        granted: false,
        degraded:
          'The session directory grants kept changing; saved settings will apply to the next turn and native access may still ask now.',
      };
    } catch {
      return {
        ...result,
        granted: false,
        degraded: 'Shared notes are saved for future turns; this native process could not add their directory and may ask for permission.',
      };
    }
  };
}

module.exports = { createParentNotesGrant };
