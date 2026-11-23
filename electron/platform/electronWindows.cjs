// Electron's window list, power-save blocker and power monitor, for the layers above L1 that may not require electron themselves (Mobile Remote's always-on controller, electron/app/alwaysOn.cjs).
const { BrowserWindow, powerSaveBlocker, powerMonitor } = require('electron');

module.exports = { BrowserWindow, powerSaveBlocker: powerSaveBlocker ?? null, powerMonitor: powerMonitor ?? null };
