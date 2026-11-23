// window.native.projects: the project list and importing Codex projects (electron/platform/projects.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('projects:list'),
  canonicalPaths: invoke('projects:canonicalPaths', 1),
  folderAvailability: invoke('projects:folderAvailability', 1),
  add: invoke('projects:add', 1),
  linkCodex: invoke('projects:linkCodex', 2),
  remove: invoke('projects:remove', 1),
  rename: invoke('projects:rename', 2),
  move: invoke('projects:move', 2),
  importCodex: invoke('projects:importCodex', 1),
  importFailed: invoke('projects:importFailed', 1),
  importCodexBackground: invoke('projects:importCodexBackground'),
  onChanged: on('projects:changed'),
};
