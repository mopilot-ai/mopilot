// Sparse-AX fixture for control-matrix case CM-D23 (#3571 G7): one Electron window titled "Sparse AX Fixture" whose UI
// is drawn on a canvas, so its accessibility list has almost nothing to act on and desktop_app_screenshot draws numbered
// OCR marks. Clicking the drawn "Compose" button opens a text field; Enter writes what was typed to SPARSE_AX_OUT
// (default /tmp/sparse-ax.txt), which the runner reads back. Launch it from the bundle make-app.sh builds (its own
// bundle id: a plain node_modules/.bin/electron is com.github.Electron, which computer use refuses as MoPilot's own).
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 720,
    height: 480,
    title: 'Sparse AX Fixture',
    // the fixture's renderer writes the typed text itself; it loads only its own local page
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
