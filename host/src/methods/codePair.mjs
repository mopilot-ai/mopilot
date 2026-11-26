// The Host's handlers for pairing by code (feature `codePair`, R2b of #5576; ./codePairService.mjs): served to the CLI on this machine only, which is how the app's own local connection proves itself. Every other kind is refused here and (by the per-kind table, ./controllerRefusals.mjs) a controller or a home before it gets here. A Host built without the service does not offer the feature.
import { UnsupportedError } from '../errors.mjs';

/** @param {{ codePair?: ReturnType<typeof import('../codePairService.mjs').createCodePairService> }} deps */
export default ({ codePair }) => {
  /** @param {unknown} kind */
  const served = (kind) => {
    // a kind that is not the CLI is told what a Host that does not pair by code tells it (the methods are veiled to it too)
    if (!codePair || kind !== 'cli') throw new UnsupportedError('This host does not pair by code.');
    return codePair;
  };
  /** Only the CLI on this machine knows these methods and the feature exist: to any other kind they are a request no Host knows, and the hello does not name the feature. @param {unknown} principal */
  const cliOnly = (principal) => /** @type {{ kind?: string } | null} */ (principal)?.kind === 'cli';
  return {
    features: { codePair: cliOnly },
    veils: Object.fromEntries(
      ['offer', 'answer', 'cancel', 'status', 'approvalText', 'enrol', 'connections', 'resetApproval'].map((m) => [
        `host.codePair.${m}`,
        cliOnly,
      ]),
    ),
    handlers: {
      /** @param {any} p @param {unknown} kind @param {unknown} _who @param {(m: object) => unknown} emit @param {Set<() => void>} ends */
      'host.codePair.offer': (p, kind, _who, emit, ends) => served(kind).offer(p, { owner: ends, emit, ends }),
      /** @param {any} p @param {unknown} kind @param {unknown} _who @param {unknown} _emit @param {Set<() => void>} ends */
      'host.codePair.answer': (p, kind, _who, _emit, ends) => served(kind).answer(p, { owner: ends }),
      /** @param {any} p @param {unknown} kind @param {unknown} _who @param {unknown} _emit @param {Set<() => void>} ends */
      'host.codePair.cancel': (p, kind, _who, _emit, ends) => served(kind).cancel(p, { owner: ends }),
      /** @param {any} p @param {unknown} kind @param {unknown} _who @param {unknown} _emit @param {Set<() => void>} ends */
      'host.codePair.approvalText': (p, kind, _who, _emit, ends) => served(kind).approvalText(p, { owner: ends }),
      /** @param {any} p @param {unknown} kind */
      'host.codePair.enrol': (p, kind) => served(kind).enrol(p),
      /** @param {unknown} _p @param {unknown} kind @param {unknown} _who @param {unknown} _emit @param {Set<() => void>} ends */
      /** @param {unknown} _p @param {unknown} kind */
      'host.codePair.resetApproval': (_p, kind) => served(kind).resetApproval(),
      'host.codePair.status': (_p, kind, _who, _emit, ends) => served(kind).status({ owner: ends }),
      /** "Allow connections" as the app on this Mac has it (told when it changes and when the app connects). @param {any} p @param {unknown} kind */
      'host.codePair.connections': (p, kind) => served(kind).connections(p),
    },
  };
};
