// @ chat references in the renderer: reading the referenced chats' transcripts through main without opening them.

import { get as getState, threadTitle } from '../store/core';
import type { Attachment } from '../store/types';
import { native } from '../lib/native';
import { noteChat } from '../harness/ownership';
import { transcriptMarkdown } from './transcript';
import { readChatReferences } from '../lib/readChatReferences';

/** Read references without resuming, navigating to, or taking ownership of another chat; `source` is the chat they are made in. */
export function chatReferences(text: string, source: string | null = null): Promise<Attachment[]> {
  return readChatReferences(text, {
    sharedTurns: async (id) => (await native.peer.referenceHistory([id], false, source))[id],
    snapshot: () => native.chats.snapshot(),
    state: getState,
    noteChat,
    title: (id) => {
      const thread = getState().threads[id];
      return thread ? threadTitle(thread) : undefined;
    },
    transcript: (title, turns) => transcriptMarkdown(title, turns, () => 'Assistant'),
  });
}
