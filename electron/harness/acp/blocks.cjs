// ACP prompt blocks preserve explicit audio messages separately from editable dictation text.
const { pathToFileURL } = require('node:url');
const { withSelections } = require('../../../shared/selections.mjs');
const { withChatReferences } = require('../../../shared/chatReferences.mjs');
const { withComputerHistory } = require('../../../shared/computerHistory.mjs');
const { withMomoContext } = require('../../../shared/momoContext.mjs');
const { withTabMentions } = require('../../../shared/tabMentions.mjs');

/**
 * The prompt as ACP content blocks: the text, then images, then files as resource links. A skill chip is the
 * harness's own /command, except a MoPilot plugin's skill or command, which the harness doesn't know: the model
 * is asked to read it with plugin_skill_read (electron/capabilities/tools/pluginSkills.cjs). The same goes for a
 * message that starts with a plugin's "/<plugin>:<name>" typed by hand.
 * @param {() => Promise<{name: string, kind: string, file: string}[]>} [pluginSkills] what the basic tier gets from MoPilot
 * @param {((file: string) => Promise<any>) | null} [readAudio] validated durable audio
 * @param {string | null} [momo] MoMo's memory for a MoMo chat's turn (electron/momo/contract/context.cjs), ahead of the rest
 */
async function acpBlocks(text, attachments, readImage, pluginSkills = async () => [], momo = null, readAudio = null) {
  const blocks = [];
  let t = withSelections(
    withTabMentions(text, 'text'),
    attachments.filter((a) => a.kind === 'selection'),
  );
  const chips = attachments.filter((a) => a.kind === 'skill');
  const typed = /^\/([\w.@-]+:[\w.:-]+)(?=\s|$)/.exec(t);
  const plugins = chips.length || typed ? await pluginSkills() : [];
  const ask = (s) => `(Use the ${s.name} ${s.kind} from MoPilot's plugins: read it with plugin_skill_read and follow it.)`;
  const typedPlugin = typed && plugins.find((s) => s.name === typed[1]);
  if (typedPlugin) t = `${ask(typedPlugin)}${t.slice(typed[0].length)}`;
  const skills = chips.map((a) => {
    const plugin = plugins.find((s) => s.file === a.path);
    return plugin ? ask(plugin) : `/${a.name}`;
  });
  // ACP has no context channel: shared memories go ahead of the prompt as a quoted block (degraded, shared/computerHistory.mjs)
  // and so does MoMo's memory, ahead of them (degraded the same way, shared/momoContext.mjs)
  const body = withMomoContext(
    withComputerHistory(withChatReferences([...skills, t].filter(Boolean).join(' '), attachments), attachments),
    momo,
  );
  if (body.trim()) blocks.push({ type: 'text', text: body });
  for (const a of attachments) {
    if (a.kind === 'audio') {
      if (!readAudio) throw new Error('Audio message storage is unavailable');
      blocks.push(await readAudio(a.path));
    } else if (a.kind === 'image') {
      const url = await readImage(a.path);
      const m = url && /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (m) blocks.push({ type: 'image', mimeType: m[1], data: m[2] });
    } else if (a.kind === 'file') blocks.push({ type: 'resource_link', uri: pathToFileURL(a.path).href, name: a.name });
  }
  return blocks;
}

module.exports = { acpBlocks };
