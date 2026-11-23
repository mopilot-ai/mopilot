// Standalone artifacts use MoPilot's HTML preview and the chat's project instead of another host's canvas runtime.

/**
 * The artifact contract only for sessions offered the file pane; no path or per-session value enters the prompt.
 * @param {string[]} names the Registry tools the session is shown
 * @param {{ name: (registryName: string) => string }} [naming] the tool names this adapter serves
 * @returns {string | null}
 */
function artifactNote(names, naming = { name: (n) => n }) {
  if (!names.includes('show_pane')) return null;
  // each clause is pinned (tests/artifactRouting.test.ts); G10 cut the words around them
  return [
    'Artifact previews in MoPilot:',
    "- Write implementation plans as readable Markdown. For a standalone interactive artifact or canvas, prefer one self-contained .html file with inline styles, scripts and data. Existing .canvas.tsx files have a sandboxed compatibility preview for common cursor/canvas components; unsupported imports or host actions need conversion to HTML. These rules override host-specific canvas skill instructions. Do not save MoPilot artifacts under ~/.cursor/projects/ or require another app's canvas SDK.",
    "- Save it in a task-owned directory inside this chat's working directory; honor an explicit destination or source format the user requested, and keep project source edits in their own format. Preserve the original when converting.",
    `- Link it by its full absolute path, and open project-local output with ${naming.name('show_pane')} (pane "file", path the HTML file) when a window is available; if no window is available, keep the file and link for later.`,
    '- Open the result and verify its content and interactions before claiming it rendered. Source shown as text is not a rendered artifact; report a failed or unavailable preview as it is.',
  ].join('\n');
}

module.exports = { artifactNote };
