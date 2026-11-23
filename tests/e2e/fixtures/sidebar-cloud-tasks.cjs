// Fake Codex Cloud listing for the mixed-project sidebar journey.
const { ipcMain } = require('electron');

const handle = ipcMain.handle;
const calls = {
  'cloud:list': () => ({
    tasks: [{ id: 'task_sidebar', title: 'Cloud sidebar task', environment_id: 'sidebar-env', status: 'ready' }],
  }),
  'cloud:envs': () => ({
    envs: [{ id: 'sidebar-env', label: 'Cloud app', repo: 'example/app', repositories: ['example/app'], pinned: false }],
  }),
  'cloud:status': () => ({ ok: true, text: 'Ready' }),
  'cloud:diff': () => ({ ok: true, diff: '' }),
};
ipcMain.handle = function (channel, listener) {
  return handle.call(this, channel, Object.hasOwn(calls, channel) ? calls[channel] : listener);
};
