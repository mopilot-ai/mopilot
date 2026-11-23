// main's IPC registry: every electron/app/ipc/<feature>.cjs, found by listing the folder in name order, registered with main's shared IPC deps.
const fs = require('node:fs');
const path = require('node:path');

/** The folder of per-feature IPC modules main registers. */
const IPC_DIR = __dirname;

/**
 * The IPC modules main registers itself, in file-name order. A module another one registers (with deps of its
 * own) says so with `registeredBy`, the module that registers it, and is left out.
 * @param {string} [dir]
 * @returns {{ name: string, register: (ipcMain: any, deps: any) => void }[]}
 */
function listIpcModules(dir = IPC_DIR) {
  const out = [];
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.cjs') && f !== path.basename(__filename))
    .sort()) {
    const mod = require(path.join(dir, file));
    if (mod.registeredBy) continue;
    if (typeof mod.register !== 'function') throw new Error(`ipc/${file} exports no register(ipcMain, deps) and no registeredBy`);
    out.push({ name: file.slice(0, -'.cjs'.length), register: mod.register });
  }
  return out;
}

/**
 * Register every IPC module main owns with the deps main shares with them.
 * @param {any} ipcMain
 * @param {any} deps
 * @param {string} [dir]
 * @returns {string[]} the modules registered, in order
 */
function registerIpcModules(ipcMain, deps, dir = IPC_DIR) {
  const mods = listIpcModules(dir);
  for (const m of mods) m.register(ipcMain, deps);
  return mods.map((m) => m.name);
}

module.exports = { IPC_DIR, listIpcModules, registerIpcModules };
