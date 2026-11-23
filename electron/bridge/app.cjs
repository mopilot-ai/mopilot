// window.native.app: the app itself: info, notices, diagnostics, notifications, theme and commands (electron/app/ipc/app.cjs).
const { invoke, send, on, call } = require('./spec.cjs');

module.exports = {
  ready: call('app:ready'),
  info: invoke('app:info'),
  // the interface language and its catalog, read before the app's modules load (src/launch.ts)
  language: invoke('app:language'),
  openNotices: invoke('app:openNotices'),
  diagnostics: invoke('app:diagnostics'),
  // a bug report: build a scrubbed local file, or rebuild and send it to MoPilot (electron/app/ipc/bug.cjs)
  bug: { preview: invoke('bug:preview', 1), submit: invoke('bug:submit', 1) },
  // an error the renderer ignored on purpose, kept with main's for Copy diagnostics (src/lib/ignored.ts)
  ignored: send('app:ignored', 2),
  notify: invoke('app:notify', 3),
  viewing: invoke('app:viewing', 1),
  unsent: invoke('app:unsent', 1),
  setTheme: invoke('app:setTheme', 1),
  setTray: invoke('app:setTray', 1),
  icon: invoke('app:icon', 1),
  installed: invoke('app:installed'),
  // the macOS Quick Actions in ~/Library/Services, installed only by the Settings switch (electron/platform/quickActionsWiring.cjs)
  quickActions: { status: call('quickActions:status'), set: call('quickActions:set') },
  onCommand: on('app:command'),
  onThemeChanged: on('theme:changed'),
};
