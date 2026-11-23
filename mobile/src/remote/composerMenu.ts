// The composer's / and @ menus of an open chat: what the computer lists for them, the rows that match what is typed, and the text a pick leaves (the app's composer rules, src/lib/composerSkills.ts).
import { type ComposerPopup, composerPopup } from '../../../src/lib/composerSkills';
import { sessionToken } from '../../../shared/sessionMentions.mjs';
import { type Owned, bad, capabilities, list, rec, str } from './client';

/** One row of the / menu; `as` says how a message takes it: its /name in the text, or a skill carried beside the text. */
export type Command = { name: string; description: string; hint: string; skill: boolean; as: 'text' | 'skill' };
/** One row of the @ menu: another chat, or a file or folder of this chat's project. */
export type Mention = { kind: 'chat'; id: string; title: string } | { kind: 'file'; path: string; name: string; directory: boolean };
/** How many rows the / menu shows at once. */
export const MAX_COMMANDS = 8;

/** Whose menus these are: an open chat (its id), or a chat about to start with this agent in this saved project. */
export type MenuScope = string | { harness: string; projectId: string | null };
const scopeParams = (scope: MenuScope) =>
  typeof scope === 'string' ? { chatId: scope } : { harness: scope.harness, projectId: scope.projectId };

/** The / commands and skills of a chat's harness, or of the harness a new chat starts with. */
export async function loadCommands(request: Owned, scope: MenuScope): Promise<Command[]> {
  const reply = rec(await request('commands.list', scopeParams(scope)));
  if (!reply || !Array.isArray(reply.commands)) return bad('the commands');
  return list(reply.commands).flatMap((raw) => {
    const c = rec(raw);
    const name = str(c?.name);
    return c && name
      ? [
          {
            name,
            description: str(c.description) ?? '',
            hint: str(c.hint) ?? '',
            skill: c.kind === 'skill',
            as: c.as === 'skill' ? ('skill' as const) : ('text' as const),
          },
        ]
      : [];
  });
}

/** The chats and files that match what is typed after an @. */
export async function loadMentions(request: Owned, scope: MenuScope, query: string): Promise<Mention[]> {
  const reply = rec(await request(typeof scope === 'string' ? 'mentions.list' : 'mentions.start', { ...scopeParams(scope), query }));
  if (!reply || !Array.isArray(reply.chats) || !Array.isArray(reply.files)) return bad('the mentions');
  const chats = list(reply.chats).flatMap((raw): Mention[] => {
    const c = rec(raw);
    const id = str(c?.id);
    const title = str(c?.title);
    return id && title ? [{ kind: 'chat', id, title }] : [];
  });
  const files = list(reply.files).flatMap((raw): Mention[] => {
    const f = rec(raw);
    const path = str(f?.path);
    return path ? [{ kind: 'file', path, name: str(f?.name) ?? path, directory: f?.directory === true }] : [];
  });
  return [...chats, ...files];
}

/**
 * Which menus this computer has: a menu it lacks is absent, not faked. One that did not say what it offers (or does not answer) is tried,
 * and shows the error if it fails.
 */
export async function menusOffered(request: Owned, scope: MenuScope = ''): Promise<{ commands: boolean; mentions: boolean }> {
  const { methods } = await capabilities(request).catch(() => ({ methods: null }));
  if (typeof scope === 'string')
    return { commands: !methods || methods.has('commands.list'), mentions: !methods || methods.has('mentions.list') };
  // before a chat exists both menus need `mentions.start`: a Mac without it lists commands only for an open chat
  const has = !!methods && methods.has('mentions.start') && methods.has('commands.list');
  return { commands: has, mentions: has };
}

/** The commands that start with what is typed, then those that hold it; after a space, or for a $, only skills. */
export function matchCommands(commands: Command[], popup: ComposerPopup): Command[] {
  const q = popup.query.toLowerCase();
  const pool = popup.skillsOnly ? commands.filter((c) => c.skill) : commands;
  const starts = pool.filter((c) => c.name.toLowerCase().startsWith(q));
  const holds = pool.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...holds].slice(0, MAX_COMMANDS);
}

/** A mention token already in the text stands for its title, so an @ inside it is not a new one. */
const TOKEN = /\[(?:\\.|[^\]\\\n])*\]\(session:\/\/[^\s)]*\)/g;

/** The menu the caret opens, if any; `applied` are the file mentions a pick wrote, which do not open it again. */
export function popupAt(text: string, caret: number, applied: readonly string[]): ComposerPopup | null {
  return composerPopup(
    text.replace(TOKEN, (token) => '_'.repeat(token.length)),
    Math.min(caret, text.length),
    applied,
  );
}

/** The text and caret a pick leaves: the typed `/query` or `@query` replaced by the pick and one space after it (a space that already follows is that one). */
function put(text: string, popup: ComposerPopup, caret: number, token: string) {
  const before = text.slice(0, popup.start);
  const after = text.slice(Math.min(caret, text.length));
  const spaced = token && `${token} `;
  const rest = token && after.startsWith(' ') ? after.slice(1) : after;
  return { text: before + spaced + rest, caret: before.length + spaced.length };
}

/** A command picked: `/name ` in the text, or for a skill carried beside the text, the typed `/query` gone and the skill named. */
export function pickCommand(text: string, popup: ComposerPopup, caret: number, command: Command) {
  if (command.as === 'skill') return { ...put(text, popup, caret, ''), skill: command.name };
  return { ...put(text, popup, caret, `/${command.name}`), skill: null };
}

/** A chat or file picked: the app's token for it (a chat's link, `@path` for a file), and for a file what to remember so it does not reopen the menu. */
export function pickMention(text: string, popup: ComposerPopup, caret: number, mention: Mention) {
  if (mention.kind === 'chat') return { ...put(text, popup, caret, sessionToken(mention.id, mention.title)), applied: null };
  const token = `@${mention.path}${mention.directory ? '/' : ''} `;
  return { ...put(text, popup, caret, token.trimEnd()), applied: token };
}
