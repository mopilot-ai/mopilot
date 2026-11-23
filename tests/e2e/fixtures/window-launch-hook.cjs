// Records native startup visibility before allowing the app document to load, without simulating a paint event.
const fs = require('node:fs');
const path = require('node:path');

if (process.type === 'browser') {
  const { BrowserWindow } = require('electron');
  const minimize = BrowserWindow.prototype.minimize;
  const minimizeRequested = new WeakSet();
  BrowserWindow.prototype.minimize = function () {
    minimizeRequested.add(this);
    return minimize.call(this);
  };
  const loadFile = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = function (file, options) {
    const start = performance.now();
    // Delay only navigation: createWindow must finish and present the native window without a renderer frame.
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          fs.writeFileSync(
            path.join(process.env.MOPILOT_USER_DATA, 'window-before-navigation.json'),
            JSON.stringify({
              visible: this.isVisible(),
              minimized: this.isMinimized(),
              minimizeRequested: minimizeRequested.has(this),
              focused: this.isFocused(),
              url: this.webContents.getURL(),
              elapsedMs: performance.now() - start,
            }),
          );
          Promise.resolve(loadFile.call(this, file, options)).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
    });
  };
}
