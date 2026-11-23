// The desktop_* tool specs (plain JSON schema any harness can list) and the limits the desktop tools share.
const P = require('../contract/desktopPolicy.cjs');
const { teachSpecs } = require('./desktopTeachSpecs.cjs');

const SETTLE_MS = 400;
const MAX_BATCH = 50;
const MAX_ELEMENTS = 120;
const MAX_REPEAT = 100;
/** As the official computer-use toolset: wait and hold_key take up to 100 seconds. */
const MAX_WAIT_S = 100;
const MAX_HOLD_S = 100;
const TURN_END_MS = 2000;
/** Typed text is read back up to this many times, this far apart, until it reads as it should. */
const VERIFY_TRIES = 3;
const VERIFY_MS = 60;
/** The grant level an app's tier is remembered at ("Always allow"): granted() caps it by the app's kind again. */
const TIER_LEVEL = { read: 'view', click: 'click', full: 'full' };

/* -- specs -------------------------------------------------------- */
const COORD = {
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  description: '[x, y] in pixels of the latest desktop_screenshot',
};
const ELEMENT = {
  type: 'integer',
  minimum: 1,
  description: 'An element [N] listed with the latest desktop_screenshot, instead of coordinate',
};
const MODIFIERS = {
  type: 'string',
  description: 'Modifier keys held during the click, e.g. "cmd" or "shift+alt". Needs a full-control app.',
};
const SCALE = {
  type: 'number',
  minimum: 0.1,
  maximum: 1,
  description: "A smaller, cheaper image: 0.5 is half the width and height. Default 1 (the most the chat's model takes).",
};
/** For a model that can't see images: a vision model finds something on the screenshot by description. */
const FIND = {
  type: 'string',
  description:
    'Only when you cannot see images: something to find on this screenshot by description, e.g. "the blue Send button". A vision model answers with its coordinate (and element) in the reply.',
};
const TEXT_ONLY_DOC =
  ' A model that takes text only gets no image: the elements, the text read from the screen (on-device OCR) and, when a vision model may read the screen, its description; pass find to locate something. In an exec script read an image with image(c) per content item; text(r) prints its bytes.';
const APP = {
  type: 'string',
  description:
    "The granted app (name or bundle id) the keys are for; it is brought to the front first when it isn't. Default: the frontmost granted app, else the app of the latest screenshot.",
};
const RECORD_DOC =
  'Returns an action record: effect (confirmed | mismatch | unverifiable | refused), route (ax | global) and a reason when refused or mismatched. Take a screenshot to see the result. An action that sends, deletes or pays waits for the user to confirm it.';

/** @typedef {import('../contract/registry.cjs').ToolSpec & { schema: { type: string, properties: Record<string, object>, required?: string[] } }} ActionSpec */

/** @returns {ActionSpec} */
const clickSpec = (name, what) => ({
  name: `desktop_${name}`,
  description: `${what} at a point in a granted app. Pass coordinate, or element_index from the latest screenshot. ${RECORD_DOC}`,
  schema: { type: 'object', properties: { coordinate: COORD, element_index: ELEMENT, text: MODIFIERS } },
  policy: 'act',
});

/**
 * The single actions, as desktop_<action> tools and as items of desktop_batch.
 * @type {ActionSpec[]}
 */
const ACTION_SPECS = [
  {
    name: 'desktop_screenshot',
    description:
      "Take a screenshot of the current display. Only windows of apps granted with desktop_request_access appear; everything else is left out. Also lists the frontmost granted app's accessibility elements as [N] (use element_index with click, type and scroll). The image is sized for the chat's model (up to 2000 px on the long edge for high-resolution models such as Claude Opus 4.7 and later, else 1568 px); scale asks for a smaller one. Coordinates for every other desktop tool are pixels of the latest screenshot." +
      TEXT_ONLY_DOC,
    schema: { type: 'object', properties: { scale: SCALE, find: FIND } },
    policy: 'observe',
  },
  {
    name: 'desktop_zoom',
    description:
      "A full-resolution view of part of the screen, for reading small text. region is [x0, y0, x1, y1] in pixels of the latest screenshot. The zoomed image's pixels are not coordinates; keep using the screenshot's.",
    schema: {
      type: 'object',
      properties: {
        region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1]' },
        scale: SCALE,
      },
      required: ['region'],
    },
    policy: 'observe',
  },
  clickSpec('left_click', 'Left click'),
  clickSpec('right_click', 'Right click (needs a full-control app)'),
  clickSpec('middle_click', 'Middle click (needs a full-control app)'),
  clickSpec('double_click', 'Double click'),
  clickSpec('triple_click', 'Triple click (selects a line or paragraph)'),
  {
    name: 'desktop_mouse_move',
    description: `Move the pointer (to hover) in a granted app. ${RECORD_DOC}`,
    schema: { type: 'object', properties: { coordinate: COORD, element_index: ELEMENT } },
    policy: 'act',
  },
  {
    name: 'desktop_left_click_drag',
    description: `Press the left button at start_coordinate (default: where the pointer is), drag to coordinate and let go (needs a full-control app at both ends). ${RECORD_DOC}`,
    schema: { type: 'object', properties: { start_coordinate: COORD, coordinate: COORD }, required: ['coordinate'] },
    policy: 'act',
  },
  {
    name: 'desktop_left_mouse_down',
    description: `Press the left button and keep it down, at coordinate or where the pointer is (needs a full-control app). Move with desktop_mouse_move to drag, then let go with desktop_left_mouse_up; it is let go anyway when the turn ends. ${RECORD_DOC}`,
    schema: { type: 'object', properties: { coordinate: COORD } },
    policy: 'act',
  },
  {
    name: 'desktop_left_mouse_up',
    description: `Let go of the left button, at coordinate or where the pointer is. ${RECORD_DOC}`,
    schema: { type: 'object', properties: { coordinate: COORD } },
    policy: 'act',
  },
  {
    name: 'desktop_scroll',
    description: `Scroll at a point by scroll_amount wheel clicks (default 3). ${RECORD_DOC}`,
    schema: {
      type: 'object',
      properties: {
        coordinate: COORD,
        element_index: ELEMENT,
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['scroll_direction'],
    },
    policy: 'act',
  },
  {
    name: 'desktop_type',
    description: `Type text into the focused field of the frontmost app (needs a full-control app). With element_index, that element is focused first. The text goes in through accessibility where the field allows it, else as keystrokes with the app's autocorrect and smart substitutions off for the call (disable_substitutions: false types like a person, substitutions and all); long or multi-line text is pasted (the user's clipboard comes back when the turn ends). A readable field is read back: effect confirmed when it reads exactly as asked, mismatch when it doesn't. Never types into password fields. ${RECORD_DOC}`,
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        element_index: ELEMENT,
        app: APP,
        disable_substitutions: {
          type: 'boolean',
          description: 'Default true: keep autocorrect, text replacement and smart quotes or dashes from changing the text.',
        },
      },
      required: ['text'],
    },
    policy: 'act',
  },
  {
    name: 'desktop_key',
    description: `Press a key or combination in the frontmost app (needs a full-control app), e.g. "Return", "cmd+a", "shift+tab", "Page_Down"; several separated by spaces run in order. "delete" is backspace; "forwarddelete" deletes forward. Whole-Mac combinations (cmd+q, cmd+tab, cmd+space, ...) need systemKeyCombos from desktop_request_access. ${RECORD_DOC}`,
    schema: {
      type: 'object',
      properties: { text: { type: 'string' }, repeat: { type: 'integer', minimum: 1, maximum: MAX_REPEAT }, app: APP },
      required: ['text'],
    },
    policy: 'act',
  },
  {
    name: 'desktop_hold_key',
    description: `Hold a key or combination down for duration seconds (at most ${MAX_HOLD_S}), then let go. ${RECORD_DOC}`,
    schema: {
      type: 'object',
      properties: { text: { type: 'string' }, duration: { type: 'number', minimum: 0, maximum: MAX_HOLD_S }, app: APP },
      required: ['text', 'duration'],
    },
    policy: 'act',
  },
  {
    name: 'desktop_wait',
    description: `Wait duration seconds (at most ${MAX_WAIT_S}), e.g. for an app to finish loading.`,
    schema: { type: 'object', properties: { duration: { type: 'number', minimum: 0, maximum: MAX_WAIT_S } }, required: ['duration'] },
    policy: 'observe',
  },
  {
    name: 'desktop_cursor_position',
    description: 'Where the pointer is, in pixels of the latest screenshot.',
    schema: { type: 'object', properties: {} },
    policy: 'observe',
  },
];

const ACTIONS = ACTION_SPECS.map((s) => s.name.replace(/^desktop_/, ''));

/** As on the computer_* tools: the model can say an action can't be undone, which only ever adds a confirmation. */
const IRREVERSIBLE = {
  type: 'boolean',
  description: 'Set true when this action sends, deletes, pays or otherwise cannot be undone; the user confirms it first.',
};
for (const s of ACTION_SPECS) if (P.INPUT.has(s.name.replace(/^desktop_/, ''))) s.schema.properties.irreversible = IRREVERSIBLE;

/** One action of desktop_batch (and of a teach step). */
const BATCH_ITEM = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS },
    coordinate: COORD,
    start_coordinate: COORD,
    element_index: ELEMENT,
    text: { type: 'string' },
    scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    scroll_amount: { type: 'integer' },
    repeat: { type: 'integer' },
    duration: { type: 'number' },
    region: { type: 'array', items: { type: 'number' } },
    scale: { type: 'number' },
    app: { type: 'string' },
    disable_substitutions: { type: 'boolean' },
    irreversible: IRREVERSIBLE,
  },
  required: ['action'],
};

/** @type {import('../contract/registry.cjs').ToolSpec[]} */
const SPECS = [
  {
    name: 'desktop_request_access',
    description:
      'Ask the user for access to desktop apps before using any other desktop tool. One card covers the whole list; set screenControl when you will use the screen tools (desktop_left_click, desktop_type, ...) so the same card allows the mouse and keyboard (the background desktop_app_* tools never need it). Grants last for this chat and add up. Browsers are view only (use the browser tools to act on web pages), terminals and IDEs allow left clicks and scrolling only (use the shell tool), everything else allows full control. MoPilot itself, password managers, System Settings and security prompts are never granted. Returns what was granted (with tiers) and denied.',
    schema: {
      type: 'object',
      properties: {
        apps: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 30,
          description: 'App names ("Notes", "Finder") or bundle ids ("com.apple.Notes")',
        },
        reason: { type: 'string', description: 'One sentence the user sees: what you will do in these apps' },
        clipboardRead: { type: 'boolean', description: 'Also ask to read the clipboard (desktop_read_clipboard)' },
        clipboardWrite: { type: 'boolean', description: 'Also ask to write the clipboard (desktop_write_clipboard)' },
        systemKeyCombos: { type: 'boolean', description: 'Also ask to press whole-Mac shortcuts such as cmd+q, cmd+tab or cmd+space' },
        screenControl: {
          type: 'boolean',
          description:
            'Also ask to use the real mouse and keyboard in these apps, for the screen tools (desktop_left_click, desktop_type, ...)',
        },
      },
      required: ['apps', 'reason'],
    },
    policy: 'observe',
  },
  {
    name: 'desktop_list_granted_applications',
    description:
      'The apps this chat may use on the desktop, with their tiers and whether each is running, plus the clipboard and system-shortcut grants.',
    schema: { type: 'object', properties: {} },
    policy: 'observe',
  },
  {
    name: 'desktop_open_application',
    description: 'Open a granted app, or bring it to the front. Works at any tier. Do this before acting in an app that is not frontmost.',
    schema: {
      type: 'object',
      properties: { app: { type: 'string', description: "A granted app's name or bundle id" } },
      required: ['app'],
    },
    policy: 'observe',
  },
  {
    name: 'desktop_switch_display',
    description:
      'List the displays, or (with display) make later screenshots show that one. display is the 1-based number from the list (or, when no number matches, a display id or name).',
    schema: { type: 'object', properties: { display: { type: ['integer', 'string'] } } },
    policy: 'observe',
  },
  ...ACTION_SPECS,
  {
    name: 'desktop_read_clipboard',
    description: "Read the clipboard's text. Needs clipboardRead from desktop_request_access.",
    schema: { type: 'object', properties: {} },
    policy: 'observe',
  },
  {
    name: 'desktop_write_clipboard',
    description:
      "Put text on the clipboard. Needs clipboardWrite from desktop_request_access. The user's own clipboard comes back when the turn ends.",
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    policy: 'act',
  },
  {
    name: 'desktop_batch',
    description: `Run several desktop actions in order, faster than one call each: [{action: "left_click", coordinate: [x, y]}, {action: "type", text: "..."}, {action: "key", text: "Return"}]. Each action is checked like its own tool. Stops at the first failure and ends with one screenshot after the screen settles. Actions: ${ACTIONS.filter((a) => a !== 'screenshot').join(', ')}.`,
    schema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH,
          items: BATCH_ITEM,
        },
      },
      required: ['actions'],
    },
    policy: 'act',
  },
];

SPECS.push(
  ...teachSpecs({
    coord: COORD,
    item: BATCH_ITEM,
    allowed: ACTIONS.filter((a) => a !== 'zoom'),
    maxActions: MAX_BATCH,
  }),
);

const TOOL_NAMES = SPECS.map((s) => s.name);

module.exports = {
  SETTLE_MS,
  MAX_BATCH,
  MAX_ELEMENTS,
  MAX_REPEAT,
  MAX_WAIT_S,
  MAX_HOLD_S,
  TURN_END_MS,
  VERIFY_TRIES,
  VERIFY_MS,
  TIER_LEVEL,
  FIND,
  TEXT_ONLY_DOC,
  ACTION_SPECS,
  ACTIONS,
  SPECS,
  TOOL_NAMES,
};
