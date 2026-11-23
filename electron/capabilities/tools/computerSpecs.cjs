// Harness-neutral computer action and vision tool contracts and names.
const ACT = { type: 'boolean', description: 'Set true when this action sends, deletes, pays or otherwise cannot be undone.' };
const POINT_DOC =
  'x and y are pixels of the latest screenshot (or screen points before any screenshot); or pass element, an id from the element list.';

/** @type {import('../contract/registry.cjs').ToolSpec[]} */
const SPECS = [
  {
    name: 'computer_screenshot',
    description: 'Look at the screen: a screenshot (or, for a model that cannot see images, the element list of the frontmost app).',
    schema: { type: 'object', properties: {} },
    policy: 'observe',
  },
  {
    name: 'computer_elements',
    description: "List the frontmost app's accessibility elements: id, role, label and center. Click one with computer_click {element}.",
    schema: { type: 'object', properties: {} },
    policy: 'observe',
  },
  {
    name: 'computer_click',
    description: `Click in an app. ${POINT_DOC}`,
    schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        element: { type: 'string', description: 'An element id from computer_elements' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        count: { type: 'integer', description: '2 for a double click' },
        irreversible: ACT,
      },
    },
    policy: 'act',
  },
  {
    name: 'computer_type',
    description: 'Type text into the focused field of the frontmost app.',
    schema: { type: 'object', properties: { text: { type: 'string' }, irreversible: ACT }, required: ['text'] },
    policy: 'act',
  },
  {
    name: 'computer_key',
    description: 'Press a key or combination in the frontmost app, e.g. "Return", "cmd+a", "shift+tab".',
    schema: { type: 'object', properties: { key: { type: 'string' }, irreversible: ACT }, required: ['key'] },
    policy: 'act',
  },
  {
    name: 'computer_scroll',
    description: `Scroll at a point. ${POINT_DOC} dy > 0 scrolls down.`,
    schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        element: { type: 'string' },
        dx: { type: 'integer' },
        dy: { type: 'integer' },
      },
    },
    policy: 'act',
  },
];

/** Injected for a text-only model (or one whose input is unknown) when a vision backend can read the screen for it. */
/** @type {import('../contract/registry.cjs').ToolSpec[]} */
const VISION_SPECS = [
  {
    name: 'computer_locate',
    description:
      'Find something on the screen by description with a vision model, for when you cannot see images. Returns its center in pixels of the latest screenshot and the matching element id if any; click it with computer_click {x, y} or {element}.',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to find, e.g. "the blue Send button"' } },
      required: ['query'],
    },
    policy: 'observe',
  },
  {
    name: 'computer_describe',
    description: 'Describe the screen in words with a vision model, for when you cannot see images. Optionally focus on a part of it.',
    schema: {
      type: 'object',
      properties: { region: { type: 'string', description: 'Which part to describe, e.g. "the toolbar" (optional)' } },
    },
    policy: 'observe',
  },
];

const TOOL_NAMES = SPECS.map((s) => s.name);

module.exports = { SPECS, VISION_SPECS, TOOL_NAMES };
