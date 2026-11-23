// A plugin's agents as skills outside Claude Code: the conversion (shared/plugins/agentSkill.mjs), reach per family
// and the Plugins page line, the basic tier's plugin_skills, and the trust digest (agents run nothing). Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { agentSkillName, agentSkillText, agentNameTaken } from '../shared/plugins/agentSkill.mjs';
import { pluginReach, componentReach, REACH_NOTE, REACH_WHY } from '../shared/plugins/reach.mjs';
import { reachLine } from '../src/components/plugins/ReachStrip.tsx';

const require = createRequire(import.meta.url);
const { PluginDelivery } = require('../electron/plugins/delivery.cjs');
const { PluginStore } = require('../electron/plugins/store.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-agent-skills-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('an agent becomes a skill: described, its front matter dropped, told to run in this conversation', () => {
  assert.equal(agentSkillName('review:deep'), 'agent-review-deep');
  const text = agentSkillText(
    'reviewer',
    '---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: sonnet\n---\n\nCheck the diff.\n',
  );
  assert.match(text, /^---\nname: agent-reviewer\ndescription: "Agent: Reviews diffs"\n---\n/);
  assert.match(text, /runs as a skill here/);
  assert.match(text, /Check the diff\.\n$/);
  assert.doesNotMatch(text, /tools:|model:/);
  // no front matter, no body: still a valid skill with a generic description
  const bare = agentSkillText('empty', '');
  assert.match(bare, /description: "Agent: Instructions of the empty agent"/);
  assert.match(agentSkillText('plain', 'Just do it.'), /Just do it\./);
});

test('a skill or command with the agent skill’s name takes it', () => {
  assert.equal(agentNameTaken({ skills: [{ name: 'agent-a' }] }, 'a'), true);
  assert.equal(agentNameTaken({ commands: [{ name: 'agent-a' }] }, 'a'), true);
  assert.equal(agentNameTaken({}, 'a'), false);
  assert.equal(agentNameTaken({ skills: [{ name: 'other' }] }, 'a'), false);
});

test('agents reach every family: native on Claude and Codex, from MoPilot on the basic tier, with a note off Claude', () => {
  assert.deepEqual(componentReach({ kind: 'agents', name: 'a' }, 'claude'), {
    reach: 'native',
  });
  assert.deepEqual(componentReach({ kind: 'agents', name: 'a' }, 'codex'), {
    reach: 'native',
    note: 'plugin.agentAsSkill',
  });
  assert.deepEqual(componentReach({ kind: 'agents', name: 'a' }, 'acp'), {
    reach: 'mopilot',
    note: 'plugin.agentAsSkill',
  });
  assert.equal(REACH_WHY['plugin.agentsClaudeOnly'], undefined);
  // a plugin with only agents is whole on every family
  const only: any = { agents: [{ name: 'helper' }] };
  for (const family of ['claude', 'codex', 'acp']) assert.equal(pluginReach(only, family).summary, 'full');
  assert.equal(reachLine(only, 'claude').text, 'Everything.');
  assert.equal(reachLine(only, 'codex').text, `Everything. ${REACH_NOTE['plugin.agentAsSkill']}`);
  assert.equal(reachLine(only, 'acp').text, `Everything. ${REACH_NOTE['plugin.agentAsSkill']}`);
  // the remote-MCP caveat follows the agent note
  const remote: any = {
    agents: [{ name: 'helper' }],
    mcpServers: { r: { type: 'http', url: 'https://x.test' } },
  };
  assert.equal(reachLine(remote, 'acp').text, `Everything. ${REACH_NOTE['plugin.agentAsSkill']} Remote MCP depends on the harness.`);
});

test('on Codex an agent whose skill name a skill or command took is reported as left out', () => {
  const spec: any = {
    agents: [{ name: 'a' }, { name: 'b' }],
    skills: [{ name: 'agent-a' }],
  };
  const codex = pluginReach(spec, 'codex');
  assert.equal(codex.summary, 'partial');
  assert.deepEqual(
    codex.components.map((c: any) => c.why ?? c.reach),
    ['native', 'plugin.agentNameTaken', 'native'],
  );
  assert.equal(pluginReach(spec, 'acp').summary, 'full');
  assert.match(reachLine(spec, 'codex').text, /^Not a\. A skill or command of the plugin already has this agent's skill name\./);
});

const newStore = () => {
  const dir = tmp();
  return new PluginStore({ dir: () => dir });
};

async function install(store: any, files: Record<string, string>, name = 'crew') {
  const root = path.join(tmp(), name);
  write(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name }));
  for (const [file, text] of Object.entries(files)) write(path.join(root, file), text);
  const p = await store.preview(root);
  return {
    trust: p.trust,
    record: (await store.install(root, { marketplace: 'acme', trust: p.trust })).record,
  };
}

test('the basic tier lists an agent as a skill and reads it converted; Claude and Codex list nothing', async () => {
  const store = newStore();
  const { record } = await install(store, {
    'agents/reviewer.md': '---\ndescription: Reviews diffs\nmodel: opus\n---\nCheck the diff.\n',
    'skills/s/SKILL.md': '---\nname: s\n---\nBody\n',
  });
  const delivery = new PluginDelivery({
    store,
    home: tmp(),
    claudeNative: () => new Set(),
  });
  const listed = await delivery.skillsFor('acp');
  assert.deepEqual(
    listed.map((s: any) => [s.name, s.kind]),
    [
      ['crew@acme:skill:s', 'skill'],
      ['crew@acme:agent:reviewer', 'agent'],
    ],
  );
  const read = await delivery.readSkill('acp', 'crew@acme:agent:reviewer');
  assert.match(read.text, /name: agent-reviewer/);
  assert.match(read.text, /Check the diff\./);
  assert.doesNotMatch(read.text, /model: opus/);
  assert.equal((await delivery.readSkill('acp', 'crew@acme:skill:s')).text, '---\nname: s\n---\nBody\n', 'a skill is read as written');
  await assert.rejects(delivery.readSkill('acp', 'crew@acme:agent:reviewer', 'x.md'), /Only a skill keeps files/);
  assert.deepEqual(await delivery.skillsFor('claude'), []);
  assert.deepEqual(await delivery.skillsFor('codex'), []);
  // when Codex's own install failed, its agents come over plugin_skills like its skills
  delivery.reportFailures('codex', () => new Set([record.id ?? 'crew@acme']));
  assert.deepEqual(
    (await delivery.skillsFor('codex')).map((s: any) => s.kind),
    ['skill', 'agent'],
  );
});

test('a plugin with only agents is delivered, and agents do not change the trust digest', async () => {
  const store = newStore();
  const withAgents = await install(store, { 'agents/a.md': 'Do A.\n' }, 'one');
  const without = await install(newStore(), {}, 'one');
  assert.equal(withAgents.trust, without.trust);
  const delivery = new PluginDelivery({ store, home: tmp() });
  const out = await delivery.skillsFor('acp');
  assert.deepEqual(
    out.map((s: any) => s.name),
    ['one@acme:agent:a'],
  );
});
