// Files the Chrome side panel attaches (app/chromePanel.cjs): a screenshot of the tab or a file the user picked, written where the app's pasted images go and named by an id, so a message can only carry what was attached here, never a path the panel names.
const { fs } = require('../platform/ports/fs.cjs');
const { mkdirPrivate } = require('../platform/privateFiles.cjs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** The largest file the panel attaches (its bytes). */
const MAX_BYTES = 20 * 1024 * 1024;
/** How long an attachment not sent yet is kept. */
const KEEP_MS = 24 * 60 * 60 * 1000;
/** Images every harness reads as images; anything else goes as a file. */
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

/**
 * A file name safe on every platform, keeping its extension; no spaces, since Claude Code reads a file as `@<path>` in
 * the message (harness/claude/message.cjs), where a space ends the path.
 */
function safeName(/** @type {string} */ name) {
  const base = path
    .basename(String(name))
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^[._]+|_+$/g, '')
    .slice(0, 120);
  return base || 'file';
}

class PanelFiles {
  /**
   * @param {object} [o]
   * @param {string} [o.dir] where they are written (the app's pasted images' folder)
   * @param {() => number} [o.now]
   */
  constructor({ dir = path.join(os.tmpdir(), 'sage-codex-attachments'), now = Date.now } = {}) {
    this.dir = dir;
    this.now = now;
    /** @type {Map<string, { path: string, name: string, kind: 'image' | 'file', at: number, sent?: boolean }>} */
    this.files = new Map();
  }

  /** The remote API resolves only explicit upload ids; sent files stay available to a durable queued message. */
  remoteOps() {
    return {
      attach: (file) => this.save(file),
      attachmentsForHost: (ids) => this.take(ids),
      attachmentsSent: (ids) => this.sent(ids),
    };
  }

  /**
   * One file from the panel, as a data: URL; its id and how the panel shows it.
   * @param {{ dataUrl: string, name: string }} f
   */
  save({ dataUrl, name }) {
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,(.*)$/s.exec(dataUrl);
    if (!m) throw new Error("That file couldn't be read.");
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > MAX_BYTES) throw new Error('That file is larger than 20 MB.');
    this.prune();
    const id = crypto.randomBytes(8).toString('hex');
    // each in a folder of its own, so the harness sees the name the user gave it
    const dir = path.join(this.dir, `panel-${id}`);
    mkdirPrivate(dir);
    const file = path.join(dir, safeName(name));
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const kind = IMAGE.test(m[1] ?? '') ? 'image' : 'file';
    // the name the user knows it by, for the chip and the harness's card
    const shown = path.basename(String(name)).trim().slice(0, 120) || path.basename(file);
    this.files.set(id, { path: file, name: shown, kind, at: this.now() });
    return { id, name: shown, kind };
  }

  /**
   * The attachments a message carries, as the queue takes them; refused when one isn't attached here.
   * @param {string[]} ids
   */
  take(ids) {
    return ids.map((id) => {
      const f = this.files.get(id);
      if (!f) throw new Error('Attach that file again.');
      return { kind: f.kind, path: f.path, name: f.name };
    });
  }

  /** The attachments went with a message: their files stay for its harness (a queued one reads them later). */
  sent(/** @type {string[]} */ ids) {
    for (const id of ids) {
      const f = this.files.get(id);
      if (f) f.sent = true;
    }
  }

  /** Forgets attachments not sent within a day; the files of those never sent go too. */
  prune() {
    const old = this.now() - KEEP_MS;
    for (const [id, f] of this.files) {
      if (f.at >= old) continue;
      this.files.delete(id);
      if (!f.sent) fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
    }
  }
}

module.exports = { PanelFiles, safeName, MAX_BYTES };
