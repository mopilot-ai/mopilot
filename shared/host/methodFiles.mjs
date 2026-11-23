// Finds the wire methods declared one per file in `shared/host/methods/` and checks each declaration, so a feature adds its methods without editing schema.mjs; the Host's handlers for them are found the same way (host/src/methodHandlers.mjs).
import fs from 'node:fs';

/**
 * A declaration file's default export, or a function of the parser kit that returns it.
 * `access` is required, never defaulted: `'paired'` methods refuse a connection that has not proved its key (server.mjs), `'open'` ones are for a client that has not paired yet.
 * @typedef {{ features?: string[], methods: Record<string, { parse: (p: any) => any, requires?: string[], access: 'paired' | 'open' }> }} MethodFile
 */

/** The file names of a folder that hold code, sorted so the order of features and refusals never depends on the disk. @param {string} dir */
export const codeFilesIn = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => /\.(?:mjs|cjs|js)$/.test(n) && !/\.d\.[mc]?ts$/.test(n))
        .sort()
    : [];

/** The default export of a module that was loaded with `require` (a namespace object) or `import`. @param {any} mod */
export const defaultOf = (mod) => (mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod);

/**
 * Reads every declaration and merges them. A method declared twice, one the core already has, or one with no `access` is a mistake that stops the module loading, never one a client finds.
 * @param {string[]} names the files, in order
 * @param {(name: string) => unknown} load the module of a file (the caller names the folder, so the Host's packer can see it)
 * @param {object} kit what a parser may use, passed to a declaration that is a function
 * @param {(method: string) => boolean} taken whether the core already parses this method
 */
export function collectMethodFiles(names, load, kit, taken) {
  /** @type {Record<string, (p: any) => any>} */
  const parsers = {};
  /** @type {Record<string, string[]>} */
  const requires = {};
  /** @type {string[]} */
  const features = [];
  /** @type {string[]} */
  const paired = [];
  for (const name of names) {
    const exported = defaultOf(load(name));
    /** @type {MethodFile} */
    const file = typeof exported === 'function' ? exported(kit) : exported;
    if (!file || typeof file.methods !== 'object') throw new Error(`methods/${name} declares no methods.`);
    for (const f of file.features ?? []) if (!features.includes(f)) features.push(f);
    for (const [method, d] of Object.entries(file.methods)) {
      if (Object.hasOwn(parsers, method) || taken(method))
        throw new Error(`methods/${name} declares ${method}, which is already declared.`);
      if (typeof d.parse !== 'function') throw new Error(`methods/${name} gives ${method} no parser.`);
      if (d.access !== 'paired' && d.access !== 'open') throw new Error(`methods/${name} must say whether ${method} is paired or open.`);
      parsers[method] = d.parse;
      if (d.requires?.length) requires[method] = [...d.requires];
      if (d.access === 'paired') paired.push(method);
    }
  }
  return { parsers, requires, features, paired };
}
