// The cloud-machine provider interface (Remote Run track C, C1): the call shapes and flags every provider file implements, the one error type they throw, and a fake provider the tests use. Pure shared code; a provider gets its `fetch` and signer injected.

/** The four states a provider answers for a machine. */
export const MACHINE_STATES = Object.freeze(['starting', 'running', 'stopped', 'gone']);

/** The calls a provider must have. */
export const ADAPTER_CALLS = Object.freeze(['create', 'status', 'stop', 'resume', 'destroy', 'find', 'sizes', 'regions']);

/**
 * What a provider cannot do. A client disables the control with the reason instead of hiding it (a `false` flag has a `why`).
 * `resume`: stop keeps the disk and start brings it back. `selfStop`: the Host can stop its own machine (halt, or a provider timer).
 * `publicPrice`: `sizes()` carries a price per hour. `stopSavesMoney`: a stopped machine costs less than a running one.
 * `limitedNetwork`: the adapter can apply the Limited network level.
 */
export const FLAG_NAMES = Object.freeze(['resume', 'selfStop', 'publicPrice', 'stopSavesMoney', 'limitedNetwork']);

/** The words a client shows beside a control a provider cannot offer, by flag: the reason the adapter gives, or this default. */
export const DEFAULT_WHY = Object.freeze({
  resume: "This provider can't stop a machine and keep its disk.",
  selfStop: "This machine can't stop itself, so it keeps running until it is stopped here.",
  publicPrice: "This provider doesn't publish a price per hour.",
  stopSavesMoney: 'A stopped machine costs as much as a running one here.',
  limitedNetwork: 'This provider has no firewall MoPilot can set up, so only Full is available.',
});

/** Why `flag` is off for `adapter`, in words; null when it is on. @param {any} adapter @param {string} flag */
export function whyOff(adapter, flag) {
  if (adapter?.flags?.[flag] !== false) return null;
  return adapter.why?.[flag] ?? /** @type {Record<string, string>} */ (DEFAULT_WHY)[flag] ?? 'Not available here.';
}

/** A provider failure with a code the clients branch on and words the person can read. Codes: `refused` (the key), `capacity`, `limit`, `gone`, `busy` (try again), `invalid`, `failed`. */
export class CloudError extends Error {
  /** @param {string} code @param {string} message @param {{ retryable?: boolean }} [more] */
  constructor(code, message, more = {}) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.retryable = more.retryable === true;
  }
}

/** The adapter itself, or the first thing wrong with it as a sentence; `null` when it is whole. @param {any} adapter */
export function adapterProblem(adapter) {
  if (!adapter || typeof adapter !== 'object') return 'A provider adapter is an object.';
  for (const call of ADAPTER_CALLS) if (typeof adapter[call] !== 'function') return `The adapter has no ${call}().`;
  if (typeof adapter.id !== 'string' || !adapter.id) return 'The adapter has no id.';
  const flags = adapter.flags;
  if (!flags || typeof flags !== 'object') return 'The adapter has no flags.';
  for (const name of FLAG_NAMES) if (typeof flags[name] !== 'boolean') return `The flag ${name} is missing.`;
  return null;
}

/** Whether a `status` answer is one of the four. @param {unknown} v */
export const isMachineState = (v) => typeof v === 'string' && MACHINE_STATES.includes(v);

/**
 * A provider that keeps its machines in memory. `boot(command, id)` runs when a machine is made, standing in for the machine running its first-boot command.
 * Failures are queued with `failNext(call, error)`; `calls` is every call with its arguments, so a test can read what the provider was given.
 * @param {{ id?: string, boot?: (command: string, id: string) => void, flags?: Partial<Record<string, boolean>> }} [o]
 */
export function createFakeProvider({ id = 'fake', boot = () => undefined, flags = {} } = {}) {
  /** @type {Map<string, { name: string, size: string, region: string, command: string, state: string, disk: boolean, network: string }>} */
  const machines = new Map();
  /** @type {{ call: string, args: any[] }[]} */
  const calls = [];
  /** @type {Map<string, any[]>} */
  const failures = new Map();
  let n = 0;
  /** @param {string} call @param {any[]} args */
  const enter = (call, args) => {
    calls.push({ call, args });
    const queue = failures.get(call);
    const next = queue?.shift();
    if (next !== undefined) throw next;
  };
  /** @param {string} machine */
  const need = (machine) => {
    const m = machines.get(machine);
    if (!m) throw new CloudError('gone', 'That machine is gone at the provider.');
    return m;
  };
  return {
    id,
    flags: Object.freeze({
      resume: true,
      selfStop: true,
      publicPrice: true,
      stopSavesMoney: true,
      limitedNetwork: false,
      ...flags,
    }),
    why: Object.freeze({}),
    calls,
    machines,
    /** The next `call` throws `error` (once). @param {string} call @param {any} error */
    failNext(call, error) {
      failures.set(call, [...(failures.get(call) ?? []), error]);
    },
    /** Set a machine's state as the provider would on its own (booted, halted by the Host, deleted in the console). @param {string} machine @param {string} state */
    set(machine, state) {
      const m = machines.get(machine);
      if (m) m.state = state;
    },
    /** @param {{ name: string, size: string, region: string, command: string, network?: string }} spec */
    async create(spec) {
      enter('create', [spec]);
      const machine = `${id}-${++n}`;
      machines.set(machine, {
        name: spec.name,
        size: spec.size,
        region: spec.region,
        command: spec.command,
        state: 'starting',
        disk: true,
        network: spec.network ?? 'full',
      });
      boot(spec.command, machine);
      return { id: machine };
    },
    /** @param {string} machine */
    async status(machine) {
      enter('status', [machine]);
      return machines.get(machine)?.state ?? 'gone';
    },
    /** @param {string} machine */
    async stop(machine) {
      enter('stop', [machine]);
      need(machine).state = 'stopped';
    },
    /** @param {string} machine */
    async resume(machine) {
      enter('resume', [machine]);
      const m = need(machine);
      if (m.state === 'stopped') m.state = 'starting';
    },
    /** @param {string} machine */
    async destroy(machine) {
      enter('destroy', [machine]);
      machines.delete(machine);
    },
    /** The id of a machine made under `name` that still exists, or null: how a launcher finds a machine whose `create` answer it never saw. @param {string} name */
    async find(name) {
      enter('find', [name]);
      return [...machines].find(([, m]) => m.name === name)?.[0] ?? null;
    },
    async sizes() {
      enter('sizes', []);
      return [
        {
          id: 'small',
          label: 'Small',
          cpus: 1,
          memoryGb: 8,
          pricePerHour: 0.02,
          currency: 'USD',
        },
      ];
    },
    async regions() {
      enter('regions', []);
      return [{ id: 'r1', label: 'Region 1' }];
    },
  };
}
