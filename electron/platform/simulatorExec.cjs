// Runs the host toolchain behind the simulator tools (xcrun simctl, idb, adb, emulator) and finds the binaries: one
// place that spawns, so a missing binary, a timeout and a non-zero exit all come back as data a tool can report
// accurately. child_process, the file system and the platform are injected so tests run without Xcode or an SDK.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_BUFFER = 64 * 1024 * 1024;
/** Where each tool sits inside an Android SDK; idb is found on PATH only. */
const SUB = { adb: 'platform-tools', emulator: 'emulator', idb: '' };

/**
 * @param {object} [o]
 * @param {typeof cp.execFile} [o.execFile]
 * @param {typeof cp.spawn} [o.spawn]
 * @param {Pick<typeof fs, 'readFileSync' | 'unlinkSync' | 'readdirSync' | 'statSync'>} [o.files] the files simctl writes and the crash reports macOS keeps
 * @param {(p: string) => boolean} [o.exists] whether a file exists
 * @param {string} [o.platform]
 * @param {Record<string, string | undefined>} [o.env]
 * @param {string} [o.home]
 */
function createExec(o = {}) {
  const execFile = o.execFile ?? cp.execFile;
  const spawn = o.spawn ?? cp.spawn;
  const exists = o.exists ?? fs.existsSync;
  const files = o.files ?? fs;
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();

  /** The Android SDK folders, then PATH. */
  const dirs = (sub) => {
    const sdks = [
      env.ANDROID_HOME,
      env.ANDROID_SDK_ROOT,
      path.join(home, 'Library', 'Android', 'sdk'),
      path.join(home, 'Android', 'Sdk'),
    ].filter(Boolean);
    const onPath = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
    return [...(sub ? sdks.map((s) => path.join(String(s), sub)) : []), ...onPath];
  };

  /** The absolute path of an installed tool ('adb', 'emulator', 'idb'), or null. */
  function locate(name) {
    for (const d of dirs(SUB[name] ?? '')) {
      const p = path.join(d, name);
      if (exists(p)) return p;
    }
    return null;
  }

  /**
   * Runs a program. Never rejects.
   * @param {string} file
   * @param {string[]} args
   * @param {{ timeout?: number, binary?: boolean }} [opts]
   * @returns {Promise<{ ok: boolean, code: number | string | null, stdout: any, stderr: string, missing?: boolean, timedOut?: boolean }>}
   */
  function run(file, args, opts = {}) {
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        { timeout: opts.timeout ?? 30_000, maxBuffer: MAX_BUFFER, encoding: opts.binary ? 'buffer' : 'utf8' },
        (err, stdout, stderr) => {
          const text = String(stderr ?? '');
          if (!err) return resolve({ ok: true, code: 0, stdout, stderr: text });
          const e = /** @type {any} */ (err);
          resolve({
            ok: false,
            code: e.code ?? null,
            stdout: stdout ?? '',
            stderr: text || e.message,
            missing: e.code === 'ENOENT',
            timedOut: e.killed === true,
          });
        },
      );
    });
  }

  /** Starts a long-lived program (the emulator) that outlives the call. */
  function startDetached(file, args) {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  }

  /** The bytes of a file a tool wrote (a simctl screenshot). */
  const readFile = (file) => files.readFileSync(file);
  /** Removes such a file; throws when it can't, so the caller decides whether that matters. */
  const removeFile = (file) => files.unlinkSync(file);
  /** The names in a folder; throws when it can't be read. */
  const listDir = (dir) => files.readdirSync(dir);
  /** When a file last changed, in milliseconds. */
  const modifiedAt = (file) => files.statSync(file).mtimeMs;
  /** A text file's contents. */
  const readText = (file) => files.readFileSync(file, 'utf8');

  return { run, locate, startDetached, readFile, removeFile, listDir, modifiedAt, readText, platform };
}

module.exports = { createExec };
