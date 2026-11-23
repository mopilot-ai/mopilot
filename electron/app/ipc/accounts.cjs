// IPC for identity and Codex accounts, and what runs as the signed-in ChatGPT account: dictation and Codex Cloud.
const os = require('node:os');
const { usageReason } = require('../../identity/contract/usageRefresh.cjs');
const { createMicAccess } = require('../../platform/micAccess.cjs');
const { environmentRepository } = require('../../../shared/sidebarRepository.mjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps what main.cjs passes every IPC module; `live` reads (and sets) main's late-bound state
 */
function register(ipcMain, deps) {
  const { handle, createDictation, API_BASE, net, run, spawnArgs, findCodexBinary, live, isFlagEnabled, shell, systemPreferences } = deps;
  /* ChatGPT backend calls made as the active account (same endpoints `codex cloud` uses). */
  const chatgptHeaders = () => live.accounts.chatgptHeaders();

  /* Multiple accounts (electron/identity/codexAccounts.cjs). Every call returns the renderer-safe account view. */
  ipcMain.handle('accounts:list', () => live.accounts.view());
  ipcMain.handle('accounts:apply', () => live.accounts.apply().catch(() => live.accounts.view()));
  ipcMain.handle('accounts:switch', (_e, id) => live.accounts.switchTo(String(id)));
  ipcMain.handle('accounts:login', (_e, targetId) => live.accounts.startLogin(targetId ? String(targetId) : null));
  ipcMain.handle('accounts:cancelLogin', () => live.accounts.cancelLogin());
  ipcMain.handle('accounts:addApiKey', (_e, key, baseUrl, replaceId) =>
    live.accounts.addApiKey(String(key ?? ''), String(baseUrl ?? ''), replaceId ? String(replaceId) : null),
  );
  ipcMain.handle('accounts:setMode', (_e, mode) => live.accounts.setMode(String(mode)));
  ipcMain.handle('accounts:remove', (_e, id) => live.accounts.remove(String(id)));
  // reason: 'background', 'surface' (a surface showing the accounts opened) or 'now' (the user asked)
  ipcMain.handle('accounts:refreshUsage', (_e, reason) => live.accounts.refreshUsage(undefined, usageReason(reason)));
  handle('accounts:resetCredits', (id) => live.accounts.resetCredits(String(id)));
  handle('accounts:consumeResetCredit', (id, creditId) => live.accounts.consumeResetCredit(String(id), creditId));
  ipcMain.handle('accounts:setAutoSwitch', (_e, on) => live.accounts.setAutoSwitch(!!on));
  ipcMain.handle('accounts:setPool', (_e, mode) => live.accounts.setPool(String(mode)));
  ipcMain.handle('accounts:pinChat', (_e, threadId, id) => live.accounts.pinChat(String(threadId), id ? String(id) : null));

  /* Dictation: three engines (electron/platform/voice.cjs): local (the helper), ChatGPT account, MoPilot credits. */
  const dictation = createDictation({
    chatgptHeaders,
    gatewayKey: () => live.mopilot?.gatewayKey() ?? null,
    apiBase: API_BASE,
    helper: () => live.computerUse.helper,
    fetch: (url, init) => net.fetch(url, init),
    enabled: () => isFlagEnabled('shared.dictation.enabled'),
  });
  // the same engines for Chrome's side panel (app/chromePanelDictate.cjs)
  live.dictation = dictation;
  ipcMain.handle('dictation:localStatus', async (_e, language) => {
    if (process.platform !== 'darwin') return null;
    try {
      const h = live.computerUse.helper;
      await h.start();
      return await h.speechStatus(language);
    } catch {
      return null;
    }
  });
  ipcMain.handle('dictation:localRequest', async (_e, language) => {
    if (process.platform !== 'darwin') return null;
    try {
      const h = live.computerUse.helper;
      await h.start();
      return await h.speechRequest(language);
    } catch (e) {
      // not null when the cause is known: a helper that aborted mid-request (macOS ends it when a purpose string is missing, #5340)
      const failure = speechFailureText(e);
      return failure ? { failure } : null;
    }
  });

  const mic = createMicAccess({ systemPreferences, shell });
  ipcMain.handle('dictation:micAsk', () => mic.ask());
  ipcMain.handle('dictation:micSettings', () => mic.openSettings());

  /* Codex Cloud: environments come from the ChatGPT backend (as the CLI does); tasks go through `codex cloud`. */
  const cloudEnvironments = async () => {
    const headers = await chatgptHeaders();
    if (!headers) return { error: 'Sign in with ChatGPT to use Codex Cloud' };
    try {
      const res = await net.fetch('https://chatgpt.com/backend-api/wham/environments', { headers });
      if (!res.ok) return { error: `Couldn't load environments (${res.status})` };
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.environments || data.items || [];
      return {
        envs: list.map((e) => ({
          id: e.id,
          label: e.label || e.name || e.id,
          repo: e.repo_map ? Object.values(e.repo_map)[0]?.repository_full_name : e.repo || null,
          ...(e.repo_map && typeof e.repo_map === 'object'
            ? {
                repositories: Object.values(e.repo_map).map((entry) => entry?.repository_full_name ?? null),
              }
            : {}),
          pinned: !!e.is_pinned,
        })),
      };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  };
  ipcMain.handle('cloud:envs', cloudEnvironments);
  // run() reports its own failures as a result; a binary that can't be found or launched is reported the same way
  const cloud = (args, cwd, claim) =>
    findCodexBinary()
      .then(async (bin) => {
        if (claim) {
          const accountIsCurrent = () => (live.accounts.view().active ?? null) === claim.account;
          if (!accountIsCurrent()) throw new Error('Choose a cloud environment for the current account.');
          const catalog = await cloudEnvironments();
          if (!accountIsCurrent() || !catalog.envs?.some((env) => env.id === claim.id && environmentRepository(env) === claim.repository))
            throw new Error('Choose a cloud environment for this project.');
        }
        return run(...spawnArgs(bin, ['cloud', ...args], { cwd: cwd || os.homedir(), timeout: 120000 }));
      })
      .catch((e) => ({ ok: false, code: 1, stdout: '', stderr: String(e.message || e) }));
  ipcMain.handle('cloud:exec', async (_e, env, prompt, attempts = 1, claim) => {
    // the CLI reads a prompt of just "-" from stdin, which nothing here writes: it would wait out the timeout
    if (String(prompt).trim() === '-') return { ok: false, id: null, output: 'Describe the task: "-" alone is not a prompt.' };
    // after "--", a prompt starting with "-" (a Markdown list, "-v") is the prompt, not an option
    const r = await cloud(['exec', '--env', env, '--attempts', String(attempts), '--', prompt], undefined, claim && { ...claim, id: env });
    const id = /(task_[A-Za-z0-9_-]+)/.exec(r.stdout + r.stderr)?.[1] || null;
    return { ok: r.ok && !!id, id, output: (r.stdout || r.stderr).trim() };
  });
  ipcMain.handle('cloud:list', async (_e, env) => {
    const r = await cloud(['list', '--json', '--limit', '20', ...(env ? ['--env', env] : [])]);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { tasks: [], error: (r.stderr || r.stdout).trim().split('\n').pop() };
    }
  });
  ipcMain.handle('cloud:status', async (_e, id) => {
    const r = await cloud(['status', id]);
    return { ok: r.ok, text: (r.stdout || r.stderr).trim() };
  });
  ipcMain.handle('cloud:diff', async (_e, id, attempt) => {
    const r = await cloud(['diff', id, ...(attempt ? ['--attempt', String(attempt)] : [])]);
    return { ok: r.ok, diff: r.stdout, error: r.ok ? null : (r.stderr || r.stdout).trim() };
  });
  ipcMain.handle('cloud:apply', async (_e, id, cwd, attempt) => {
    const r = await cloud(['apply', id, ...(attempt ? ['--attempt', String(attempt)] : [])], cwd);
    return { ok: r.ok, output: (r.stdout || r.stderr).trim() };
  });
}

/** What the composer says when the helper could not ask macOS for Speech Recognition: its own text when it has the fix, that it stopped when it was ended mid-request, else nothing (a plain failure). */
function speechFailureText(e) {
  if (e?.reason === 'helper_outdated') return String(e.message);
  if (e?.reason === 'helper_restarted' || e?.reason === 'helper_exited')
    return 'MoPilot’s Mac helper stopped while asking for Speech Recognition. Quit and reopen MoPilot, and update it if this continues.';
  return '';
}

module.exports = { register };
