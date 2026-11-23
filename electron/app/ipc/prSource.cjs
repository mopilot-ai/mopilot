// IPC for starting a chat from GitHub, registered by ipc/prMonitor.cjs (`registeredBy`): find the pull request or issue a typed reference names, then fetch the pull request's head or the issue's text before the chat starts. gh calls join the shared GitHub queue.
const path = require('node:path');
const { fetchPullRequest } = require('../../platform/prSource.cjs');
const { fetchIssue } = require('../../platform/issueSource.cjs');
const { findStartSource } = require('../../platform/startSource.cjs');

/** A folder the window names: a full path, else nothing is run. */
const folder = (cwd) => typeof cwd === 'string' && path.isAbsolute(cwd);
const NO_FOLDER = { ok: false, error: 'Choose a project folder first.' };

function registerPrSource(ipcMain, { run, validWindow, github }) {
  // only gh joins the GitHub queue: a slow fetch must not hold up every chat's PR read
  const queued = (cmd, args, opts) => (cmd === 'gh' ? github(() => run(cmd, args, opts)) : run(cmd, args, opts));
  /** @type {Record<string, (run: any, cwd: string, arg: unknown) => Promise<unknown>>} */
  const calls = { 'git:startSource': findStartSource, 'git:fetchPullRequest': fetchPullRequest, 'git:issue': fetchIssue };
  for (const [channel, call] of Object.entries(calls))
    ipcMain.handle(channel, (event, cwd, arg) => {
      validWindow(event);
      return folder(cwd) ? call(queued, cwd, arg) : NO_FOLDER;
    });
}

module.exports = { registerPrSource, registeredBy: 'prMonitor' };
