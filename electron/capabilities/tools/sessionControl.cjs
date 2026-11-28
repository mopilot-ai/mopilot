// The write side of session management, for a chat on any harness: unarchive_session, set_session_title, clear_session,
// delete_session, detach_session, set_session_model, set_session_harness, set_session_effort, set_session_fast_mode,
// set_session_output_style and set_session_permission_mode (Claude Desktop's ccd_session_mgmt tools). A tool acts on the calling session or on a
// session this chat started, never on another chat, and a setting that costs more or lets a session do more than the
// caller is never raised from here. What each harness can apply comes from the session host (app/sessionHost.cjs); one
// that cannot is reported unavailable, never silently ignored.
const { ToolError } = require('../contract/registry.cjs');
const { appPermission } = require('../../../shared/permissionMenu.mjs');
const { stateWord, nameOf } = require('../../session/orchestration/family.cjs');
const { cheaperModel, mentions, namesEffort, namesHarness, namesModel } = require('../../session/userWords.cjs');
const { EFFORTS, PERMISSIONS } = require('../../session/orchestration/childSetup.cjs');
const { createKit } = require('./sessionKit.cjs');

const MAX_DELETE = 25;
const NEEDS_USER = 'ask the user to change it from the model menu';
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;
const quote = (s) => JSON.stringify(String(s));
/**
 * Whether the user's words ask for Auto model routing: "auto" as a word of its own ("auto-fix", "auto merge", the "auto"
 * permission mode are other things) beside a model, harness or routing word ("put it on auto model", "auto harness").
 * @param {string} text
 */
const asksForAuto = (text) =>
  /(?<![\w-])auto(?![\w-])(?!\s+(?:merge|fix|review|approve|accept|archive|mode|permission)\b)/i.test(text) &&
  /\b(?:models?|harness(?:es)?|rout(?:e|es|ing|er)|picks?)\b/i.test(text);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * @param {any} registry
 * @param {{ orchestrator: any, owner: (ctx: any) => string | null, host: any }} o
 * @returns {() => void} removes the tools
 */
function registerSessionControlTools(registry, { orchestrator = {}, owner, host }) {
  const { add, target, string } = createKit(registry, { orchestrator, owner });
  const { journal } = orchestrator;
  const controller = () => orchestrator.o.controller;

  const label = (id, title) => {
    const t = title ?? journal.child(id)?.title;
    return `${nameOf(journal, id)}${t ? ` (${quote(t)})` : ''}`;
  };
  const working = (id) => ['working', 'needs the user'].includes(stateWord(controller(), journal, id));
  const noArchived = (id, what) => {
    if (orchestrator.archived(id)) throw new ToolError(`Session ${label(id)} is archived - unarchive it first (${what}).`, 'chat_archived');
  };
  const when = (id) => (working(id) ? ' (its current turn is not changed)' : '');

  const SESSION = (extra) => string(`The session’s id or short name from list_sessions${extra}.`);
  const unavailable = (what, harness) =>
    new ToolError(`${what} is not available for ${harness ?? 'this harness'} in MoPilot.`, 'unavailable');

  /** The caller's and the target's current settings, and whether the target runs on the caller's harness family. */
  const settings = async (caller, id) => {
    const [mine, theirs] = await Promise.all([host.settingsOf(caller), host.settingsOf(id)]);
    if (!theirs) throw new ToolError('That session is no longer available.', 'not_found');
    return { mine: mine ?? {}, theirs, sameFamily: !!mine && mine.family === theirs.family };
  };

  /** Auto on for a session, only when the user's words this turn ask for it: it can move the session to costlier models. */
  const autoOn = async (caller, id, mode) => {
    if (!asksForAuto(orchestrator.o.said?.(caller) ?? ''))
      throw new ToolError(
        `Auto was not turned on for session ${label(id)}: the user did not ask for Auto. Ask the user to choose it.`,
        'needs_user',
      );
    if (!(await host.settingsOf(id))) throw new ToolError('That session is no longer available.', 'not_found');
    host.setAutoMode(id, mode);
    const what = mode === 'global' ? 'the harness, model and effort' : 'the model and effort';
    return `Session ${label(id)} is on Auto: it picks ${what} for each turn from its next one on${when(id)}.`;
  };

  const disposers = [
    add(
      'unarchive_session',
      'Restore an archived session to the session list. Its conversation is intact; a worktree removed at archive is restored when its next message is sent, and the harness’s own archive is kept in step where it has one. Only for a session this chat started (archive_session archives one). Not for this session: a running session is never archived.',
      { session_id: SESSION(' (a session you archived)') },
      ['session_id'],
      'act',
      async (a, caller) => {
        const { id } = target(caller, a.session_id, {
          scope: 'descendant',
          verb: 'unarchived',
          self: false,
          selfMessage: 'This session is not archived.',
        });
        if (!orchestrator.archived(id)) throw new ToolError(`Session ${label(id)} is not archived.`, 'not_archived');
        await host.unarchive(id);
        return `Unarchived session ${label(id)}. It is back in the session list; its next message resumes the conversation where it left off.`;
      },
    ),
    add(
      'set_session_title',
      'Rename a session - this one, or one this chat started.\n\nUse it when the user asks to rename a session, or after a session’s scope has clearly changed and the old title is misleading. When the request did not come from the user, prefer renaming only sessions whose titles are clearly stale.',
      {
        session_id: string('The session’s id or short name, or "self" to rename this session.'),
        title: string('New title for the session (1 to 200 characters of plain text).'),
      },
      ['session_id', 'title'],
      'act',
      async (a, caller) => {
        const { id, isSelf } = target(caller, a.session_id, { self: true, scope: 'descendant', verb: 'renamed' });
        const title = a.title.trim().replace(/\s+/g, ' ');
        if (!title) throw new ToolError('title is required.', 'invalid_title');
        if (title.length > 200) throw new ToolError('title must be 1 to 200 characters.', 'invalid_title');
        if (INVISIBLE.test(title))
          throw new ToolError(
            'title must be plain visible text: no control or invisible characters. The title was left unchanged; resend it without them.',
            'invalid_title',
          );
        const who = isSelf ? 'this session' : `session ${label(id)}`;
        const facts = await host.describe(id);
        if (!facts) throw new ToolError(`Could not rename ${who} - it is no longer available.`, 'not_found');
        const was = journal.child(id)?.title ?? facts.title ?? null;
        if (same(was, title)) return `${isSelf ? 'This session' : `Session ${label(id)}`} is already named ${quote(title)}.`;
        await host.setTitle(id, title);
        return `Renamed ${who} to ${quote(title)}${was ? ` (was ${quote(was)})` : ''}.`;
      },
    ),
    add(
      'clear_session',
      'Clear a session’s conversation - the /clear command - for this session or one this chat started. MoPilot’s /clear starts a new chat instead of emptying the session, which a tool cannot do on any harness, so this reports it unavailable: use start_session with context "fresh" for work that should not carry this conversation, and stop_session or archive_session for the old one.',
      { session_id: string('"self" or the id or short name of a session this chat started.') },
      ['session_id'],
      'act',
      async (a, caller) => {
        const { id } = target(caller, a.session_id, { self: true, scope: 'descendant', verb: 'cleared' });
        const kind = (await host.settingsOf(id))?.kind ?? null;
        throw new ToolError(
          `Session ${label(id)} was not cleared: /clear in MoPilot starts a new chat, so a session cannot be emptied in place${kind ? ` (${kind})` : ''}. Start a fresh session with start_session, or ask the user to start a new chat.`,
          'unavailable',
        );
      },
    ),
    add(
      'delete_session',
      'Permanently delete sessions this chat started. Each session’s conversation and record are removed on its harness and cannot be recovered - archive_session is the reversible alternative, so prefer it unless the user explicitly asked to delete.\n\nUp to 25 session_ids per call. The user is asked to confirm every call and nothing is deleted until they approve it. Never this session. A session that is working, waiting for the user, or still waiting to start is skipped, and so is one this chat did not start. A deleted session’s own linked sessions stay and become top-level; a worktree folder is left in place. The result names what was deleted and what was skipped and why.',
      {
        session_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'The ids or short names of the sessions to delete, at most 25. Archived sessions are allowed.',
        },
        reason: string('Short human-readable reason (e.g. "user asked to clean up").'),
      },
      ['session_ids'],
      'irreversible',
      async (a, caller) => {
        const wanted = [...new Set(a.session_ids.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
        if (!wanted.length) throw new ToolError('session_ids must name at least one session.', 'invalid_session');
        if (wanted.length > MAX_DELETE) throw new ToolError(`session_ids may name at most ${MAX_DELETE} sessions per call.`, 'too_many');
        const deleted = [];
        const skipped = [];
        for (const name of wanted) {
          let id;
          try {
            ({ id } = target(caller, name, { scope: 'descendant', verb: 'deleted', selfMessage: 'this session cannot delete itself' }));
          } catch (error) {
            skipped.push(`${name} - ${error.code === 'self_refused' ? error.message : 'not a session this chat started'}`);
            continue;
          }
          const state = stateWord(controller(), journal, id);
          if (state !== 'idle' && state !== 'failed') {
            skipped.push(`${label(id)} - it is ${state === 'needs the user' ? 'waiting for the user' : state}`);
            continue;
          }
          const name2 = label(id);
          try {
            await host.remove(id);
            deleted.push(name2);
          } catch (error) {
            skipped.push(`${name2} - ${error.message}`);
          }
        }
        const parts = [
          deleted.length
            ? `Deleted ${deleted.length} session${deleted.length === 1 ? '' : 's'}: ${deleted.join(', ')}.`
            : 'Nothing was deleted.',
          skipped.length ? ` Skipped: ${skipped.join('; ')}.` : '',
        ];
        return parts.join('');
      },
    ),
    add(
      'detach_session',
      'Move a linked session to top level: it stops nesting under the session that started it, is no longer archived with it, and that session is no longer told when its turns end. Conversation, folder and settings are unchanged; it cannot be undone from here. Use it before archiving this session when a session you started should live on. Only for a session this chat started directly, or "self" when another session started this one.',
      {
        session_id: string('The id or short name of a session this chat started, or "self" when this session is itself a linked session.'),
      },
      ['session_id'],
      'act',
      async (a, caller) => {
        const { id, isSelf } = target(caller, a.session_id, { self: true, scope: 'child', verb: 'detached' });
        const link = journal.child(id);
        if (!link || link.detached) return `${isSelf ? 'This session' : `Session ${label(id)}`} is already a top-level session.`;
        const parent = link.parentId;
        orchestrator.detach(id);
        return isSelf
          ? `This session is now a top-level session. It no longer nests under session ${parent}, is not archived along with it, and that session is no longer told when this session's turns end - report to the user directly from here on.`
          : `Session ${label(id)} is now a top-level session. It no longer nests under this session, is not archived along with it, and you are no longer told when its turns end or woken when it finishes.`;
      },
    ),
    add(
      'set_session_model',
      'Switch the model a session this chat started uses, from its next turn on (a turn already in flight finishes on the current model). `model` must be one the session’s harness offers; when it is not, the result lists them; "auto" turns on Auto, which picks the model and effort for each turn, only when the user’s words this turn ask for Auto. set_session_harness moves a session to another harness. Works on any harness that offers a model setting. A model that is not the caller’s own or known to cost less is refused: a session must not silently re-price work - ask the user. Refused for this session: if this session should run on a different model, ask the user to pick it in the model menu.',
      {
        session_id: SESSION(' (a session this chat started)'),
        model: string('Model id as the session’s model picker lists it (a get_session `model` value).'),
      },
      ['session_id', 'model'],
      'act',
      async (a, caller) => {
        const { id } = target(caller, a.session_id, {
          scope: 'descendant',
          verb: 'changed',
          selfMessage: `Refusing to change this session's own model or effort; ${NEEDS_USER}.`,
        });
        const model = a.model.trim();
        if (!model) throw new ToolError('model is required.', 'invalid_model');
        noArchived(id, 'set_session_model');
        host.refuseWhileSwitching(id);
        if (model.toLowerCase() === 'auto') return autoOn(caller, id, 'harness');
        const { mine, theirs, sameFamily } = await settings(caller, id);
        if (!same(theirs.model, model) && !(sameFamily && (same(mine.model, model) || cheaperModel(model, mine.model))))
          throw new ToolError(
            `Model ${quote(model)} was not set: it is not this session's model or known to cost less on this harness. Ask the user to choose it for session ${label(id)}.`,
            'needs_user',
          );
        const applied = await host.setModel(id, model);
        // a model picked by name ends Auto
        if (host.autoModeOf(id)) host.setAutoMode(id, null);
        return `Session ${label(id)} will use ${quote(applied.model)} from its next turn on${when(id)}.`;
      },
    ),
    add(
      'set_session_harness',
      'Move a session this chat started to another harness (codex, claude or acp:<id>), optionally with a model and effort there; "auto" turns on Auto (all harnesses), which picks the harness, model and effort for each turn, only when the user’s words this turn ask for Auto. The switch is recorded now and happens with the session’s next message, which carries the conversation across; a turn in flight finishes where it is. Only to this chat’s own harness, or one the user’s words this turn name (the harness or a model on it); never to get around a usage limit. A model or effort not known to cost at most this chat’s own is refused unless the user named it. On this chat’s own harness, an omitted model or effort is this chat’s (an effort the model does not offer is left to its default); elsewhere it is that harness’s default, or the effort the session last had there. The session’s current harness cancels a waiting switch. Refused for this session: ask the user to pick it in the model menu.',
      {
        session_id: SESSION(' (a session this chat started)'),
        harness: string('The harness to move to: codex, claude or acp:<id> (list_start_targets lists them).'),
        model: string('Optional model id on that harness. An agent’s (acp:<id>) own default applies there, so leave it out.'),
        effort: { type: 'string', enum: [...EFFORTS], description: 'Optional effort level on that harness.' },
      },
      ['session_id', 'harness'],
      'act',
      async (a, caller) => {
        const { id } = target(caller, a.session_id, {
          scope: 'descendant',
          verb: 'changed',
          selfMessage: `Refusing to change this session's own harness; ${NEEDS_USER}.`,
        });
        const harness = a.harness.trim();
        if (!harness) throw new ToolError('harness is required.', 'invalid_harness');
        const model = typeof a.model === 'string' && a.model.trim() ? a.model.trim() : null;
        const effort = typeof a.effort === 'string' ? a.effort.trim() : null;
        if (effort && !EFFORTS.includes(effort)) throw new ToolError(`effort must be one of ${EFFORTS.join(', ')}.`, 'invalid_effort');
        noArchived(id, 'set_session_harness');
        if (harness.toLowerCase() === 'auto') {
          if (model || effort) throw new ToolError('Auto picks the model and effort itself: leave them out.', 'invalid_harness');
          return autoOn(caller, id, 'global');
        }
        const { mine, theirs } = await settings(caller, id);
        if (harness === theirs.kind) {
          if (model || effort)
            throw new ToolError(
              `Session ${label(id)} is already on ${harness}: use set_session_model or set_session_effort.`,
              'same_harness',
            );
          await host.switchHarness(id, { harness });
          return `Session ${label(id)} stays on ${harness}; any waiting switch is cancelled.`;
        }
        const said = orchestrator.o.said?.(caller) ?? '';
        // the caller's harness is where a linked session runs by default; any other is the user's to name
        const home = harness === mine.kind;
        if (!home && !namesHarness(said, harness) && !(model && namesModel(said, model)))
          throw new ToolError(
            `Session ${label(id)} was not moved: the user did not name ${harness}. Ask the user to choose it.`,
            'needs_user',
          );
        // only this chat's own harness compares with what this session pays
        const comparable = home && host.selectsModel(harness);
        if (model && !namesModel(said, model) && !(comparable && (same(mine.model, model) || cheaperModel(model, mine.model))))
          throw new ToolError(
            `Session ${label(id)} was not moved: model ${quote(model)} is not known to cost at most this chat's own. Ask the user to choose it.`,
            'needs_user',
          );
        const level = EFFORTS.indexOf(effort);
        // a bare level counts beside the harness or model it goes with ("sonnet 5.5 medium"), not alone ("high priority")
        const destination = namesHarness(said, harness) || (!!model && namesModel(said, model));
        if (
          effort &&
          !namesEffort(said, effort) &&
          !(destination && mentions(said, effort)) &&
          !(comparable && mine.effort && level <= EFFORTS.indexOf(mine.effort))
        )
          throw new ToolError(
            `Session ${label(id)} was not moved: effort ${effort} is not known to be at or below this chat's own. Ask the user to choose it.`,
            'needs_user',
          );
        const applied = await host.switchHarness(id, {
          harness,
          model: model ?? (comparable ? (mine.model ?? null) : null),
          effort,
          inheritedEffort: !effort && comparable ? (mine.effort ?? null) : null,
        });
        // a harness picked by name ends Global Auto
        if (host.autoModeOf(id) === 'global') host.setAutoMode(id, null);
        const on = applied.model ? ` on ${quote(applied.model)}` : '';
        const at = applied.effort ? ` at ${applied.effort} effort` : '';
        return `Session ${label(id)} moves to ${applied.harness}${on}${at} with its next message, which carries the conversation across${when(id)}.`;
      },
    ),
    add(
      'set_session_effort',
      `Set the effort level (${EFFORTS.join(', ')}) of a session this chat started, from its next turn on; the result names the level that will apply. Works on any harness that offers an effort setting. A level above this session’s own is refused (the session's cost must not rise silently - ask the user), and so is this session itself.`,
      {
        session_id: SESSION(' (a session this chat started)'),
        effort: { type: 'string', enum: [...EFFORTS], description: 'The effort level.' },
      },
      ['session_id', 'effort'],
      'act',
      async (a, caller) => {
        const { id } = target(caller, a.session_id, {
          scope: 'descendant',
          verb: 'changed',
          selfMessage: `Refusing to change this session's own model or effort; ${NEEDS_USER}.`,
        });
        const effort = a.effort.trim();
        if (!EFFORTS.includes(effort)) throw new ToolError(`effort must be one of ${EFFORTS.join(', ')}.`, 'invalid_effort');
        noArchived(id, 'set_session_effort');
        host.refuseWhileSwitching(id);
        const { mine, theirs, sameFamily } = await settings(caller, id);
        const level = EFFORTS.indexOf(effort);
        if (theirs.effort !== effort && !(sameFamily && mine.effort && level <= EFFORTS.indexOf(mine.effort)))
          throw new ToolError(
            `Effort ${effort} was not set: it is not known to be at or below this session's effort on this harness. Ask the user to choose it for session ${label(id)}.`,
            'needs_user',
          );
        const applied = await host.setEffort(id, effort);
        const level2 = applied.effort;
        return `Session ${label(id)} will run at ${level2} effort from its next turn on${level2 === effort ? '' : `; ${effort} is not offered for its model`}.${when(id)}`;
      },
    ),
    add(
      'set_session_fast_mode',
      'Turn fast mode (faster output on models that offer it, billed at fast-mode rates) on or off for this session or one this chat started, from its next request on. Turning it on needs this session to run fast itself: otherwise ask the user. Refused where the harness has no fast mode or the session’s model cannot serve it.',
      {
        session_id: string('"self" or the id or short name of a session this chat started.'),
        enabled: { type: 'boolean', description: 'true turns fast mode on, false turns it off.' },
      },
      ['session_id', 'enabled'],
      'act',
      async (a, caller) => {
        const { id, isSelf } = target(caller, a.session_id, { self: true, scope: 'descendant', verb: 'changed' });
        noArchived(id, 'set_session_fast_mode');
        const { mine, theirs } = await settings(caller, id);
        if (theirs.fast === undefined) throw unavailable('Fast mode', theirs.kind);
        if (a.enabled && !mine.fast)
          throw new ToolError(
            `Fast mode was not turned on for ${isSelf ? 'this session' : `session ${label(id)}`}: this session does not run fast itself, so the user has to turn it on.`,
            'needs_user',
          );
        const on = await host.setFast(id, a.enabled);
        return `${isSelf ? 'This session' : `Session ${label(id)}`} has fast mode ${on ? 'on' : 'off'} from its next request on.`;
      },
    ),
    add(
      'set_session_output_style',
      'Switch the output style of this session or one this chat started. MoPilot applies no per-chat output style on any harness, so this reports it unavailable instead of pretending: tell the user to change the style in the harness’s own settings.',
      { session_id: string('"self" or the id or short name of a session this chat started.'), style: string('The style’s name.') },
      ['session_id', 'style'],
      'act',
      async (a, caller) => {
        const { id } = target(caller, a.session_id, { self: true, scope: 'descendant', verb: 'changed' });
        const style = a.style.trim();
        if (!style) throw new ToolError('style must be the name of an output style.', 'invalid_style');
        const kind = (await host.settingsOf(id))?.kind;
        throw unavailable('A per-chat output style', kind);
      },
    ),
    add(
      'set_session_permission_mode',
      `Switch this session or one this chat started to a permission mode: ${PERMISSIONS.join(', ')} (the native names acceptEdits, bypassPermissions, dontAsk and auto are accepted too). Applies from the next action. A mode above this session’s own is refused - a session cannot hand out more than it has; ask the user. A harness maps the mode to its own names (the closest mode it declares; one with no modes is unavailable).`,
      {
        session_id: string('"self" or the id or short name of a session this chat started.'),
        mode: { type: 'string', description: `The permission mode: ${PERMISSIONS.join(', ')}.` },
      },
      ['session_id', 'mode'],
      'act',
      async (a, caller) => {
        const { id, isSelf } = target(caller, a.session_id, { self: true, scope: 'descendant', verb: 'changed' });
        const mode = appPermission(a.mode.trim());
        if (!mode) throw new ToolError(`mode must be one of ${PERMISSIONS.join(', ')}.`, 'invalid_mode');
        noArchived(id, 'set_session_permission_mode');
        const { mine, theirs } = await settings(caller, id);
        const own = PERMISSIONS.indexOf(mine.permission);
        if (own < 0)
          throw new ToolError(
            'Nothing was changed: this session has not reported a known permission mode, so the new one cannot be compared with it.',
            'unknown_permission',
          );
        if (PERMISSIONS.indexOf(mode) > own)
          throw new ToolError(
            `Nothing was changed: ${mode} lets a session do more without asking than this session's ${mine.permission}. Ask the user to switch it.`,
            'needs_user',
          );
        const who = isSelf ? 'This session' : `Session ${label(id)}`;
        if (theirs.permission === mode) return `${who} is already in ${mode} mode.`;
        const done = await host.setPermission(id, mode);
        return `${who} now runs in ${done.mode} mode${done.mode === mode ? '' : ` (${mode} is the closest mode its harness declares)`}. ${
          isSelf ? 'It applies to the rest of this turn and every turn after it.' : 'It applies from its next action on.'
        }`;
      },
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerSessionControlTools, MAX_DELETE };
