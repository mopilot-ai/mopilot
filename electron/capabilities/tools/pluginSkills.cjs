// Plugin skills and commands for harnesses that don't load plugin skills themselves (the basic tier): the registry
// advertises plugin_skills and plugin_skill_read on every harness's tool channel; each lists only what the calling
// chat's harness needs MoPilot to provide (electron/plugins/delivery.cjs skillsFor), so on Claude Code and Codex,
// which load plugins natively, the list is empty and says so.
const { ToolError } = require('../contract/registry.cjs');
const { parseKind } = require('../../../shared/harnessKind.mjs');

/**
 * @param {any} registry the capability registry
 * @param {object} o
 * @param {Pick<InstanceType<typeof import('../../plugins/delivery.cjs').PluginDelivery>, 'skillsFor' | 'readSkill'>} o.delivery
 * @param o.owner (ctx) => string | null: the chat that called
 * @param o.harnessOf (chatId) => string | null: the chat's current harness ('codex', 'claude', 'acp:<id>')
 */
function registerPluginSkillTools(registry, o) {
  /** The calling chat's harness family. */
  const familyOf = (ctx) => {
    const chatId = o.owner(ctx);
    if (!chatId) throw new ToolError('The caller does not own this chat segment', 'no_owner');
    const family = parseKind(o.harnessOf(chatId))?.family;
    if (!family) throw new ToolError("This chat's harness isn't known", 'no_harness');
    return family;
  };
  registry.register({
    name: 'plugin_skills',
    description:
      'List the skills and commands of the MoPilot plugins the user installed that this harness does not load itself. ' +
      'Before a task one of them fits, read it with plugin_skill_read and follow its instructions. ' +
      'Empty on harnesses that load plugins natively (their skills are already available there).',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    policy: 'observe',
    handler: async (_args, ctx) => {
      const skills = await o.delivery.skillsFor(familyOf(ctx), o.owner(ctx));
      const lines = skills.map((s) => `- ${s.name} (${s.kind})${s.description ? `: ${s.description}` : ''}`);
      return lines.length ? lines.join('\n') : 'No plugin skills or commands to load here.';
    },
  });
  registry.register({
    name: 'plugin_skill_read',
    description:
      'Read a skill or command plugin_skills listed, by its name ("<plugin>@<marketplace>:<kind>:<skill>"). A command\'s text is a prompt ' +
      'template: $ARGUMENTS stands for what the user asked. With `file`, read a file the skill keeps next to its SKILL.md.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name plugin_skills gave, e.g. "stripe@acme:skill:test-cards"' },
        file: { type: 'string', description: "A path relative to the skill's folder, e.g. references/api.md" },
      },
      required: ['name'],
      additionalProperties: false,
    },
    policy: 'observe',
    handler: async (args, ctx) => {
      const family = familyOf(ctx);
      try {
        const read = await o.delivery.readSkill(
          family,
          String(args.name),
          args.file === undefined ? undefined : String(args.file),
          o.owner(ctx),
        );
        return read.text;
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e), 'unreadable');
      }
    },
  });
}

module.exports = { registerPluginSkillTools };
