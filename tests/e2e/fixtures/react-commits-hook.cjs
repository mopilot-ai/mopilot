// Main-process hook (-r): injects the React commit counter (react-commits-preload.cjs) into every window before its page loads, so a spec can say which components a state broadcast re-renders.
const path = require('node:path');

if (process.type === 'browser') {
  const { app, session } = require('electron');
  app.whenReady().then(() => {
    session.defaultSession.registerPreloadScript({
      type: 'frame',
      id: 'mopilot-react-commits',
      filePath: path.join(__dirname, 'react-commits-preload.cjs'),
    });
  });
}
