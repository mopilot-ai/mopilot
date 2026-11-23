// Browser, display and app-scoped tool labels shared by every harness.
import { appLabel } from '../appNames';
import {
  q,
  quoted,
  hostOf,
  macKeys,
  clickedName,
  recordField,
  recordApp,
  alwaysAllowed,
  CLICK,
  seconds,
  type ToolArgs,
  type Tenses,
} from './common';
import { pluralize } from '../format';

function browserAction(action: string, a: ToolArgs, result: string): Tenses {
  const name = clickedName(result);
  const target = name ? quoted(name) : a.ref || (a.target as { ref?: unknown } | null | undefined)?.ref ? 'an element' : 'the page';
  if (CLICK[action]) return [`${CLICK[action][0]} ${target}`, `${CLICK[action][1]} ${target}`];
  switch (action) {
    case 'type': {
      const n = typeof a.text === 'string' ? [...a.text].length : 0;
      return [`Typed ${pluralize(n, 'character')}`, `Typing ${pluralize(n, 'character')}`];
    }
    case 'key':
      return [`Pressed ${q(a.text, 40)}`, `Pressing ${q(a.text, 40)}`];
    case 'scroll':
      return [`Scrolled ${a.scroll_direction || 'down'}`, `Scrolling ${a.scroll_direction || 'down'}`];
    case 'scroll_to':
      return ['Scrolled to an element', 'Scrolling to an element'];
    case 'hover':
      return [`Hovered over ${target}`, `Hovering over ${target}`];
    case 'left_click_drag':
      return ['Dragged on the page', 'Dragging on the page'];
    case 'screenshot':
      return ['Took a screenshot', 'Taking a screenshot'];
    case 'zoom':
      return ['Zoomed in on the page', 'Zooming in on the page'];
    case 'wait':
      return [`Waited ${seconds(a.duration)}`, `Waiting ${seconds(a.duration)}`];
    default:
      return ['Used the browser', 'Using the browser'];
  }
}

export function browserStep(name: string, a: ToolArgs, result: string): Tenses {
  switch (name) {
    case 'navigate': {
      const url = String(a.url ?? '');
      if (url === 'back') return ['Went back', 'Going back'];
      if (url === 'forward') return ['Went forward', 'Going forward'];
      if (url === 'reload') return ['Reloaded the page', 'Reloading the page'];
      if (url === 'stop') return ['Stopped loading the page', 'Stopping loading the page'];
      return [`Opened ${hostOf(url)}`, `Opening ${hostOf(url)}`];
    }
    case 'navigate_back':
      return ['Went back', 'Going back'];
    case 'tabs_context':
      return ['Checked the open tabs', 'Checking the open tabs'];
    case 'tabs_create':
      return a.url
        ? [`Opened ${hostOf(a.url)} in a new tab`, `Opening ${hostOf(a.url)} in a new tab`]
        : ['Opened a new tab', 'Opening a new tab'];
    case 'tabs_close':
      return ['Closed a tab', 'Closing a tab'];
    case 'tabs_select':
      return ['Switched tabs', 'Switching tabs'];
    case 'tabs_mark':
      return ['Kept a tab open for you', 'Keeping a tab open for you'];
    case 'request_signin':
      return ['Handed the tab to you', 'Handing the tab to you'];
    case 'tabs':
      return ['Managed tabs', 'Managing tabs'];
    case 'read_page':
    case 'snapshot':
      return ['Read the page', 'Reading the page'];
    case 'find':
      return [`Looked for ${quoted(a.query)}`, `Looking for ${quoted(a.query)}`];
    case 'get_page_text':
      return ['Read the page text', 'Reading the page text'];
    // the tools a page publishes (WebMCP, #3571 G6)
    case 'page_tools':
      return ["Read the page's tools", "Reading the page's tools"];
    case 'page_tool':
      return [`Ran the page's ${quoted(a.name)} tool`, `Running the page's ${quoted(a.name)} tool`];
    case 'history_search':
      return a.query
        ? [`Searched your history for ${quoted(a.query)}`, `Searching your history for ${quoted(a.query)}`]
        : ['Looked at your recent history', 'Looking at your recent history'];
    case 'bookmarks_search':
      return a.query
        ? [`Searched your bookmarks for ${quoted(a.query)}`, `Searching your bookmarks for ${quoted(a.query)}`]
        : ['Looked through your bookmarks', 'Looking through your bookmarks'];
    case 'computer':
      return browserAction(String(a.action ?? ''), a, result);
    case 'click': {
      const what = a.element ? quoted(a.element) : 'the page';
      return a.doubleClick ? [`Double-clicked ${what}`, `Double-clicking ${what}`] : [`Clicked ${what}`, `Clicking ${what}`];
    }
    case 'hover':
      return [`Hovered over ${a.element ? quoted(a.element) : 'the page'}`, `Hovering over ${a.element ? quoted(a.element) : 'the page'}`];
    case 'type': {
      const n = typeof a.text === 'string' ? [...a.text].length : 0;
      const into = a.element ? ` into ${quoted(a.element)}` : '';
      return [`Typed ${pluralize(n, 'character')}${into}`, `Typing ${pluralize(n, 'character')}${into}`];
    }
    case 'press_key':
      return [`Pressed ${q(a.key, 40)}`, `Pressing ${q(a.key, 40)}`];
    case 'select_option':
      return [
        `Chose an option${a.element ? ` in ${quoted(a.element)}` : ''}`,
        `Choosing an option${a.element ? ` in ${quoted(a.element)}` : ''}`,
      ];
    case 'form_input':
    case 'fill_form': {
      const n = Array.isArray(a.fields) ? a.fields.length : 0;
      return n
        ? [`Filled ${pluralize(n, 'field')}`, `Filling ${pluralize(n, 'field')}`]
        : ['Filled in a form field', 'Filling in a form field'];
    }
    case 'take_screenshot':
      return ['Took a screenshot', 'Taking a screenshot'];
    case 'save_screenshot':
      return ['Saved a screenshot to upload', 'Saving a screenshot to upload'];
    case 'javascript_exec':
    case 'evaluate':
      return ['Ran JavaScript on the page', 'Running JavaScript on the page'];
    case 'read_console_messages':
    case 'console_messages':
      return ['Read the console', 'Reading the console'];
    case 'read_network_requests':
    case 'network_requests':
      return ['Read network requests', 'Reading network requests'];
    // the devtools group (electron/capabilities/browser/devtools/tools.cjs)
    case 'vitals':
      return ['Measured the page’s Web Vitals', 'Measuring the page’s Web Vitals'];
    case 'accessibility_audit':
      return ['Audited the page’s accessibility', 'Auditing the page’s accessibility'];
    case 'perf_trace':
      return a.action === 'start'
        ? ['Started a performance trace', 'Starting a performance trace']
        : ['Saved a performance trace', 'Saving a performance trace'];
    case 'har':
      return a.action === 'start'
        ? ['Started recording network traffic', 'Starting to record network traffic']
        : ['Saved the network traffic', 'Saving the network traffic'];
    case 'record':
      return a.action === 'start'
        ? ['Started recording a video', 'Starting to record a video']
        : ['Saved a video of the page', 'Saving a video of the page'];
    case 'react':
      return a.action === 'renders_start'
        ? ['Started counting React renders', 'Starting to count React renders']
        : a.action === 'renders_stop'
          ? ['Counted React renders', 'Counting React renders']
          : ['Inspected React components', 'Inspecting React components'];
    case 'resize_window':
    case 'resize': {
      const size = a.preset ? `${a.preset} size` : a.width && a.height ? `${a.width}×${a.height}` : 'a new size';
      return [`Resized the page to ${size}`, `Resizing the page to ${size}`];
    }
    case 'handle_dialog':
      return a.accept ? ['Accepted a dialog', 'Accepting a dialog'] : ['Dismissed a dialog', 'Dismissing a dialog'];
    case 'file_upload': {
      const n = (Array.isArray(a.paths) ? a.paths.length : 0) + (Array.isArray(a.screenshots) ? a.screenshots.length : 0) || 1;
      return [`Uploaded ${pluralize(n, 'file')}`, `Uploading ${pluralize(n, 'file')}`];
    }
    case 'wait_for':
      return ['Waited for the page', 'Waiting for the page'];
    case 'close':
      return ['Closed the browser', 'Closing the browser'];
    case 'batch': {
      const list = Array.isArray(a.actions) ? a.actions : [];
      // a batch of form inputs (Claude in Chrome's browser_batch) is one fill of several fields
      if (list.length && list.every((x: { name?: unknown } | null) => /(?:^|_)(?:form_input|fill_form)$/.test(String(x?.name ?? ''))))
        return [`Filled ${pluralize(list.length, 'field')}`, `Filling ${pluralize(list.length, 'field')}`];
      return [`Ran ${pluralize(list.length, 'browser action')}`, `Running ${pluralize(list.length, 'browser action')}`];
    }
    // Claude in Chrome's own tools beyond the shared set
    case 'upload_image':
      return ['Uploaded an image', 'Uploading an image'];
    case 'gif_creator': {
      const act = String(a.action ?? '');
      if (act === 'start_recording') return ['Started recording the page', 'Starting to record the page'];
      if (act === 'stop_recording') return ['Stopped recording the page', 'Stopping the recording'];
      if (act === 'export') return ['Saved a recording of the page', 'Saving a recording of the page'];
      return ['Recorded the page', 'Recording the page'];
    }
    case 'shortcuts_list':
      return ['Checked the browser shortcuts', 'Checking the browser shortcuts'];
    case 'shortcuts_execute':
      return ['Ran a browser shortcut', 'Running a browser shortcut'];
    case 'list_connected_browsers':
      return ['Checked the connected browsers', 'Checking the connected browsers'];
    case 'select_browser':
    case 'switch_browser':
      return ['Switched browsers', 'Switching browsers'];
    case 'request_credentials':
      return ['Asked for sign-in details', 'Asking for sign-in details'];
    case 'list_granted_credentials':
      return ['Checked the sign-ins it may use', 'Checking the sign-ins it may use'];
    case 'autofill_credential':
      return ['Filled in a saved sign-in', 'Filling in a saved sign-in'];
    case 'release_credentials':
      return ['Let go of sign-in details', 'Letting go of sign-in details'];
    case 'enter_verification_code':
      return ['Entered a verification code', 'Entering a verification code'];
    case 'preview_start':
      return ['Started a preview', 'Starting a preview'];
    case 'preview_list':
      return ['Checked the previews', 'Checking the previews'];
    case 'preview_logs':
      return ['Read the preview logs', 'Reading the preview logs'];
    case 'preview_stop':
      return ['Stopped a preview', 'Stopping a preview'];
    default:
      return ['Used the browser', 'Using the browser'];
  }
}

export function desktopStep(name: string, a: ToolArgs, result: string, appHint: string | null = null): Tenses {
  const named = appHint || recordApp(result);
  const app = named ? appLabel(named) : null;
  const inApp = app ? ` in ${app}` : '';
  if (CLICK[name]) return [`${CLICK[name][0]}${inApp || ' on the screen'}`, `${CLICK[name][1]}${inApp || ' on the screen'}`];
  switch (name) {
    case 'request_access': {
      const apps = Array.isArray(a.apps) ? a.apps.map((x: unknown) => q(x, 30)).filter(Boolean) : [];
      const list = apps.length > 3 ? `${apps.slice(0, 3).join(', ')} and ${apps.length - 3} more` : apps.join(', ');
      // apps the user chose "Always allow" for are granted without a card: the line says so
      const always = alwaysAllowed(result);
      if (always.length) {
        const named = always.length > 3 ? `${always.slice(0, 3).join(', ')} and ${always.length - 3} more` : always.join(', ');
        const line = `Using ${named} (always allowed)${apps.length > always.length ? '; asked for the rest' : ''}`;
        return [line, line];
      }
      return list ? [`Asked to use ${list}`, `Asking to use ${list}`] : ['Asked to use apps', 'Asking to use apps'];
    }
    case 'list_granted_applications':
      return ['Checked which apps it may use', 'Checking which apps it may use'];
    case 'open_application': {
      const what = typeof a.app === 'string' && a.app.trim() ? q(appLabel(a.app), 40) : 'an app';
      return [`Opened ${what}`, `Opening ${what}`];
    }
    case 'switch_display':
      return a.display == null || a.display === ''
        ? ['Listed the displays', 'Listing the displays']
        : ['Switched displays', 'Switching displays'];
    case 'read_clipboard':
      return ['Read the clipboard', 'Reading the clipboard'];
    case 'write_clipboard':
      return ['Copied text to the clipboard', 'Copying text to the clipboard'];
    case 'screenshot':
      return [`Captured screen${inApp}`, `Capturing screen${inApp}`];
    case 'zoom':
      return ['Zoomed in on the screen', 'Zooming in on the screen'];
    case 'mouse_move':
      return ['Moved the pointer', 'Moving the pointer'];
    case 'left_click_drag':
      return [`Dragged${inApp || ' on the screen'}`, `Dragging${inApp || ' on the screen'}`];
    case 'left_mouse_down':
      return [`Pressed the mouse button${inApp}`, `Pressing the mouse button${inApp}`];
    case 'left_mouse_up':
      return [`Let go of the mouse button${inApp}`, `Letting go of the mouse button${inApp}`];
    case 'scroll':
      return [`Scrolled ${a.scroll_direction || 'down'}${inApp}`, `Scrolling ${a.scroll_direction || 'down'}${inApp}`];
    case 'type': {
      const n = typeof a.text === 'string' ? [...a.text].length : 0;
      return [`Typed ${pluralize(n, 'character')}${inApp}`, `Typing ${pluralize(n, 'character')}${inApp}`];
    }
    case 'key':
      return [`Pressed ${q(macKeys(String(a.text ?? '')), 40)}${inApp}`, `Pressing ${q(macKeys(String(a.text ?? '')), 40)}${inApp}`];
    case 'hold_key':
      return [`Held ${q(a.text, 40)} for ${seconds(a.duration)}`, `Holding ${q(a.text, 40)} for ${seconds(a.duration)}`];
    case 'wait':
      return [`Waited ${seconds(a.duration)}`, `Waiting ${seconds(a.duration)}`];
    case 'cursor_position':
      return ['Checked the pointer position', 'Checking the pointer position'];
    case 'batch': {
      const n = Array.isArray(a.actions) ? a.actions.length : 0;
      return [`Ran ${pluralize(n, 'desktop action')}`, `Running ${pluralize(n, 'desktop action')}`];
    }
    // the per-app tools of the Claude desktop computer-use server (app_focus, app_menu, …)
    case 'focus':
      return [`Switched to ${app || 'an app'}`, `Switching to ${app || 'an app'}`];
    case 'menu':
      return [`Used a menu${inApp}`, `Using a menu${inApp}`];
    case 'list_windows':
      return [`Checked the windows${inApp}`, `Checking the windows${inApp}`];
    case 'ax_find':
      return [`Looked for an element${inApp}`, `Looking for an element${inApp}`];
    case 'bring_to_current_space':
      return [`Brought ${app || 'an app'} to this space`, `Bringing ${app || 'an app'} to this space`];
    case 'release':
    case 'release_full_control':
      return [`Let go of ${app || 'your computer'}`, `Letting go of ${app || 'your computer'}`];
    case 'list_apps':
      return ['Checked the open apps', 'Checking the open apps'];
    case 'request_full_control':
      return ['Asked for full control', 'Asking for full control'];
    case 'request_teach_access':
    case 'teach_step':
    case 'teach_batch':
      return ['Showed you around', 'Showing you around'];
    default:
      return ['Used your computer', 'Using your computer'];
  }
}

/**
 * The app a background (app-scoped) call acted in: its action record, its screenshot's header
 * ("Window 5 "Doc" of TextEdit: …"), or the bundle id it named ("com.apple.TextEdit" → TextEdit), as a person reads it (appNames.ts).
 */
export function appOf(a: ToolArgs, result: string): string | null {
  const shown = recordApp(result) ?? /^Window \d+ ".*" of (.+?): coordinate frame/m.exec(result)?.[1];
  if (shown) return q(appLabel(shown), 40);
  const id = typeof a.app === 'string' ? a.app.trim() : '';
  return id ? q(appLabel(id), 40) : null;
}

/** MoPilot's background tools (desktop_app_*, app_* on mopilot_computer): what they did, in which app. */
export function appStep(name: string, a: ToolArgs, result: string): Tenses {
  const app = appOf(a, result);
  const inApp = app ? ` in ${app}` : '';
  switch (name) {
    case 'screenshot':
      return [`Captured screen${inApp}`, `Capturing screen${inApp}`];
    case 'zoom':
      return [`Zoomed in on ${app ?? 'an app'}`, `Zooming in on ${app ?? 'an app'}`];
    case 'list_windows':
      return [`Checked the windows${inApp}`, `Checking the windows${inApp}`];
    case 'ax_find': {
      const what = typeof a.title_contains === 'string' && a.title_contains.trim() ? quoted(a.title_contains) : 'an element';
      return [`Looked for ${what}${inApp}`, `Looking for ${what}${inApp}`];
    }
    case 'click': {
      const label = recordField(result, 'label');
      const verb = Number(a.count) === 2 ? CLICK.double_click : Number(a.count) === 3 ? CLICK.triple_click : CLICK.left_click;
      const rest = `${label ? ` ${quoted(label)}` : ''}${inApp}`;
      return [`${verb[0]}${rest}`, `${verb[1]}${rest}`];
    }
    case 'type': {
      const n = typeof a.text === 'string' ? [...a.text].length : 0;
      return [`Typed ${pluralize(n, 'character')}${inApp}`, `Typing ${pluralize(n, 'character')}${inApp}`];
    }
    case 'key':
      return [`Pressed ${q(macKeys(String(a.combo ?? '')), 40)}${inApp}`, `Pressing ${q(macKeys(String(a.combo ?? '')), 40)}${inApp}`];
    case 'scroll': {
      const dir = Number(a.dy) < 0 ? 'up' : 'down';
      return [`Scrolled ${dir}${inApp}`, `Scrolling ${dir}${inApp}`];
    }
    case 'drag':
      return [`Dragged${inApp}`, `Dragging${inApp}`];
    case 'menu': {
      if (Array.isArray(a.path) && a.path.length) {
        const path = a.path.map((x: unknown) => q(x, 30)).join(' › ');
        return [`Chose ${path}${inApp}`, `Choosing ${path}${inApp}`];
      }
      const list = Array.isArray(a.list)
        ? a.list.map((x: unknown) => q(x, 30)).join(' › ')
        : typeof a.list === 'string'
          ? q(a.list, 30)
          : '';
      return list
        ? [`Checked the ${list} menu${inApp}`, `Checking the ${list} menu${inApp}`]
        : [`Checked the menus${inApp}`, `Checking the menus${inApp}`];
    }
    case 'focus':
      return [`Moved the focus${inApp}`, `Moving the focus${inApp}`];
    case 'file_panel': {
      // a Save or Open panel's folder, named by its last component ("~/Documents/Reports" → "Reports")
      const folder = typeof a.folder === 'string' ? a.folder.trim() : '';
      const name = folder.replace(/\/+$/, '').split('/').pop() || folder;
      const what = name ? `the folder ${quoted(name)}` : 'a folder';
      return [`Chose ${what}${inApp}`, `Choosing ${what}${inApp}`];
    }
    case 'bring_to_current_space':
      return [`Brought ${app ?? 'an app'} to this space`, `Bringing ${app ?? 'an app'} to this space`];
    case 'batch': {
      const n = Array.isArray(a.actions) ? a.actions.length : 0;
      return [`Ran ${pluralize(n, 'action')}${inApp}`, `Running ${pluralize(n, 'action')}${inApp}`];
    }
    case 'release':
      return [`Let go of ${app ?? 'the apps'}`, `Letting go of ${app ?? 'the apps'}`];
    default:
      return [`Used ${app ?? 'an app'}`, `Using ${app ?? 'an app'}`];
  }
}
