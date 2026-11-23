// What a Host does about the run before it, when that one did not stop cleanly: the children it started are ended (./children.mjs), and the turns it left running end for the chats' clients as interrupted (./runJournal.mjs). It runs once the Host holds the data dir's lock, before it accepts a client.
import { createRequire } from 'node:module';
import { createCallIntents } from './callIntents.mjs';
import { createChildren } from './children.mjs';
import { createRunJournal } from './runJournal.mjs';

const require = createRequire(import.meta.url);
const { installProc } = require('../../electron/platform/ports/proc.cjs');

/** @param {{ dataDir: string, report?: (message: string) => void }} o */
export function createRecovery({ dataDir, report = () => undefined }) {
  const children = createChildren({ dataDir, report });
  const journal = createRunJournal({ dataDir, report });
  const intents = createCallIntents({ dataDir, report });
  return {
    children,
    journal,
    /** The acting calls sent and not yet answered, on disk (./callIntents.mjs). */
    intents,
    /** Every child process the shared harness code starts is recorded from here on. @returns {() => void} puts the proc port back */
    install() {
      const previous = installProc(children.tracking());
      return () => void installProc(previous);
    },
    /**
     * @param {{ interrupted: (left: [turnId: string, chatId: string][]) => number | void }} protocol
     * @returns {Promise<{ ended: number[], interrupted: number }>}
     */
    async run(protocol) {
      const ended = await children.start();
      const left = journal.start();
      // before the turns are ended: each end names the calls its chat lost
      const lost = intents.start(left);
      const committed = left.length > 0 ? protocol.interrupted(left) : 0;
      const interrupted = typeof committed === 'number' ? committed : left.length;
      if (ended.length > 0 || left.length > 0)
        report(
          `Recovered from a Host that did not stop cleanly: ended ${ended.length} child process(es), interrupted ${interrupted} turn(s), pending ${left.length - interrupted}, lost ${lost.length} call(s).`,
        );
      return { ended, interrupted };
    },
  };
}
