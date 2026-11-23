// The design tools' names, descriptions and argument schemas (designTools.cjs runs them): what a model on any harness
// is told about working from a design system kept as files in the project.

const SYSTEM_ARG = {
  type: 'string',
  description:
    'Which design system: its id from design_system_list ("project:acme", "user:acme"), its folder name, or its folder path. Omit for the project\'s default.',
};

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const SPECS = {
  design_quickstart: {
    description:
      'Call this first, before making any visual design, UI mock-up, slide deck or design system. It says where in the project to write the files and how to lay them out, and attaches the design system to build with (its guide, tokens and cards). Types: "design" (a page or a set of pages, a mock-up, a visual design), "slides" (a deck), "design-system" (a design system, e.g. one made from this codebase\'s styles).',
    schema: object(
      {
        type: { type: 'string', enum: ['design', 'slides', 'design-system'] },
        title: { type: 'string', description: 'What the user calls it; its folder name comes from it.' },
        design_system: { ...SYSTEM_ARG, description: `${SYSTEM_ARG.description} Pass "none" to build without one.` },
      },
      ['type'],
    ),
  },
  design_system_list: {
    description:
      "List the design systems this chat can use: the project's own (in its design-systems folder) and the user's library, with their ids, folders, card and problem counts, and which one is the project's default.",
    schema: object({}),
  },
  design_system_guide: {
    description:
      "Read a design system's guide: its README, a summary of its tokens, its cards and its problems, with where to read the rest. Use it to answer a question about the user's design system or before styling anything in it.",
    schema: object({ design_system: SYSTEM_ARG }),
  },
  design_system_read: {
    description:
      'Read one text file of a design system by its path in the system\'s folder: "api/tokens.md" (palette, type, fonts), "tokens.json" (exact token values), or a card the guide lists (e.g. "preview/buttons/primary.html").',
    schema: object({ path: { type: 'string' }, design_system: SYSTEM_ARG }, ['path']),
  },
  design_check: {
    description:
      "Check a design system's folder, or a design or deck's folder (the one with design.json), and report its problems: a missing README, tokens or marker, a page design.json lists but the folder lacks, an out-of-date _ds_manifest.json. Writes nothing.",
    schema: object({ path: { type: 'string', description: "The folder, relative to the chat's project folder (or absolute)." } }, ['path']),
  },
  design_system_compile: {
    description:
      "Write a project design system's _ds_manifest.json from the @dsCard markers on its preview pages (the card index tools and the design pane read). Call it after adding, removing or renaming cards. Only a system inside this chat's project folder, and not in a read-only chat.",
    schema: object({ design_system: SYSTEM_ARG }),
  },
};

module.exports = { SPECS };
