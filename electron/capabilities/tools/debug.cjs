// A tool for tests: echoes its text back. main registers it only when SAGE_DEBUG_TOOLS=1.
module.exports = {
  /** @type {import('../contract/registry.cjs').ToolDef} */
  echo: {
    name: 'sage_debug_echo',
    description: 'Echo the given text back (tests only).',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    policy: 'observe',
    handler: ({ text }) => `echo: ${text}`,
  },
};
