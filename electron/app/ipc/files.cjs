// IPC for local files: dictation recordings, saving text, git and gh commands, and the fs helpers windows use.
const { ownTable } = require('../../../shared/ownTable.mjs');
const { mkdirPrivate } = require('../../platform/privateFiles.cjs');
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const crypto = require('node:crypto');
const shellEnv = require('../../platform/env.cjs');
const { BRANCH_COMPARISON_GIT_ENV } = require('../../../shared/gitComparisonBase.mjs');
const { createGitDiff } = require('../../platform/gitDiff.cjs');
const { writeTextAtomic } = require('../../platform/writeTextAtomic.cjs');
const { testRunFolder } = require('../../platform/testChats.cjs');
const { makeProjectlessFolder } = require('../../platform/projectlessFolder.cjs');
const { resolveMessagePath } = require('../../platform/messagePath.cjs');
const { createRecordings } = require('../../platform/recordings.cjs');
const { readPreview } = require('../../platform/readPreview.cjs');
const { sidebarRepositories } = require('../../platform/sidebarRepositories.cjs');
const { readSidebarOrigin, sidebarRepository } = require('../../../shared/sidebarRepository.mjs');
/** The largest text file a window may open whole; a bigger one is refused with a clear error rather than read on the main process. */
const MB = 1024 * 1024;
const MAX_TEXT_BYTES = 20 * MB;
/** Image types by extension as a browser shows them in a data URL (image/svg alone shows nothing); others are image/<ext>. */
const PREVIEW_TYPES = ownTable({
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tif: 'image/tiff',
});

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps what main.cjs passes every IPC module
 */
function register(ipcMain, deps) {
  const { app, BrowserWindow, dialog, gitInfo, gitStatus, run, live } = deps;
  /* Dictation recordings: the last 20 stay on this device (Settings → Voice & dictation); Chrome's side panel saves its
     clips there too (platform/recordings.cjs). */
  const recordings = createRecordings(() => path.join(app.getPath('userData'), 'recordings'));
  live.recordings = recordings;
  ipcMain.handle('recordings:save', (_e, bytes, text) => recordings.save(bytes, text));
  ipcMain.handle('recordings:list', () => recordings.list());
  ipcMain.handle('recordings:read', (_e, id) => recordings.read(id));
  ipcMain.handle('recordings:clear', () => recordings.clear());
  ipcMain.handle('dialog:saveText', async (e, name, text) => {
    // Electron's dialogs take a missing window as no parent
    const w = /** @type {Electron.BaseWindow} */ (BrowserWindow.fromWebContents(e.sender));
    const r = await dialog.showSaveDialog(w, { defaultPath: name });
    if (r.canceled || !r.filePath) return null;
    writeTextAtomic(r.filePath, text);
    return r.filePath;
  });

  ipcMain.handle('git:sidebarRepository', (_e, cwd) => {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    return sidebarRepositories(app.getPath('userData'))(JSON.stringify(['local', cwd]), async () => {
      const origin = await readSidebarOrigin((args) => run('git', args, { cwd, timeout: 5000 }));
      return origin === undefined ? undefined : sidebarRepository(origin);
    });
  });
  ipcMain.handle('git:info', (_e, cwd) => gitInfo(cwd));
  ipcMain.handle('git:status', (_e, cwd, fresh) => gitStatus(cwd, fresh));
  const gitDiff = createGitDiff(run);
  ipcMain.handle('git:diff', (_e, cwd, file, fresh) => gitDiff(cwd, file, fresh));
  ipcMain.handle('git:run', (_e, cwd, args) => {
    // Pass Git's option through the environment so bundled and older command lines need no new parser flag.
    if (args[0] === '--no-lazy-fetch')
      return run('git', args.slice(1), { cwd, env: { ...shellEnv.gitEnv(), ...BRANCH_COMPARISON_GIT_ENV } });
    return run('git', args, { cwd });
  });
  ipcMain.handle('gh:run', async (_e, cwd, args) => run('gh', args, { cwd }));
  // Apply a unified diff (optionally reversed) with `git apply`, which also works outside repositories.
  ipcMain.handle('git:applyPatch', async (_e, cwd, patch, reverse) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-codex-patch-'));
    const file = path.join(dir, 'changes.patch');
    try {
      fs.writeFileSync(file, patch.endsWith('\n') ? patch : patch + '\n');
      const args = ['apply', '--whitespace=nowarn', '--unidiff-zero'];
      if (reverse) args.push('-R');
      args.push(file);
      return await run('git', args, { cwd });
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        // Cleanup must not hide a write/apply error or turn an applied patch into a refusal.
        console.warn('[git:applyPatch] Temporary patch cleanup failed', error);
      }
    }
  });

  // without blocking the main process: a path on a slow or stalled volume would hold up every window's IPC
  ipcMain.handle('fs:exists', (_e, p) =>
    fs.promises.access(p).then(
      () => true,
      () => false,
    ),
  );
  ipcMain.handle('fs:readPreview', (_e, p) => readPreview(p));
  // a path a reply names: the file or folder there, or null (platform/messagePath.cjs)
  ipcMain.handle('fs:messagePath', (_e, text, cwd) => resolveMessagePath(text, cwd));
  // A projectless chat's own folder, made here so chats on any harness get one (platform/projectlessFolder.cjs).
  const testRun = testRunFolder();
  ipcMain.handle('fs:mkdirProjectless', (_e, asked, date, slug) => makeProjectlessFolder(asked, date, slug, testRun));
  // A file that isn't there is null. One that is there but can't be read (EACCES, EISDIR) rejects, so the caller
  // says why instead of taking it for empty (and offering to save over it).
  ipcMain.handle('fs:readText', async (_e, p) => {
    try {
      const st = await fs.promises.stat(p);
      // not a file (EISDIR for a folder, as reading one says) or too big to hold in a window: refused, never read whole
      if (!st.isFile()) throw Object.assign(new Error(`EISDIR: not a regular file, read '${p}'`), { code: 'EISDIR' });
      if (st.size > MAX_TEXT_BYTES)
        throw Object.assign(
          new Error(`File is too large to open (${Math.ceil(st.size / MB)} MB; the limit is ${MAX_TEXT_BYTES / MB} MB)`),
          {
            code: 'EFBIG',
          },
        );
      return await fs.promises.readFile(p, 'utf8');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      throw error;
    }
  });
  // read without blocking the main process: a large image would hold up every window's IPC (streaming chats too)
  ipcMain.handle('fs:readImageDataUrl', async (_e, p) => {
    try {
      const ext = path.extname(p).slice(1).toLowerCase();
      return `data:${PREVIEW_TYPES[ext] ?? `image/${ext}`};base64,` + (await fs.promises.readFile(p)).toString('base64');
    } catch {
      return null;
    }
  });
  ipcMain.handle('fs:saveTempImage', async (_e, dataUrl) => {
    // image/svg+xml, image/x-icon, image/vnd.microsoft.icon too
    const m = /^data:image\/([\w.+-]+);base64,(.*)$/s.exec(dataUrl);
    if (!m) return null;
    const ext = { jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico' }[m[1]] ?? m[1].replace(/[^\w]/g, '');
    const dir = path.join(os.tmpdir(), 'sage-codex-attachments');
    mkdirPrivate(dir);
    await prunePastes(dir);
    // two pastes in the same millisecond get their own files
    const file = path.join(dir, `paste-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
    // a pasted image is the user's: only they can read it, as Chromium's own temp files
    await fs.promises.writeFile(file, Buffer.from(m[2], 'base64'), { mode: 0o600 });
    return file;
  });
}

/** Pasted images stay in the temp folder only while a message could still send them: a day, then they go (#2144). */
const PASTE_KEEP_MS = 86_400_000;
async function prunePastes(/** @type {string} */ dir, now = Date.now()) {
  for (const name of await fs.promises.readdir(dir)) {
    if (!name.startsWith('paste-')) continue;
    const file = path.join(dir, name);
    // another paste's prune may remove it between the listing and this look
    let st;
    try {
      st = await fs.promises.lstat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (st.mtimeMs < now - PASTE_KEEP_MS) await fs.promises.rm(file, { force: true });
  }
}

module.exports = { register };
