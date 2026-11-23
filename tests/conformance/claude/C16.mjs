// MoPilot's tool channel under each Claude billing (WP5-17, A8): Sage's own SDK MCP server, built
// the way a chat gets it (electron/capabilities/mcp/sdkMcp.cjs), must give the model
// sage_debug_echo directly (alwaysLoad, no ToolSearch), and the model must read back a random word.
// Subscription runs on the CLI's own login. MoPilot and DeepSeek run only when their keys are set:
//   SAGE_MOPILOT_KEY (an mpk_ gateway key; SAGE_MOPILOT_BASE overrides the gateway origin)
//   SAGE_DEEPSEEK_KEY (SAGE_DEEPSEEK_BASE and SAGE_DEEPSEEK_MODEL override the endpoint and model)
import { createRequire } from 'node:module';
import { sdk, open, brief, toolUses, cleanEnv } from '../lib/claude.mjs';
import { randomWord } from '../lib/png.mjs';

export const id = 'C16';
export const title = "MoPilot's tool channel under each billing (sage_debug_echo)";
export const timeoutMs = 600000;

const require = createRequire(import.meta.url);
const { Registry } = require('../../../electron/capabilities/contract/registry.cjs');
const { injectSdkMcp, autoAllow } = require('../../../electron/capabilities/mcp/sdkMcp.cjs');
const { echo } = require('../../../electron/capabilities/tools/debug.cjs');
const z = require('zod');

function billings(model) {
  const out = [{ name: 'subscription', env: {}, model }];
  if (process.env.SAGE_MOPILOT_KEY) {
    const base = (process.env.SAGE_MOPILOT_BASE || 'https://code.mopilot.ai').replace(/\/$/, '');
    out.push({
      name: 'mopilot',
      env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: process.env.SAGE_MOPILOT_KEY, ANTHROPIC_API_KEY: '' },
      model,
    });
  }
  if (process.env.SAGE_DEEPSEEK_KEY) {
    const base = process.env.SAGE_DEEPSEEK_BASE || 'https://api.deepseek.com/anthropic';
    out.push({
      name: 'deepseek',
      env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: process.env.SAGE_DEEPSEEK_KEY, ANTHROPIC_API_KEY: '' },
      model: process.env.SAGE_DEEPSEEK_MODEL || 'deepseek-chat',
    });
  }
  return out;
}

export default async function run(ctx) {
  const out = { skipped: [] };
  if (!process.env.SAGE_MOPILOT_KEY) out.skipped.push('mopilot (no SAGE_MOPILOT_KEY)');
  if (!process.env.SAGE_DEEPSEEK_KEY) out.skipped.push('deepseek (no SAGE_DEEPSEEK_KEY)');
  const facts = {};
  for (const b of billings(ctx.model)) {
    const word = randomWord();
    const registry = new Registry();
    registry.register(echo);
    const serverName = `sage_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
    const options = {};
    injectSdkMcp(options, { sdk, z, registry, serverName, owner: { chatId: 'conformance', segmentId: b.name } });
    const asked = [];
    const s = open(ctx, b.name, {
      ...options,
      model: b.model,
      effort: null,
      env: { ...cleanEnv(), ...b.env },
      permissionMode: 'default',
      // as electron/harness/claude/index.cjs: Sage's own tools pass, anything else is refused here
      canUseTool: async (name, input) => (
        asked.push(name), autoAllow(serverName, name, input) ?? { behavior: 'deny', message: 'Not in this check' }
      ),
    });
    const res = await s.turn(
      `Call the tool mcp__${serverName}__sage_debug_echo once with the text "${word}", then reply with exactly what it returned and nothing else.`,
      {},
      240000,
    );
    const init = s.msgs.find((m) => m.subtype === 'init');
    const used = toolUses(s.msgs);
    out[b.name] = {
      model: b.model,
      result: brief(res),
      readBack: String(res?.result ?? '').includes(`echo: ${word}`),
      initHasTool: (init?.tools ?? []).includes(`mcp__${serverName}__sage_debug_echo`),
      toolUses: used,
      asked,
    };
    await s.close();
    facts[`${b.name}: the tool is listed in init`] = out[b.name].initHasTool;
    facts[`${b.name}: the model reads the word back`] = out[b.name].readBack;
    facts[`${b.name}: no ToolSearch first (alwaysLoad)`] = !used.includes('ToolSearch');
  }
  return ctx.result(out, facts);
}
