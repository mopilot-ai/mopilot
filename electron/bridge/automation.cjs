// window.native.automation: scheduled tasks: runs, the task store and their apps (electron/platform/automationRun.cjs, automationStore.cjs).
const { invoke, on } = require('./spec.cjs');

/* scheduled tasks: main starts every run (electron/platform/automationRun.cjs), the scheduler's and Run now */
module.exports = {
  run: invoke('automation:run', 1),
  /* where each task lives is main's (electron/platform/automationStore.cjs) */
  list: invoke('automation:list'),
  save: invoke('automation:save', 1),
  update: invoke('automation:update', 2),
  remove: invoke('automation:delete', 1),
  runs: invoke('automation:runs', 1),
  apps: invoke('automation:apps'),
  onChanged: on('automation:changed'),
};
