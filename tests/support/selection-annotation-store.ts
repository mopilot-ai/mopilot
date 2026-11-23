// Shared in-memory draft fixture and store boundaries for selection annotation UI tests.
import * as react from 'react';
import { mockSource } from './stubs.ts';
mockSource('src/lib/hostChats.ts', { onMachineNow: () => false });
mockSource('src/store/projects.ts', { newChatHostPick: () => null });
import type { Attachment } from '../../src/store/types.ts';

export const fixture = {
  state: { drafts: {} as Record<string, { attachments: Attachment[] }> },
  listeners: new Set<() => void>(),
  changed() {
    for (const listener of this.listeners) listener();
  },
  subscribe(listener: () => void) {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  },
  sideChats: [] as unknown[][],
  dictated: 'dictated comment',
  rects: null as DOMRect[] | null,
};

const f = fixture;
export const annotationStoreStubs = {
  getState: () => f.state,
  setDraft: (key: string, draft: { attachments: Attachment[] }) => {
    f.state.drafts[key] = draft;
    f.changed();
  },
  useStore: (s: any) => s(react.useSyncExternalStore(f.subscribe, () => f.state)),
  openSideChat: async (...a: unknown[]) => void f.sideChats.push(a),
  toastFailure: () => () => {},
};
