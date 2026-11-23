// In-memory reference implementations of the notice store and the version store: the behaviour a Host's persistent store must match, used by the tests and the evaluation runner.
import type { Matter, NoticeStore, VersionStore } from './types.d.ts';

export function createMemoryVersionStore(): VersionStore {
  const versions = new Map<string, string>();
  return {
    get: async (key) => versions.get(key),
    set: async (key, version) => void versions.set(key, version),
  };
}

export function createMemoryNoticeStore(): NoticeStore {
  const matters = new Map<string, Matter>();
  const told = new Map<string, Set<string>>();
  let anonymous = 0;
  const briefs = new Set<string>();
  return {
    getMatter: async (key) => matters.get(key),
    putMatter: async (matter) => void matters.set(matter.matterKey, structuredClone(matter)),
    listMatters: async () => [...matters.values()].map((matter) => structuredClone(matter)),
    tryCountTold: async (dayKey, cap, key) => {
      const keys = told.get(dayKey) ?? new Set<string>();
      told.set(dayKey, keys);
      // the same key counts once: a retried push is not a second delivery
      if (key !== undefined && keys.has(key)) return true;
      if (keys.size >= cap) return false;
      keys.add(key ?? `anonymous:${(anonymous += 1)}`);
      return true;
    },
    releaseBrief: async (dayKey) => void briefs.delete(dayKey),
    claimBrief: async (dayKey) => {
      if (briefs.has(dayKey)) return false;
      briefs.add(dayKey);
      return true;
    },
  };
}
