// What design_quickstart tells a model before it makes a design, a slide deck or a design system as files in the
// project: the folder layout, the markers and the design.json record, where to take colors and type from, and what to
// call next. One text for every harness; tool names come in as the session sees them.

const TYPES = ['design', 'slides', 'design-system'];

/**
 * @param {'design' | 'slides' | 'design-system'} type
 * @param {{ systemsDir: string, designsDir: string, slug: string, systemPath: string | null, name: (n: string) => string }} o
 *   systemPath: the project-relative folder of the design system to build with, or null for none
 * @returns {string}
 */
function quickstart(type, o) {
  const check = o.name('design_check');
  const compile = o.name('design_system_compile');
  const read = o.name('design_system_read');
  if (type === 'design-system') {
    const at = `${o.systemsDir}/${o.slug}`;
    return [
      `Make the design system as files in ${at}/ with your own file tools:`,
      '- README.md: a "# Name" title; what the system is for and how to use it; an "## Index" listing every card by its path (preview/<group>/<name>.html).',
      '- tokens.json: the exact values as DTCG groups ({"color": {"accent": {"$value": "#3b5bdb", "$type": "color"}}}): colors (light and dark), font families, type sizes and weights, spacing, radii, shadows, motion.',
      '- api/tokens.md: the palette, type and fonts in prose: which token to use for what.',
      '- preview/<group>/<name>.html: one self-contained page per card (a component, a color ramp, the type scale). Its FIRST line is exactly <!-- @dsCard group="Components" name="Primary button" viewport="480x200" --> (group is required; name and viewport are optional). Styles come from the tokens: copy them into :root custom properties.',
      '- assets/ and fonts/ for files the cards use; reference them with relative paths.',
      'In a codebase, take the values from what the code already uses (CSS variables, a Tailwind or theme config, component styles) rather than inventing them, and say where each came from in api/tokens.md.',
      `Then call ${compile} to write _ds_manifest.json from the markers (never edit it by hand), and ${check} on ${at} until it reports no problems.`,
    ].join('\n');
  }
  const slides = type === 'slides';
  const at = `${o.designsDir}/${o.slug}`;
  const ds = o.systemPath
    ? [
        `Build it with the design system in ${o.systemPath}/ (its guide is below). Take every color, font, size and radius from its tokens.json; read api/tokens.md and the cards the README indexes with ${read} when you need them. Link its files with relative paths, or copy the tokens into :root custom properties.`,
        `Record it in design.json as "designSystems": [{"path": "${o.systemPath}"}].`,
      ]
    : [
        'There is no design system to build with: choose a small, consistent palette and type scale, and keep them in :root custom properties.',
      ];
  return [
    `Make the ${slides ? 'slide deck' : 'design'} as files in ${at}/ with your own file tools:`,
    slides
      ? '- slides/01-<name>.html, slides/02-<name>.html, …: one self-contained 1920×1080 page per slide, in order.'
      : '- index.html (and more pages if it needs them): self-contained pages; assets/ for images and fonts, by relative paths.',
    `- design.json: {"v": 1, "type": "${slides ? 'slides' : 'design'}", "title": "…", "pages": [${slides ? '"slides/01-<name>.html", …' : '"index.html"'}]${slides ? ', "size": {"width": 1920, "height": 1080}' : ''}, "designSystems": [{"path": "…"}]}.`,
    ...ds,
    'Pages load no remote scripts except from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com or esm.sh, and fonts only from Google Fonts; everything else is inline or in the folder.',
    `Then call ${check} on ${at} and fix what it reports. Tell the user the folder you wrote.`,
  ].join('\n');
}

module.exports = { quickstart, TYPES };
