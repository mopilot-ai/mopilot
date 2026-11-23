import { readFileSync } from 'node:fs';

// The chat-storage module stand-in used by main wiring: fresh record collections, archive generations and persistence mocks.
function mainChatStoreState(load: (...args: any[]) => unknown) {
  return {
    load,
    records: new Map<string, any>(),
    newer: new Set<string>(),
    unreadable: new Set<string>(),
    archiveEpochs: new Map<string, number>(),
    archiveEpoch(this: any, id: string) {
      return this.archiveEpochs.get(id) ?? 0;
    },
  };
}

export function mainChatStoreModule(fn: (impl?: (...args: any[]) => any) => any, cls: (name: string, init?: () => any) => any) {
  return {
    toRendererSegment: fn((seg: any) => ({ nativeId: seg.nativeId })),
    ChatsStore: cls('ChatsStore', () => mainChatStoreState(fn())),
    ItemsLog: cls('ItemsLog'),
    registerChats: fn(() => ({ patchPrefs: fn(() => true) })),
    writeRendererState: fn(),
    patchPrefs: fn(),
    patchPrefsSync: fn((_file: string, set: object) => set),
    // the saved state, read from the file as the real module reads it
    peekUiState: fn((file: string) => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    }),
    dropUiState: fn(),
    setSaveFailureNotice: fn(),
  };
}
