// Reading the chats a prompt @ references into transcript attachments, from main's shared history (every harness).

import type { Attachment, TurnState } from '../../shared/model/store';
import type { Segment } from '../../shared/model/harness';
import { suffixUnits } from '../../shared/textPrefix.mjs';
import { sessionMentions } from './sessionMentions';

type ReferenceChat = { kind?: string; segments?: Segment[] | null };
export interface ChatReferenceDeps {
  /** The chat's whole history as main reads it from each segment's harness (switched chats included). */
  sharedTurns(id: string): Promise<{ turns: TurnState[]; earlierContentOmitted: boolean }>;
  snapshot(): Promise<{ chats: Record<string, ReferenceChat> }>;
  state(): {
    threads: Record<string, { cwd: string }>;
    segments: Record<string, Segment[]>;
    runtime: Record<string, { activeTurnId: string | null; turns: TurnState[] }>;
  };
  noteChat(id: string, chat: ReferenceChat | undefined): void;
  title(id: string): string | undefined;
  transcript(title: string, turns: TurnState[]): string;
}

/** Read reference snapshots through read-only harness boundaries. */
export async function readChatReferences(text: string, deps: ChatReferenceDeps): Promise<Attachment[]> {
  const mentions = [...new Map(sessionMentions(text).map((m) => [m.id, m])).values()];
  if (!mentions.length) return [];
  const snapshot = await deps.snapshot();
  return Promise.all(
    mentions.map(async (m) => {
      deps.noteChat(m.id, snapshot.chats[m.id]);
      const history = await deps.sharedTurns(m.id);
      let turns = history.turns;
      const omitted = history.earlierContentOmitted;
      // Live streamed items may not have reached the transcript yet.
      const runtime = deps.state().runtime[m.id];
      const live = runtime?.activeTurnId ? runtime.turns.filter((t) => t.id === runtime.activeTurnId) : [];
      const byId = new Map(live.map((t) => [t.id, t]));
      const ids = new Set(turns.map((t) => t.id));
      turns = [...turns.map((t) => byId.get(t.id) ?? t), ...live.filter((t) => !ids.has(t.id))];
      const title = deps.title(m.id) ?? m.title;
      const body = deps.transcript(title, turns);
      const limit = 32_000;
      const clipped = body.length > limit;
      return {
        kind: 'session',
        path: m.id,
        name: title,
        text: `${omitted || clipped ? '[Earlier content omitted; recent conversation follows.]\n' : ''}${clipped ? suffixUnits(body, limit) : body}`,
      };
    }),
  );
}
