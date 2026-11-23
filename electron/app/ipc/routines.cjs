// IPC for routines (#3571, G4): Settings › Browser › Routines lists, renames and deletes the user's routines, and the
// "Save as routine" line after a turn keeps that chat's steps since its last save as one (electron/app/routines.cjs owns the
// store and the recorder; every change reaches the windows as routines:changed). Each answer is {ok, …} or {ok:false, error}.
const { saveLastTurn } = require('../../capabilities/routines/routineTools.cjs');
const { describeStep } = require('../../capabilities/routines/routineSteps.cjs');
const { userError } = require('../../../shared/userError.mjs');

/** A routine as Settings shows it: what it is and does, never the values it recorded. */
const view = (/** @type {any} */ r) => ({
  id: r.id,
  rev: r.rev,
  kind: r.kind,
  name: r.name,
  description: r.description,
  steps: r.steps.map(describeStep),
  params: r.params.map((/** @type {{ name: string }} */ p) => p.name),
  runs: r.runs,
  updatedAt: r.updatedAt,
});

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {Pick<import('../../main.cjs').IpcDeps, 'live'>} deps
 */
function register(ipcMain, { live }) {
  /** A handler over the routines, answering why not when they aren't up yet or the call is refused. */
  const on = (/** @type {string} */ channel, /** @type {(r: any, ...args: any[]) => any} */ fn) =>
    ipcMain.handle(channel, (_e, ...args) => {
      const r = live.routines;
      if (!r) return { ok: false, error: "Routines aren't ready yet" };
      try {
        return { ok: true, ...fn(r, ...args) };
      } catch (error) {
        return { ok: false, error: userError(error) };
      }
    });
  on('routines:list', (r) => ({ routines: r.store.list().map(view), skillsProblem: r.skillsProblem() }));
  on('routines:saveLast', (r, chatId, name) => {
    const saved = saveLastTurn(r, String(chatId), { name });
    live.sessions?.patch(String(chatId), { routineOffer: null });
    return { routine: view(saved) };
  });
  on('routines:edit', (r, id, rev, edit) => {
    const e = edit && typeof edit === 'object' ? edit : {};
    const next = r.store.update(String(id), Number(rev), { name: e.name, description: e.description });
    if (!next) throw new Error('This routine changed meanwhile. Open it again.');
    return { routine: view(next) };
  });
  on('routines:remove', (r, id) => ({ removed: r.store.remove(String(id)) }));
}

module.exports = { register, view };
