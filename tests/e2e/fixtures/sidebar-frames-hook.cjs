// Main-process hook (-r): injects the frame recorder into every window before its page loads, so a launch's sidebar can be read frame by frame.
const path = require('node:path');

if (process.type === 'browser') {
  const { app, session } = require('electron');
  app.whenReady().then(() => {
    session.defaultSession.registerPreloadScript({
      type: 'frame',
      id: 'mopilot-sidebar-frames',
      filePath: path.join(__dirname, 'sidebar-frames-preload.cjs'),
    });
  });
}
