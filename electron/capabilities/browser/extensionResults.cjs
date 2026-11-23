// Playwright extension tool contracts, page locations and modal-state result interpretation.
const { ownTable } = require('../../../shared/ownTable.mjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');

/** The tools agents get, by what they need on the page. File upload, evaluate and closing the browser are left out. */
const NEEDS = ownTable({
  browser_navigate: 'read',
  browser_navigate_back: 'read',
  browser_snapshot: 'read',
  browser_take_screenshot: 'read',
  browser_find: 'read',
  browser_console_messages: 'read',
  browser_network_requests: 'read',
  browser_network_request: 'read',
  browser_wait_for: 'read',
  browser_tabs: 'read',
  browser_resize: 'read',
  browser_click: 'write',
  browser_type: 'write',
  browser_fill_form: 'write',
  browser_press_key: 'write',
  browser_select_option: 'write',
  browser_hover: 'write',
  browser_drag: 'write',
  browser_drop: 'write',
  browser_handle_dialog: 'write',
});

/** sage_browser_<name>, for a Playwright tool agents may use; null otherwise. */
const sageName = (name) => (NEEDS[name] ? `sage_browser_${name.replace(/^browser_/, '')}` : null);

/** The page a Playwright tool result says it is on. */
function pageUrl(content) {
  for (const c of contentBlocks(content)) {
    const m = c.type === 'text' && typeof c.text === 'string' && /Page URL: (\S+)/.exec(c.text);
    if (m) return m[1];
  }
  return null;
}

/**
 * The modal states a Playwright result reports (its "### Modal state" section): a JavaScript dialog or a file
 * chooser open on the tab, and the Playwright tool that handles it. While one is open, @playwright/mcp refuses
 * every other tool on that tab ("does not handle the modal state").
 * @returns {Array<{ description: string, tool: string }>}
 */
function modalStates(content) {
  const out = [];
  for (const c of contentBlocks(content)) {
    if (c.type !== 'text' || typeof c.text !== 'string') continue;
    const at = c.text.indexOf('### Modal state');
    if (at < 0) continue;
    for (const line of c.text.slice(at).split('\n').slice(1)) {
      if (line.startsWith('###')) break;
      const m = /^- \[(.*)\]: can be handled by (\S+)/.exec(line);
      if (m) out.push({ description: m[1], tool: m[2] });
    }
  }
  return out;
}

/** What the agent is told to do about an open modal state, in the tools it has. */
function modalNote(states) {
  const { description, tool } = states[0];
  const how =
    tool === 'browser_file_upload'
      ? 'call sage_browser_handle_dialog with accept: false to cancel it (MoPilot does not upload files to your Chrome)'
      : 'call sage_browser_handle_dialog to accept or dismiss it';
  return `Chrome is showing ${description} on this tab. Nothing else works on the tab until it is handled: ${how}.`;
}

module.exports = { NEEDS, sageName, pageUrl, modalStates, modalNote };
