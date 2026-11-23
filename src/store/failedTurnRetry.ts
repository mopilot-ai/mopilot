// Explicit Retry for the latest failed turn, on every harness, preserving original input if the send is refused.
import { get, toastFailure } from './core';
import { native } from '../lib/native';
import { sendMessage, giveBackToComposer } from './send';
import { sessionOf } from './session/useSession';
import { turnBusy } from './session/sessionState';
import type { SessionState } from './session/sessionState';
import type { Attachment, ThreadItem, ThreadRuntime } from './types';
import { basename } from '../lib/paths';
import { ignoring } from '../lib/ignored';

/** Only a failed latest turn in an idle chat may be retried; historical and active work are never restarted. */
export function failedTurnForRetry(
  runtime: (Pick<ThreadRuntime, 'activeTurnId' | 'turns'> & { held?: ThreadRuntime['held'] }) | undefined,
  turnId: string,
) {
  const turn = runtime?.turns.at(-1);
  return !runtime?.activeTurnId && !runtime?.held && turn?.id === turnId && turn.status === 'failed' ? turn : null;
}

/** Retained input has its own recovery action; a failed transcript copy must never create a second owner. */
export const retrySessionReady = (session: SessionState) => !turnBusy(session) && session.queue.length === 0;

/** The message a turn started with, as text and attachments the composer sends; null when it has none. `pictures`: pictures this app has no file for any more: a machine's own reference (`host-image:`), or the data URL Claude Code's transcript keeps. */
export function messageOf(items: ThreadItem[]): { text: string; attachments: Attachment[]; pictures?: string[] } | null {
  const user = items.find((i) => i.type === 'userMessage') as { content?: unknown } | undefined;
  if (!Array.isArray(user?.content)) return null;
  const text: string[] = [];
  const attachments: Attachment[] = [];
  const pictures: string[] = [];
  for (const c of user.content as { type?: string; text?: string; path?: string; name?: string; url?: string }[]) {
    if (c?.type === 'text' && typeof c.text === 'string') text.push(c.text);
    else if (
      c?.type === 'image' &&
      typeof c.url === 'string' &&
      (c.url.startsWith('host-image:') || c.url.startsWith('data:image/')) &&
      !c.path
    )
      pictures.push(c.url);
    else if (typeof c?.path !== 'string' || !c.path) continue;
    else if (c.type === 'localAudio') attachments.push({ kind: 'audio', path: c.path, name: basename(c.path) });
    // a machine's picture still drawn from the file this app attached is that file (`image` beside its `path`)
    else if (c.type === 'localImage' || c.type === 'image') attachments.push({ kind: 'image', path: c.path, name: basename(c.path) });
    else if (c.type === 'skill') attachments.push({ kind: 'skill', path: c.path, name: c.name ?? basename(c.path) });
    else if (c.type === 'mention') attachments.push({ kind: 'file', path: c.path, name: c.name ?? basename(c.path) });
  }
  const joined = text.join('\n');
  return joined.trim() || attachments.length || pictures.length
    ? { text: joined, attachments, ...(pictures.length ? { pictures } : {}) }
    : null;
}

/** The pictures of a message on a machine, fetched back from it into files this app can send again; null (and why) when one cannot be had, so the message is never sent without it. */
async function recoverPictures(chatId: string, urls: string[]): Promise<{ files: Attachment[] } | { failed: string }> {
  const files: Attachment[] = [];
  for (const url of urls) {
    // a data URL is the picture itself; a machine's reference is read back from the machine
    let reply: { picture: string } | { gone: true } = { picture: url };
    if (!url.startsWith('data:')) {
      try {
        reply = (await native.host.picture(chatId, url)) as typeof reply;
      } catch (error) {
        ignoring('read a picture back from its machine for Retry')(error);
        reply = { gone: true };
      }
    }
    if (!('picture' in reply)) return { failed: 'a picture is not available from its machine right now' };
    let path: string | null = null;
    try {
      path = await native.fs.saveTempImage(reply.picture);
    } catch (error) {
      ignoring('save a picture for Retry')(error);
    }
    if (!path) return { failed: 'a picture could not be saved' };
    files.push({ kind: 'image', path, name: basename(path) });
  }
  return { files };
}

/** Duplicate clicks coalesce per chat while its shared send path takes the original message. */
const retrying = new Set<string>();

/** No interruption or waiting: Retry is only an explicit new send after terminal failure. */
export async function retryFailedTurn(chatId: string, turnId: string): Promise<boolean> {
  const turn = failedTurnForRetry(get().runtime[chatId], turnId);
  const session = sessionOf(chatId);
  if (!turn || !retrySessionReady(session) || retrying.has(chatId)) return false;
  const message = messageOf(turn.items);
  if (!message) return false;
  retrying.add(chatId);
  let accepted = false;
  let attachments = message.attachments;
  try {
    // pictures the machine holds come back from it: a turn read from the saved history has the machine's references, not the composer's files
    if (message.pictures) {
      const back = await recoverPictures(chatId, message.pictures);
      if ('failed' in back) {
        toastFailure("Couldn't retry")(`${back.failed}. Your message is back in the composer.`);
        return false;
      }
      attachments = [...attachments, ...back.files];
    }
    accepted = (await sendMessage(chatId, message.text, attachments, { human: true, retryAtRevision: session.rev })) !== false;
    return accepted;
  } finally {
    retrying.delete(chatId);
    // This is accepted user input, so a new turn or a different visible chat must not discard it.
    if (!accepted) giveBackToComposer(chatId, message.text, attachments);
  }
}
