// What this Host does as the target of a continue (docs: design/host/index.html, package 3.1): check the folder and the agent, keep the handoff the new session starts with, bind it to the chat when it becomes the owner, and give it back once, for the chat's first message.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseKind } from '../../shared/harnessKind.mjs';
import { canonicalHarness } from '../../shared/host/continueFamilies.mjs';

const ID = /^[0-9a-f]{24}$/;

/** The agent a continue asks for is not one this Host can start. */
class HarnessNotConfigured extends Error {
  /** @param {string} harness */
  constructor(harness) {
    super(`This host has no ${harness} agent set up.`);
    this.name = 'HarnessNotConfigured';
    this.code = 'harness_not_configured';
  }
}

/**
 * @param {object} o
 * @param {string} o.dir where the handoffs live (under the Host's data dir)
 * @param {{ existingDirectory: (p: unknown) => Promise<string> }} o.hostFs refuses a folder that is not here with its structured reason
 * @param {() => string[]} [o.harnesses] the ACP agents this Host can start
 * @param {(harness: string) => boolean} [o.accepts] whether this machine can start the agent, instead of the ACP list (this Mac starts all three families)
 * @param {(harness: string) => Promise<void>} [o.agent] refuses an agent this machine cannot start by the fact that holds (shared/host/continueFamilies.mjs), instead of both lists above
 */
export function createContinueTarget({ dir, hostFs, harnesses = () => [], accepts, agent }) {
  const stash = (/** @type {string} */ id) => path.join(dir, 'stash', `${id}.json`);
  const bound = (/** @type {string} */ chatId) =>
    path.join(dir, 'bound', `${createHash('sha256').update(chatId).digest('hex').slice(0, 32)}.json`);
  const put = (/** @type {string} */ file, /** @type {object} */ value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  /** One bound handoff, or null when the file is missing, unreadable or of the wrong shape. @param {string} file */
  const readBound = (file) => {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return typeof v?.handoff === 'string'
        ? {
            text: v.handoff,
            cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
            harness: typeof v.harness === 'string' ? v.harness : undefined,
            chatId: typeof v.chatId === 'string' ? v.chatId : undefined,
            id: typeof v.nativeId === 'string' ? v.nativeId : undefined,
          }
        : null;
    } catch {
      return null;
    }
  };
  return {
    /** The real folder, or a refusal: `harness_not_configured`, or the folder's own. @param {{ harness: string, cwd: string }} a */
    async check({ harness, cwd }) {
      // a chat that lives on a Host names its agent as the app draws it (`acp:host-claude`): it is the family the Host starts
      const wanted = canonicalHarness(harness);
      if (agent) await agent(wanted);
      else {
        const kind = parseKind(wanted);
        const ok = accepts ? accepts(wanted) : kind?.family === 'acp' && harnesses().includes(/** @type {string} */ (kind.basic));
        if (!ok) throw new HarnessNotConfigured(harness);
      }
      return hostFs.existingDirectory(cwd);
    },
    /** Keeps the handoff for the new session; the id names it until it is bound. @param {{ chatId: string, harness: string, cwd: string, handoff: string }} a */
    async open({ harness, cwd, handoff }) {
      const nativeId = randomBytes(12).toString('hex');
      put(stash(nativeId), { harness: canonicalHarness(harness), cwd, handoff });
      return { nativeId };
    },
    /** Drops a handoff nobody will use. @param {string} nativeId */
    async discard(nativeId) {
      if (ID.test(nativeId)) fs.rmSync(stash(nativeId), { force: true });
    },
    /** The chat is this Host's now: its handoff waits for the first message. @param {{ chatId: string, nativeId: string }} rec */
    serve({ chatId, nativeId }) {
      if (!ID.test(nativeId)) return;
      try {
        const kept = JSON.parse(fs.readFileSync(stash(nativeId), 'utf8'));
        put(bound(chatId), { ...kept, chatId, nativeId });
        fs.rmSync(stash(nativeId), { force: true });
      } catch {
        // nothing kept under that id (already bound, or dropped): the chat starts without a handoff
      }
    },
    /** What the chat's first message carries, or null (read again until `done`, so a message that failed to send does not lose it). @param {string} chatId */
    take(chatId) {
      return readBound(bound(chatId));
    },
    /** Every chat whose handoff still waits for its first message (after a restart, this is where they are found again). */
    pending() {
      let names;
      try {
        names = fs.readdirSync(path.join(dir, 'bound'));
      } catch {
        return [];
      }
      return names.flatMap((n) => {
        const v = readBound(path.join(dir, 'bound', n));
        return v ? [v] : [];
      });
    },
    /** A handoff kept under another spelling of the chat's id is kept under this one (a move begun before the Host named chats by one spelling, #5160). @param {string} from @param {string} to */
    rekey(from, to) {
      const kept = JSON.parse(fs.readFileSync(bound(from), 'utf8'));
      // one already kept under the Host's id is the newer: it is not overwritten
      if (!fs.existsSync(bound(to))) put(bound(to), { ...kept, chatId: to });
      fs.rmSync(bound(from), { force: true });
    },
    /** The first message went out. @param {string} chatId */
    done(chatId) {
      fs.rmSync(bound(chatId), { force: true });
    },
  };
}
