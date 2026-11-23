// Inventories raw plugin sources once per read and accounts for each family's native hooks/MCP selection.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const {
  MANIFEST_FILES,
  isPluginName,
  DEFAULT_HOOKS,
  DEFAULT_MCP,
  pluginRelative,
  normalizeMcpServers,
  normalizeHooks,
} = require('../../shared/plugins/manifest.mjs');

const HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
];
const absent = (e) => e.code === 'ENOENT' || e.code === 'ENOTDIR';
const optionalString = (value) => value === undefined || value === null || typeof value === 'string';
const optionalCount = (value, token) =>
  value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0 && /^[0-9]+$/.test(token));
const tomlValue = (value) => value !== null && (typeof value !== 'object' || Object.values(value).every(tomlValue));

/** Codex 0.162.0-alpha.17.2's HooksFile declaration parser; invalid inline declarations select the default. */
function codexHookFile(value, numberTokens) {
  if (
    !isJsonRecord(value) ||
    Object.keys(value).some((key) => key !== 'hooks' && key !== 'description') ||
    !optionalString(value.description)
  )
    return false;
  if (value.hooks === undefined) return true;
  if (!isJsonRecord(value.hooks)) return false;
  const events = value.hooks;
  return HOOK_EVENTS.every((event) => {
    const groups = events[event];
    if (groups === undefined) return true;
    return (
      Array.isArray(groups) &&
      groups.every((group, groupIndex) => {
        if (!isJsonRecord(group) || !optionalString(group.matcher)) return false;
        if (group.hooks === undefined) return true;
        return (
          Array.isArray(group.hooks) &&
          group.hooks.every((hook, hookIndex) => {
            if (!isJsonRecord(hook)) return false;
            if (hook.type === 'prompt' || hook.type === 'agent') return true;
            const count = (field) =>
              optionalCount(hook[field], numberTokens[JSON.stringify(['hooks', event, groupIndex, 'hooks', hookIndex, field])]);
            if (!count('timeout') || !optionalString(hook.statusMessage)) return false;
            if (hook.type === 'command')
              return (
                typeof hook.command === 'string' &&
                optionalString(hook.commandWindows) &&
                optionalString(hook.command_windows) &&
                !(Object.hasOwn(hook, 'commandWindows') && Object.hasOwn(hook, 'command_windows')) &&
                (hook.async === undefined || typeof hook.async === 'boolean') &&
                count('additionalContextLimit')
              );
            if (hook.type === 'mcp_tool')
              return (
                typeof hook.server === 'string' &&
                typeof hook.tool === 'string' &&
                (hook.input === undefined || (isJsonRecord(hook.input) && tomlValue(hook.input)))
              );
            return false;
          })
        );
      })
    );
  });
}

/** Retain numeric token types as well as values: serde integer fields reject 1.0, 1e0 and -0. */
function sourceJson(text) {
  const raw = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|true|false|null|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g);
  const numbers = [];
  let index = 0;
  let ambiguous = false;
  const visit = (location) => {
    const token = tokens[index++];
    if (token === '{') {
      const keys = new Set();
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++]);
        if (keys.has(key)) ambiguous = true;
        keys.add(key);
        index++; // colon, guaranteed by JSON.parse
        visit([...location, key]);
        if (tokens[index] !== ',') break;
        index++;
      }
      index++;
    } else if (token === '[') {
      let item = 0;
      while (tokens[index] !== ']') {
        visit([...location, item++]);
        if (tokens[index] !== ',') break;
        index++;
      }
      index++;
    } else if (/^-?\d/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) ambiguous = true;
      numbers.push([JSON.stringify(location), token]);
    }
  };
  visit([]);
  return { raw, numberTokens: Object.fromEntries(numbers), ambiguous };
}

/** Inline source numeric paths are relative to that source, independent of object-key encounter order. */
function inlineNumbers(tokens, prefix) {
  return Object.fromEntries(
    Object.entries(tokens).flatMap(([key, token]) => {
      const location = JSON.parse(key);
      return prefix.every((part, index) => location[index] === part) ? [[JSON.stringify(location.slice(prefix.length)), token]] : [];
    }),
  );
}

/** No normalized-root substitution: source values retain literal strings, opaque keys and argv boundaries. */
async function sourceInventory(root) {
  const files = new Map();
  const read = async (source) => {
    if (files.has(source)) return files.get(source);
    /** @type {import('../../shared/plugins/manifest.mjs').PluginSource} */
    const result = { source, state: 'absent' };
    files.set(source, result);
    try {
      if (MANIFEST_FILES.includes(source)) {
        const parent = await fs.promises.lstat(path.dirname(path.join(root, source)));
        result.parentKind = parent.isDirectory() ? 'directory' : 'other';
      }
      const stat = await fs.promises.lstat(path.join(root, source));
      if (source === 'plugin.json' || MANIFEST_FILES.includes(source))
        result.kind = stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'other';
      const text = await fs.promises.readFile(path.join(root, source), 'utf8');
      try {
        const parsed = sourceJson(text);
        result.raw = parsed.raw;
        result.numberTokens = parsed.numberTokens;
        result.state = 'read';
        if (parsed.ambiguous) {
          result.state = 'error';
          result.error = 'duplicate JSON keys or numbers outside the supported range';
          result.text = text;
        }
      } catch {
        result.state = 'error';
        result.error = 'invalid JSON';
        result.text = text;
      }
    } catch (e) {
      if (!absent(e)) {
        result.state = 'error';
        result.error = e.code;
      }
    }
    return result;
  };
  for (const source of ['plugin.json', ...MANIFEST_FILES, DEFAULT_MCP, DEFAULT_HOOKS]) await read(source);
  return { files, read };
}

/** A Codex declaration path must begin with ./; malformed paths fall back instead of selecting a file. */
function codexPath(value) {
  if (typeof value !== 'string' || !value.startsWith('./')) return null;
  const relative = value.slice(2);
  const windows = process.platform === 'win32';
  if (
    !relative ||
    relative.startsWith('/') ||
    (windows && (/^[a-z]:/i.test(relative) || relative.startsWith('\\'))) ||
    relative.split(windows ? /[\\/]/ : /\//).includes('..')
  )
    return null;
  return path.normalize(relative);
}

/** Read an exact plan without executing anything; source ordering is part of its approval identity. */
async function nativePlan(family, inv, root) {
  const portable = inv.files.get('plugin.json');
  const manifest =
    family === 'claude'
      ? inv.files.get(MANIFEST_FILES[0])
      : [MANIFEST_FILES[1], MANIFEST_FILES[0]]
          .map((name) => inv.files.get(name))
          .find((source) => source.state !== 'absent' || source.parentKind === 'other');
  /** @type {import('../../shared/plugins/manifest.mjs').PluginExecutionPlan} */
  const plan = {
    contract: family === 'claude' ? 'claude-defaults-first-v1' : 'codex-0.162.0-alpha.17.2',
    layout: manifest && manifest.state !== 'absent' ? manifest.source : 'none',
    state: 'supported',
    reasons: [],
    sources: [],
    ignored: [],
    mcpServers: {},
    hooks: [],
    hookEvents: [],
  };
  const refuse = (reason) => {
    plan.state = 'withheld';
    plan.reasons.push(reason);
  };
  const selectedManifest = manifest && manifest.state !== 'absent' ? manifest : null;
  if (selectedManifest) plan.sources.push({ ...selectedManifest, component: 'manifest' });
  if (family === 'codex') {
    if (portable.kind === 'link' || portable.kind === 'other' || (portable.state === 'error' && portable.kind === undefined)) {
      refuse('Codex cannot discover a manifest through this root plugin.json.');
    } else if (
      isJsonRecord(portable.raw) &&
      typeof portable.raw.$schema === 'string' &&
      portable.raw.$schema.startsWith('https://agent-plugins.org/schemas/')
    ) {
      plan.layout = 'plugin.json';
      plan.sources.push({ ...portable, component: 'manifest' });
      refuse('Codex selects a portable root manifest; this source layout is not yet accounted for.');
    } else if (!selectedManifest) refuse('Codex requires a discoverable plugin manifest.');
    else if (selectedManifest.kind !== 'file' || selectedManifest.parentKind !== 'directory')
      refuse('Codex requires a regular legacy manifest file.');
  }
  if (selectedManifest && (selectedManifest.state !== 'read' || !isJsonRecord(selectedManifest.raw)))
    refuse(`${selectedManifest.source}: manifest must be a readable JSON object.`);
  const raw = isJsonRecord(selectedManifest?.raw) ? selectedManifest.raw : {};
  if (selectedManifest && !isPluginName(raw.name)) refuse(`${selectedManifest.source}: manifest has no usable plugin name.`);
  const declarations = (kind, fallback) => {
    const value = raw[kind];
    const defaults = [{ file: fallback, optional: true }];
    const inline = (v, index) => ({
      raw: v,
      source: `${plan.layout}#${kind}[${index}]`,
      numberTokens: inlineNumbers(selectedManifest?.numberTokens ?? {}, Array.isArray(value) ? [kind, index] : [kind]),
    });
    const validHook = (v, index) => codexHookFile(v, inline(v, index).numberTokens);
    if (family === 'claude') {
      if (value === undefined) return defaults;
      const declared = (Array.isArray(value) ? value : [value])
        .map((entry, index) => {
          if (isJsonRecord(entry)) return inline(entry, index);
          const file = pluginRelative(entry) ? path.normalize(entry) : null;
          if (file) return { file, optional: false };
          refuse(`${plan.layout}#${kind}: unsupported source declaration.`);
          return null;
        })
        .filter(Boolean);
      return [...defaults, ...declared];
    }
    let declared = [];
    if (kind === 'mcpServers') {
      const file = codexPath(value);
      if (file) declared = [{ file, optional: false }];
      else if (isJsonRecord(value)) declared = [inline(value, 0)];
    } else if (typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
      declared = (Array.isArray(value) ? value : [value])
        .map(codexPath)
        .filter(Boolean)
        .map((file) => ({ file, optional: false }));
    } else if (validHook(value, 0)) declared = [inline(value, 0)];
    else if (Array.isArray(value) && value.length && value.every(validHook)) declared = value.map(inline);
    if (declared.length) {
      plan.ignored.push(`${fallback}: ignored because ${plan.layout} declares ${kind}.`);
      return declared;
    }
    return defaults;
  };
  for (const [kind, fallback] of [
    ['mcpServers', DEFAULT_MCP],
    ['hooks', DEFAULT_HOOKS],
  ]) {
    for (const entry of declarations(kind, fallback)) {
      const source = entry.file
        ? await inv.read(entry.file)
        : { source: entry.source, state: 'read', raw: entry.raw, numberTokens: entry.numberTokens };
      plan.sources.push({ ...source, component: kind });
      if (source.state === 'absent' && entry.optional) continue;
      if (source.state !== 'read' || !isJsonRecord(source.raw)) {
        refuse(`${source.source}: selected ${kind} source must be a readable JSON object.`);
        continue;
      }
      if (kind === 'mcpServers') {
        const map = Object.hasOwn(source.raw, 'mcpServers') ? source.raw.mcpServers : source.raw;
        if (!isJsonRecord(map) || Object.values(map).some((server) => !isJsonRecord(server)))
          refuse(`${source.source}: MCP server configurations must be JSON objects.`);
        const mcp = normalizeMcpServers(source.raw, root);
        plan.mcpServers = Object.fromEntries([...Object.entries(plan.mcpServers), ...Object.entries(mcp.servers)]);
      } else {
        const events = family === 'claude' && !entry.file ? source.raw : source.raw.hooks;
        if (
          (family === 'codex' && !codexHookFile(source.raw, source.numberTokens)) ||
          (family === 'claude' && (!isJsonRecord(events) || Object.values(events).some((groups) => !Array.isArray(groups))))
        )
          refuse(`${source.source}: unsupported hook configuration.`);
        plan.hooks.push(...normalizeHooks(source.raw, root));
        for (const [event, groups] of Object.entries(isJsonRecord(events) ? events : {})) {
          if (Array.isArray(groups) && groups.length && (family === 'claude' || HOOK_EVENTS.includes(event))) plan.hookEvents.push(event);
        }
      }
    }
  }
  return plan;
}

/** ACP deliberately retains the old selected normalized payload; source records explain its difference. */
async function readExecution(root, spec, selections, inv) {
  const claude = await nativePlan('claude', inv, root);
  const codex = await nativePlan('codex', inv, root);
  const codexManifest = codex.sources.find((source) => source.component === 'manifest' && source.source === codex.layout);
  if (isJsonRecord(codexManifest?.raw) && isPluginName(codexManifest.raw.name) && codexManifest.raw.name !== spec.name) {
    codex.state = 'withheld';
    codex.reasons.push('The Codex-selected manifest uses a different plugin name; this native identity cannot be delivered safely.');
  }
  /** @type {import('../../shared/plugins/manifest.mjs').PluginExecutionPlan} */
  const acp = {
    contract: 'mopilot-selected-mcp-v1',
    layout: spec.layout,
    state: 'supported',
    reasons: [],
    sources: [],
    ignored: ['Hooks are not delivered to ACP.'],
    mcpServers: spec.mcpServers,
    hooks: [],
    hookEvents: [],
  };
  for (const entry of selections.mcpServers.entries) {
    const source = 'file' in entry ? await inv.read(entry.file) : { source: `${spec.layout}#mcpServers`, state: 'read', raw: entry.inline };
    acp.sources.push({ ...source, component: 'mcpServers' });
    if (
      (source.state !== 'read' && !(source.state === 'absent' && selections.mcpServers.optional)) ||
      (source.state === 'read' && !isJsonRecord(source.raw))
    ) {
      acp.state = 'withheld';
      acp.reasons.push(`${source.source}: selected MCP source must be a readable JSON object.`);
    }
  }
  if (selections.projectionError) {
    claude.state = 'withheld';
    claude.reasons.push(`The Claude manifest cannot be accounted for: ${selections.projectionError}`);
    acp.state = 'withheld';
    acp.mcpServers = {};
    acp.reasons.push(`The original ACP manifest cannot be read: ${selections.projectionError}`);
  }
  acp.unavailable = [...new Set([...claude.hookEvents, ...codex.hookEvents])].map((name) => ({
    kind: 'hooks',
    name,
    why: 'plugin.hooksNotOnBasic',
  }));
  return { version: 1, inventory: [...inv.files.values()], plans: { claude, codex, acp } };
}

module.exports = { readExecution, sourceInventory };
