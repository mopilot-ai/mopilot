// The sidebar's write tools (set_pinned, set_unread, list_sections, create_section, rename_section, delete_section,
// move_project), as Claude Desktop's ccd_sidebar ones mapped onto what MoPilot's sidebar really has: a pin and an
// unread dot per chat (chat meta), and named sections that hold saved projects (prefs sidebarSections / projectSection).
// The same on Codex, Claude Code and admitted ACP harnesses. MoPilot has no session groups, no "mark completed"
// (a row's dot follows the chat's own state) and no per-chat project move (a chat stays in the project of its folder),
// so those tools are not offered. Renaming or deleting a section is the user's call: it asks first.
const { ToolError } = require('../contract/registry.cjs');
const { isMomoMeta } = require('../../../shared/momoChat.mjs');

const MAX_NAME = 80;
const MAX_SECTIONS = 50;

/** A section name as the sidebar shows it: one trimmed line, 1 to MAX_NAME characters. */
function nameOf(raw) {
  const name = String(raw).replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_NAME) throw new ToolError(`A section name is 1 to ${MAX_NAME} characters`, 'bad_args');
  return name;
}

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat that called
 * @param {() => Map<string, any>} o.records the chat records
 * @param {(id: string, patch: object) => boolean} o.patchMeta saves part of a chat's meta (true when it changed); the windows hear it
 * @param {() => any} o.prefs the saved prefs
 * @param {(set: Record<string, unknown>) => boolean} o.patchPrefs saves prefs and tells every window
 * @param {() => { id: string, name: string, path: string }[]} o.projects the saved projects
 * @param {(chatId: string, summary: string, signal: AbortSignal | null) => Promise<boolean>} o.ask the user's answer to a consent card
 * @param {() => string} [o.newId] a new section's id
 * @returns {() => void} removes the tools
 */
function registerSidebarTools(
  registry,
  { owner, records, patchMeta, prefs, patchPrefs, projects, ask, newId = () => Math.random().toString(36).slice(2, 8) },
) {
  const sections = () => (Array.isArray(prefs()?.sidebarSections) ? prefs().sidebarSections : []);
  const placement = () => (prefs()?.projectSection && typeof prefs().projectSection === 'object' ? prefs().projectSection : {});
  const save = (set) => {
    if (!patchPrefs(set)) throw new ToolError("Couldn't save the sidebar's settings", 'save_failed');
  };
  /** The section `id` names, or why not. */
  const sectionOf = (id) => {
    const found = sections().find((s) => s.id === String(id).trim());
    if (!found) throw new ToolError('No such section. Use list_sections for the ids.', 'not_found');
    return found;
  };
  /** The chat `id` names: this one ("self" or empty) or another chat that exists and is not MoMo's. */
  const chatOf = (caller, id) => {
    const wanted = String(id).trim();
    if (!wanted || wanted.toLowerCase() === 'self') return caller;
    const rec = records().get(wanted);
    if (!rec || isMomoMeta(rec.meta)) throw new ToolError('No such chat. Use list_sidebar for the chat ids.', 'not_found');
    return wanted;
  };
  const add = (name, description, properties, required, policy, handler) =>
    registry.register({
      name,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      policy,
      authorizesItself: true,
      handler: async (args, ctx) => {
        const caller = owner(ctx);
        if (!caller) throw new ToolError('The caller does not own this chat segment', 'no_owner');
        return handler(args, caller, ctx);
      },
    });
  /** Asks the user before a section is renamed or deleted. */
  const consent = async (caller, ctx, summary) => {
    if (!(await ask(caller, summary, ctx.signal))) throw new ToolError('The user did not allow this change.', 'denied');
  };
  const chatId = { type: 'string', description: 'A chat id from list_sidebar, or "self" for this session' };
  const flag = (name, description, tool, done) =>
    add(tool, description, { session_id: chatId, [name]: { type: 'boolean' } }, ['session_id', name], 'act', async (args, caller, ctx) => {
      const id = chatOf(caller, args.session_id);
      // another chat's row is the user's to change: the card names what for
      if (id !== caller)
        await consent(caller, ctx, `${args[name] ? 'set' : 'clear'} ${name === 'pinned' ? 'the pin' : 'the unread dot'} of another chat`);
      // patchMeta-changes: false is reported to the model as 'changed: false', not an error
      const changed = patchMeta(id, { [name]: args[name] });
      return { session_id: id, [name]: args[name], changed, said: done(args[name]) };
    });

  const disposers = [
    flag(
      'pinned',
      'Pin or unpin a chat in the sidebar ("self" for this session). A pinned chat is shown under Pinned and is kept out of automatic archiving.',
      'set_pinned',
      (on) => (on ? 'Pinned it in the sidebar.' : 'Unpinned it.'),
    ),
    flag('unread', 'Mark a chat unread (blue dot) or read in the sidebar ("self" for this session).', 'set_unread', (on) =>
      on ? 'Marked it unread.' : 'Marked it read.',
    ),
    add(
      'list_sections',
      "List the sidebar's sections in order: named groups of projects. Returns {id, name, projects} for each (project names). Projects in no section are listed under unsectioned.",
      {},
      [],
      'observe',
      async () => {
        const place = placement();
        const all = projects();
        const inSection = (id) => all.filter((p) => place[p.id] === id).map((p) => p.name);
        const known = new Set(sections().map((s) => s.id));
        return {
          sections: sections().map((s) => ({ id: s.id, name: s.name, projects: inSection(s.id) })),
          unsectioned: all.filter((p) => !known.has(place[p.id])).map((p) => p.name),
        };
      },
    ),
    add(
      'create_section',
      'Create a sidebar section the user can group projects in, and return its id. It starts empty; put projects in it with move_project. Prefer an existing section (list_sections) over a near-duplicate, and use the name the user asked for.',
      { name: { type: 'string', description: `The section's name (1 to ${MAX_NAME} characters)` } },
      ['name'],
      'act',
      async (args) => {
        const name = nameOf(args.name);
        const list = sections();
        if (list.length >= MAX_SECTIONS) throw new ToolError(`There are already ${MAX_SECTIONS} sections`, 'too_many');
        const same = list.find((s) => s.name.toLowerCase() === name.toLowerCase());
        if (same) return { id: same.id, name: same.name, created: false, said: 'A section with that name exists; use its id.' };
        let id = newId();
        while (list.some((s) => s.id === id)) id = newId();
        save({ sidebarSections: [...list, { id, name }] });
        return { id, name, created: true, said: 'Created the section. File projects into it with move_project.' };
      },
    ),
    add(
      'rename_section',
      'Rename a sidebar section. The user is asked to approve each rename.',
      { section_id: { type: 'string', description: 'A section id from list_sections' }, name: { type: 'string' } },
      ['section_id', 'name'],
      'act',
      async (args, caller, ctx) => {
        const name = nameOf(args.name);
        const section = sectionOf(args.section_id);
        if (sections().some((s) => s.id !== section.id && s.name.toLowerCase() === name.toLowerCase()))
          throw new ToolError('Another section has that name. Pick a different one.', 'exists');
        await consent(caller, ctx, `rename the sidebar section “${section.name}” to “${name}”`);
        // read again: the section may have changed while the card waited
        const now = sectionOf(section.id);
        save({ sidebarSections: sections().map((s) => (s.id === now.id ? { ...s, name } : s)) });
        return { id: now.id, name, said: 'Renamed the section.' };
      },
    ),
    add(
      'delete_section',
      'Delete a sidebar section. Its projects are not touched: they fall back to no section. The user is asked to approve each delete; only call it when they asked to remove that section.',
      { section_id: { type: 'string', description: 'A section id from list_sections' } },
      ['section_id'],
      'irreversible',
      async (args, caller, ctx) => {
        const section = sectionOf(args.section_id);
        await consent(caller, ctx, `delete the sidebar section “${section.name}”`);
        const now = sectionOf(section.id);
        const place = Object.fromEntries(Object.entries(placement()).filter(([, sid]) => sid !== now.id));
        save({ sidebarSections: sections().filter((s) => s.id !== now.id), projectSection: place });
        return { id: now.id, said: 'Deleted the section. Its projects are in no section now.' };
      },
    ),
    add(
      'move_project',
      'File a saved project under a sidebar section, or pass section_id null to take it out of its section. Projects are named as list_sidebar names them (project name or folder).',
      {
        project: { type: 'string', description: "The project's name or folder" },
        section_id: { type: ['string', 'null'], description: 'A section id from list_sections, or null for no section' },
      },
      ['project', 'section_id'],
      'act',
      async (args) => {
        const want = String(args.project).trim().toLowerCase();
        const matches = projects().filter((p) => p.name.toLowerCase() === want || p.path.toLowerCase() === want);
        if (matches.length !== 1)
          throw new ToolError(
            matches.length ? 'More than one project has that name; give its folder.' : 'No saved project by that name or folder.',
            matches.length ? 'ambiguous' : 'not_found',
          );
        const [project] = matches;
        const place = { ...placement() };
        if (args.section_id === null) delete place[project.id];
        else place[project.id] = sectionOf(args.section_id).id;
        save({ projectSection: place });
        return {
          project: project.name,
          section_id: args.section_id,
          said: args.section_id === null ? 'Took it out of its section.' : 'Filed it under the section.',
        };
      },
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerSidebarTools };
