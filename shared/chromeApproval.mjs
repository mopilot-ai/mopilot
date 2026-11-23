// Shared chromeApproval approval mappings: the app and main's Chrome panel use the same grants and reply shapes.
import { ownTable } from './ownTable.mjs';
import { prefixUnits } from './textPrefix.mjs';
const SERVER = 'claude-in-chrome';
const PREFIX = `mcp__${SERVER}__`;
function chromeTool(toolName) {
  return typeof toolName === 'string' && toolName.startsWith(PREFIX) && toolName.length > PREFIX.length
    ? toolName.slice(PREFIX.length)
    : null;
}
const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const clip = (s, n = 300) => (s.length > n ? `${prefixUnits(s, n - 1)}\u2026` : s);
function chromeHost(url) {
  const s = str(url)?.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null;
  } catch {
    return null;
  }
}
const CLICKS = ownTable({
  left_click: 'Click',
  right_click: 'Right-click',
  middle_click: 'Middle-click',
  double_click: 'Double-click',
  triple_click: 'Triple-click',
  hover: 'Hover',
});
function target(input) {
  if (str(input.ref)) return { label: 'Element', value: input.ref };
  const c = input.coordinate;
  if (Array.isArray(c) && c.length === 2) return { label: 'Point', value: `${c[0]}, ${c[1]}` };
  return null;
}
function computerAction(input, rows) {
  const a = String(input.action ?? '');
  const at = target(input);
  if (CLICKS[a]) {
    if (at) rows.push(at);
    if (str(input.modifiers)) rows.push({ label: 'Holding', value: input.modifiers });
    return CLICKS[a];
  }
  switch (a) {
    case 'type':
      if (str(input.text)) rows.push({ label: 'Text', value: clip(input.text) });
      return 'Type text';
    case 'key':
      if (str(input.text)) rows.push({ label: 'Keys', value: input.text });
      return 'Press keys';
    case 'scroll':
      if (at) rows.push(at);
      if (str(input.scroll_direction)) rows.push({ label: 'Direction', value: input.scroll_direction });
      return 'Scroll';
    case 'scroll_to':
      if (at) rows.push(at);
      return 'Scroll to an element';
    case 'left_click_drag':
      if (Array.isArray(input.start_coordinate)) rows.push({ label: 'From', value: input.start_coordinate.join(', ') });
      if (at) rows.push({ label: 'To', value: at.value });
      return 'Drag';
    case 'screenshot':
      return 'Take a screenshot';
    case 'zoom':
      return 'Zoom into the page';
    case 'wait':
      return 'Wait';
    default:
      return a ? `Use the browser (${a})` : 'Use the browser';
  }
}
function chromeApproval(toolName, input, knownUrl) {
  const tool = chromeTool(toolName);
  if (!tool) return null;
  const i = input && typeof input === 'object' ? input : {};
  const rows = [];
  let block = null;
  let action;
  let url = null;
  let inTab = true;
  switch (tool) {
    case 'navigate':
      if (i.url === 'back' || i.url === 'forward') action = i.url === 'back' ? 'Go back' : 'Go forward';
      else {
        action = 'Open a page';
        url = i.url;
        inTab = false;
        if (str(i.url)) rows.push({ label: 'URL', value: i.url });
      }
      break;
    case 'computer':
      action = computerAction(i, rows);
      break;
    case 'form_input':
      action = 'Fill in a field';
      if (str(i.ref)) rows.push({ label: 'Element', value: i.ref });
      if (i.value !== void 0) rows.push({ label: 'Value', value: clip(String(i.value)) });
      break;
    case 'find':
      action = 'Find on the page';
      if (str(i.query)) rows.push({ label: 'Looking for', value: i.query });
      break;
    case 'read_page':
    case 'get_page_text':
      action = 'Read the page';
      break;
    case 'javascript_tool':
      action = 'Run JavaScript';
      block = str(i.text);
      break;
    case 'tabs_create_mcp':
      action = 'Open a new tab';
      inTab = false;
      break;
    case 'tabs_close_mcp':
      action = 'Close a tab';
      break;
    case 'tabs_context_mcp':
      action = 'See your open tabs';
      inTab = false;
      break;
    case 'file_upload':
    case 'upload_image':
      action = 'Upload files';
      for (const p of Array.isArray(i.paths) ? i.paths : []) rows.push({ label: 'File', value: String(p) });
      for (const id of [...(Array.isArray(i.screenshots) ? i.screenshots : []), ...(i.imageId ? [i.imageId] : [])])
        rows.push({ label: 'Screenshot', value: String(id) });
      break;
    default: {
      const words = tool.replace(/_mcp$/, '').replace(/_/g, ' ').trim();
      action = words ? words[0].toUpperCase() + words.slice(1) : tool;
      for (const [k, v] of Object.entries(i))
        if (k !== 'tabId' && v !== void 0) rows.push({ label: k, value: clip(typeof v === 'string' ? v : JSON.stringify(v)) });
    }
  }
  const last = inTab ? chromeHost(knownUrl) : null;
  if (last) rows.push({ label: 'Tab', value: `last opened ${last} in this chat` });
  return { action, host: chromeHost(url), rows, block };
}
function chromeTabUrl(items, tabId) {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    if (it?.type !== 'mcpToolCall' || it.server !== SERVER || it.tool !== 'navigate') continue;
    const args = it.arguments ?? {};
    if (tabId !== void 0 && args.tabId !== tabId) continue;
    if (str(args.url) && args.url !== 'back' && args.url !== 'forward') return args.url;
  }
  return null;
}
const WHERE = ownTable({
  session: 'for this session',
  cliArg: 'for this session',
  localSettings: 'in this project',
  projectSettings: 'in this project',
  userSettings: 'in every project',
});
function ruleText(r) {
  const name = r.toolName;
  const tool = chromeTool(name);
  const what = tool ?? (name === `mcp__${SERVER}` ? 'every Claude in Chrome action' : name);
  return str(r.ruleContent) ? `${what} (${r.ruleContent})` : what;
}
function chromeSuggestion(suggestions) {
  if (!Array.isArray(suggestions) || !suggestions.length) return null;
  const rules = suggestions.flatMap((s) =>
    (s?.type === 'addRules' || s?.type === 'replaceRules') && s.behavior === 'allow' && Array.isArray(s.rules)
      ? s.rules.filter((r) => typeof r?.toolName === 'string')
      : [],
  );
  const what = rules.length ? [...new Set(rules.map(ruleText))].join(', ') : 'this';
  const places = suggestions.map((s) => WHERE[s?.destination] ?? 'in your settings');
  const where = places.includes('in every project')
    ? 'in every project'
    : (places.find((p) => p !== 'for this session') ?? 'for this session');
  const label = where === 'for this session' ? `Allow ${what} for this session` : `Always allow ${what} ${where}`;
  const hint =
    where === 'for this session'
      ? "Claude Code keeps this permission until this chat's Claude Code process restarts (after a long idle, an account change or an edited message); then it asks again"
      : `Claude Code keeps this permission ${where}`;
  return { label, hint };
}
export { chromeApproval, chromeHost, chromeSuggestion, chromeTabUrl, chromeTool };
