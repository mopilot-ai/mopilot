// "Draft a reply" on a notice (the notice lane's `notice.draft`, from the notification's own button): a tool-less model writes the words of a reply to the mail, code adds who it is to and the subject, and the result is a draft row in MoMo's chat for the owner to read, edit, copy or open in their own mail app. Nothing here can send: it has no mail send, and the row is text.
import crypto from 'node:crypto';
import { IntentError } from '../../shared/momoHomeApi.mjs';
import { readDraft } from '../../shared/momoDraft.mjs';
import { judgeSender } from '../../shared/momoNotice/senderCheck.ts';
import { draftPrompt, parseDraftBody, refuseDraft, replyAddress, replySubject } from '../../shared/momoNotice/draft.ts';
import { decisionIdOf } from '../../shared/momoNotice/views.ts';

const GONE = 'MoMo no longer has that notice.';
/** The least time between two drafts for one notice. */
export const DRAFT_COOLDOWN_MS = 2 * 60_000;
const LIVE = new Set(['open', 'offered', 'watching']);

/**
 * @param {object} o
 * @param {any} o.store the notice store
 * @param {{ rows?: { put: (row: any) => Promise<unknown> } | null }} o.home
 * @param {() => Promise<{ client: { getMail: (threadId: string) => Promise<any> } }>} o.reader
 * @param {() => import('../../shared/momoNotice/types.d.ts').ReaderModel | null} o.model
 * @param {() => Promise<boolean>} o.spend takes one reading from the day's budget; false when it is spent
 * @param {() => Promise<string>} o.email whose mail this is
 * @param {() => number} o.now
 * @param {() => string} o.randomId
 */
export function createDrafter({ store, home, reader, model, spend, email, now, randomId }) {
  /** @type {Map<string, Promise<{ id: string }>>} */
  const flying = new Map();
  /** When each notice was last drafted. @type {Map<string, number>} */
  const last = new Map();
  /** @param {string} key */
  async function write(key) {
    const matter = key.startsWith('gmail:') ? await store.notice.getMatter(key) : null;
    if (!matter || !LIVE.has(matter.state)) throw new IntentError(GONE);
    const latest = store.decisions().findLast((/** @type {any} */ d) => d.matterKey === key);
    const mail = await (await reader()).client.getMail(key.slice('gmail:'.length));
    if (!mail) throw new IntentError(GONE);
    const owner = await email();
    // the mail the draft answers is checked now: the newest message of the thread may not be the one that was judged
    const check = judgeSender(mail, store.knownDomains());
    const refused = refuseDraft(
      mail,
      matter.suspect === true || latest?.suspect != null || check.status === 'fail' || check.lookalikeOf !== undefined,
      owner,
    );
    if (refused) throw new IntentError(refused);
    if (now() - (last.get(key) ?? -Infinity) < DRAFT_COOLDOWN_MS) throw new IntentError('MoMo wrote a draft for this a moment ago.');
    const asker = model();
    if (!asker) throw new IntentError('MoMo has no reading model on this machine yet.');
    if (!(await spend())) throw new IntentError('Today’s reading budget is spent, so MoMo can’t write a draft now.');
    const to = replyAddress(mail);
    /** @type {string} */
    let text;
    try {
      text = await asker.complete(draftPrompt(mail, { name: owner.replace(/@.*/, ''), email: owner }, new Date(now()), randomId));
    } catch {
      throw new IntentError('MoMo couldn’t write a draft this time.');
    }
    let parsed;
    try {
      parsed = parseDraftBody(text);
    } catch {
      throw new IntentError('MoMo couldn’t write a draft this time.');
    }
    const read = readDraft({ to: [to], subject: replySubject(mail), body: parsed.body });
    if (!read.ok) throw new IntentError('MoMo couldn’t write a draft this time.');
    const id = `draft:${crypto
      .createHash('sha256')
      .update(`${key}|${latest ? decisionIdOf(latest) : ''}`)
      .digest('hex')
      .slice(0, 24)}`;
    last.set(key, now());
    // the words are a model's, written from a mail anyone could send: the row says so, and says when they were cut
    await home.rows?.put({
      kind: 'draft',
      id,
      draft: read.draft,
      untrusted: true,
      truncated: parsed.truncated,
      matter: { key, title: matter.title },
    });
    return { id };
  }
  return {
    /** One draft at a time per notice: a second tap while one is being written shares it. @param {unknown} key */
    draft(key) {
      if (typeof key !== 'string' || key === '') return Promise.reject(new IntentError(GONE));
      const going = flying.get(key);
      if (going) return going;
      const run = write(key).finally(() => flying.delete(key));
      flying.set(key, run);
      return run;
    },
  };
}
