// Prepare chat-owned native sessions for the first message and bind Claude side chats to a separate native UUID.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { sideChatUuid } from '../../shared/host/sideChats.mjs';
import { UnsupportedError } from './errors.mjs';
import { isBoundSideFork } from './nativeSideChat.mjs';

const require = createRequire(import.meta.url);
const { segment } = require('../../electron/platform/chatRecord.cjs');
const { ignoring } = require('../../electron/ignored.cjs');

/** @typedef {import('./nativeSideChat.mjs').SideChatSource} SideChatSource */
/** @typedef {{
 *   turnApi: { hasTranscript: (id: string) => Promise<boolean> },
 *   forkLinkedSession: (id: string, cwd: string, options: { check: () => void, validate: (id: string) => void }) => Promise<{ sessionId: string }>,
 *   deleteSession: (id: string) => Promise<unknown>,
 * }} ClaudeForks */
/** @param {{ chats: InstanceType<typeof import('../../electron/platform/chats.cjs').ChatsStore>, controller: { invalidate: () => void, ref: (id: string) => { key: string } },
 *   claudeFamily?: { claude?: ClaudeForks, prepare?: (id: string, cwd?: string, check?: () => void) => Promise<void> },
 *   codexFamily?: { check?: (id: string) => Promise<void>, prepare?: (p: { chatId: string, cwd?: string, check: () => void, source?: SideChatSource }) => Promise<void | boolean> } }} o */
export function createChatPreparation({ chats, controller, claudeFamily, codexFamily }) {
  return async (
    /** @type {{ chatId: string, harness: string, cwd?: string, check?: () => void, source?: SideChatSource }} */ {
      chatId,
      harness,
      cwd,
      check = () => undefined,
      source,
    },
  ) => {
    check();
    if (harness === 'claude' && claudeFamily?.prepare) {
      if (!sideChatUuid(chatId)) return claudeFamily.prepare(chatId, cwd, check);
      // Claude's native id is allocated here. A client-owned chat id must never select a native session.
      const record = chats.record(chatId);
      let forked = isBoundSideFork(record, source);
      if (sideChatUuid(record.segments[0].nativeId)) {
        const claude = claudeFamily.claude;
        const available = (id) => !chats.names(`claude:${id}`);
        const validate = (id) => {
          if (!available(id)) throw new UnsupportedError('Claude Code did not return a separate side chat.');
        };
        const fork =
          source && cwd && claude && (await claude.turnApi.hasTranscript(source.id))
            ? await claude.forkLinkedSession(source.id, cwd, { check, validate })
            : undefined;
        try {
          check();
          const nativeId = fork?.sessionId ?? randomUUID();
          if (fork) validate(nativeId);
          const latest = chats.record(chatId);
          const meta = fork && source ? { ...latest.meta, nativeSideFork: source.binding } : latest.meta;
          if (!chats.commit({ ...latest, meta, segments: [segment({ kind: harness, nativeId })] }))
            throw new Error('Could not record the side chat.');
        } catch (error) {
          if (fork && available(fork.sessionId))
            await claude?.deleteSession(fork.sessionId).catch(ignoring('delete an unrecorded Host Claude fork'));
          throw error;
        }
        forked = Boolean(fork);
        controller.invalidate();
      }
      await claudeFamily.prepare(controller.ref(chatId).key, cwd, check);
      return forked;
    }
    if (harness !== 'codex' || !codexFamily?.prepare) throw new UnsupportedError('This host cannot run that harness yet.');
    await codexFamily.check?.(chatId);
    check();
    const forked = await codexFamily.prepare({ chatId, cwd, check, ...(source ? { source } : {}) });
    check();
    return forked;
  };
}
