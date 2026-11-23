// Machines the Add machine picker offers, found only when it opens: concrete hosts from ~/.ssh/config (resolved with `ssh -G`, Includes followed), Macs and servers on the local network that advertise ssh over Bonjour (`dns-sd`, this Mac left out), and online Tailscale peers when Tailscale is installed.
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { proc } = require('../platform/ports/proc.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const started = require('./started.cjs');
const { sshTarget, normalAddress } = require('../../shared/host/sshDestination.mjs');

/** @typedef {{ source: 'network' | 'tailscale' | 'config', name: string, destination: string, detail: string, address: string, remoteLoginOff?: boolean }} Found */

const MAX_CONFIG_HOSTS = 50;
const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * What a program printed: all of it when it ends by itself, or what it printed by `ms` (a browse never ends; it is stopped then), or as soon as the output matches `enough`.
 * @param {string} bin @param {string[]} args @param {number} ms @param {RegExp} [enough] @returns {Promise<string>}
 */
function collect(bin, args, ms, enough) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      // stopped with the app if it is still running then (electron/host/started.cjs)
      child = started.track(proc.spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      return resolve('');
    }
    const timer = clock.setTimeout(() => child.kill('SIGTERM'), ms);
    child.stdout.on('data', (/** @type {Buffer} */ c) => {
      out += c.toString('utf8');
      if (enough?.test(out)) child.kill('SIGTERM');
    });
    child.on('error', () => undefined);
    child.on('close', () => {
      clock.clearTimeout(timer);
      resolve(out);
    });
  });
}

/** A Host line's names that name one machine: no wildcard, no negation. @param {string} names */
const concreteHosts = (names) => names.split(/\s+/).filter((n) => n && !/[*?!]/.test(n));

/**
 * The concrete host aliases of an ssh config and the files it Includes (relative paths are under ~/.ssh; a `*` in the last part is a glob).
 * @param {string} file @param {string} home @param {number} [depth]
 * @returns {string[]}
 */
function configAliases(file, home, depth = 0) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const raw of text.split('\n')) {
    // `Host x` or `Host=x`, never `HostName …`
    const m = /^\s*(host|include)(?:\s*=\s*|\s+)(.+?)\s*$/i.exec(raw.replace(/#.*/, ''));
    if (!m) continue;
    if (m[1].toLowerCase() === 'host') out.push(...concreteHosts(m[2]));
    else if (depth < 5)
      for (const spec of m[2].split(/\s+/)) {
        const full = spec.startsWith('~/') ? path.join(home, spec.slice(2)) : path.isAbsolute(spec) ? spec : path.join(home, '.ssh', spec);
        const base = path.basename(full);
        const files = base.includes('*')
          ? (() => {
              const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
              try {
                return fs
                  .readdirSync(path.dirname(full))
                  .filter((/** @type {string} */ f) => re.test(f))
                  .sort()
                  .map((/** @type {string} */ f) => path.join(path.dirname(full), f));
              } catch {
                return [];
              }
            })()
          : [full];
        for (const f of files) out.push(...configAliases(f, home, depth + 1));
      }
  }
  return [...new Set(out)];
}

/** `ssh -G` output to the values that matter. @param {string} text */
function resolved(text) {
  /** @type {Record<string, string>} */
  const v = {};
  for (const line of text.split('\n')) {
    const m = /^(hostname|user|port) (.+)$/.exec(line.trim());
    if (m) v[m[1]] = m[2];
  }
  return v;
}

/**
 * Hosts from the user's ssh config, as ssh itself resolves them.
 * @param {{ home?: string, run?: typeof collect }} [o]
 * @returns {Promise<Found[]>}
 */
async function fromSshConfig({ home = os.homedir(), run = collect } = {}) {
  const aliases = configAliases(path.join(home, '.ssh', 'config'), home).slice(0, MAX_CONFIG_HOSTS);
  const found = await Promise.all(
    aliases.map(async (alias) => {
      const v = resolved(await run('ssh', ['-G', '--', alias], 5000));
      const host = v.hostname || alias;
      const port = v.port && v.port !== '22' ? `:${v.port}` : '';
      return /** @type {Found} */ ({
        source: 'config',
        name: alias,
        destination: alias,
        detail: `${v.user ? `${v.user}@` : ''}${host}${port}`,
        address: host,
      });
    }),
  );
  return found.filter((f) => /^[A-Za-z0-9_][A-Za-z0-9_.@:%+-]*$/.test(f.destination));
}

/** The instance names a `dns-sd -B` of `service` saw added and not removed again. @param {string} browse @param {string} service */
function browsed(browse, service) {
  /** @type {Set<string>} */
  const names = new Set();
  const line = new RegExp(`\\s(Add|Rmv)\\s+\\d+\\s+\\d+\\s+\\S+\\s+${service.replace(/\./g, '\\.')}\\.\\s+(.+?)\\s*$`);
  for (const l of browse.split('\n')) {
    const m = line.exec(l);
    if (!m) continue;
    if (m[1] === 'Add') names.add(m[2]);
    else names.delete(m[2]);
  }
  return names;
}

/** A Bonjour name without the " (2)" it gets when a name is seen twice on the network. @param {string} name */
const shownName = (name) => name.replace(/ \(\d+\)$/, '');

/**
 * The /24 networks of this Mac's virtual machines, which aren't machines to add: `a.b.c.`. A bridge counts only with a VM attached (a `vmenet` member): Internet Sharing's bridge has real machines behind it.
 * @param {typeof collect} run
 */
async function vmNetworks(run) {
  const bridges = Object.entries(os.networkInterfaces()).filter(([name]) => /^bridge\d+$/.test(name));
  const nets = await Promise.all(
    bridges.map(async ([name, addrs]) =>
      /member: vmenet/.test(await run('/sbin/ifconfig', [name], 1000))
        ? (addrs ?? []).filter((a) => a.family === 'IPv4').map((a) => a.address.replace(/\d+$/, ''))
        : [],
    ),
  );
  return nets.flat();
}

/**
 * Machines on this network that advertise ssh (a Mac does with Remote Login on), this Mac left out; and Macs that are there (their
 * AirPlay receiver names the model) but do not advertise ssh, which have Remote Login off: offered with that said, so picking one
 * shows how to turn it on and the add continues once it is. A virtual machine running on this Mac is left out too.
 * @param {{ run?: typeof collect, browseMs?: number, self?: () => Promise<string>, vmNets?: () => Promise<string[]> }} [o]
 * @returns {Promise<Found[]>}
 */
async function fromBonjour({
  run = collect,
  browseMs = 1500,
  self = () => run('/usr/sbin/scutil', ['--get', 'LocalHostName'], 2000),
  vmNets = () => vmNetworks(run),
} = {}) {
  const local = await vmNets();
  const onThisMac = (/** @type {string} */ address) => local.some((net) => address.startsWith(net));
  const [ssh, airplay, me] = await Promise.all([
    run('/usr/bin/dns-sd', ['-B', '_ssh._tcp', 'local.'], browseMs),
    run('/usr/bin/dns-sd', ['-B', '_airplay._tcp', 'local.'], browseMs),
    self(),
  ]);
  const names = browsed(ssh, '_ssh._tcp');
  const mine = me.trim().toLowerCase();
  /** @param {string} host */
  const isSelf = (host) => {
    const label = host.replace(/\.local$/i, '').toLowerCase();
    return !!mine && (label === mine || new RegExp(`^${mine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(label));
  };
  /** its IPv4 address, so an ssh config alias for the same machine is recognised as it @param {string} host */
  const ipv4 = async (host) =>
    /\s(\d{1,3}(?:\.\d{1,3}){3})\s/.exec(await run('/usr/bin/dns-sd', ['-G', 'v4', host], 1500, /\s\d{1,3}(?:\.\d{1,3}){3}\s/))?.[1] ??
    host;
  const on = Promise.all(
    [...names].map(async (name) => {
      const at = /can be reached at (\S+?)\.?:(\d+)/.exec(
        await run('/usr/bin/dns-sd', ['-L', name, '_ssh._tcp', 'local.'], 2000, /can be reached at/),
      );
      if (!at || at[2] !== '22' || isSelf(at[1])) return null;
      const address = await ipv4(at[1]);
      if (onThisMac(address)) return null;
      return /** @type {Found} */ ({ source: 'network', name: shownName(name), destination: at[1], detail: '', address });
    }),
  );
  const off = Promise.all(
    [...browsed(airplay, '_airplay._tcp')]
      .filter((name) => !names.has(name))
      .map(async (name) => {
        const said = await run('/usr/bin/dns-sd', ['-L', name, '_airplay._tcp', 'local.'], 2000, /model=\S+/);
        const at = /can be reached at (\S+?)\.?:\d+/.exec(said);
        if (!at || !/\bmodel=(Mac|iMac|MacBook|Macmini|MacPro)/.test(said) || isSelf(at[1])) return null;
        const address = await ipv4(at[1]);
        if (onThisMac(address)) return null;
        return /** @type {Found} */ ({
          source: 'network',
          name: shownName(name),
          destination: at[1],
          detail: 'Remote Login is off',
          address,
          remoteLoginOff: true,
        });
      }),
  );
  const found = [...(await on), ...(await off)].filter((f) => f !== null);
  // two machines that read the same once a " (2)" is gone are told apart by where they are
  return found.map((f) => (!f.detail && found.filter((o) => o.name === f.name).length > 1 ? { ...f, detail: f.destination } : f));
}

/**
 * Online Tailscale peers that run macOS or Linux, when Tailscale is installed.
 * @param {{ run?: typeof collect, exists?: (p: string) => boolean }} [o]
 * @returns {Promise<Found[]>}
 */
async function fromTailscale({ run = collect, exists = (p) => fs.existsSync(p) } = {}) {
  const bin = exists(TAILSCALE_APP) ? TAILSCALE_APP : 'tailscale';
  let status;
  try {
    status = JSON.parse(await run(bin, ['status', '--json'], 3000));
  } catch {
    return [];
  }
  const peers = status && typeof status.Peer === 'object' && status.Peer ? Object.values(status.Peer) : [];
  return peers
    .filter((p) => p && p.Online === true && /^(macOS|linux)$/.test(String(p.OS)) && typeof p.DNSName === 'string' && p.DNSName)
    .map((p) => {
      const host = String(p.DNSName).replace(/\.$/, '');
      return /** @type {Found} */ ({
        source: 'tailscale',
        name: String(p.HostName || host.split('.')[0]),
        destination: host,
        detail: '',
        address: Array.isArray(p.TailscaleIPs) && p.TailscaleIPs[0] ? String(p.TailscaleIPs[0]) : host,
      });
    });
}

/** Where a destination points, for telling one machine from another: its host part, lowercased. @param {string} d */
const hostOf = (d) => d.slice(d.lastIndexOf('@') + 1).toLowerCase();

/**
 * One list for the picker: network machines first, then Tailscale peers, then the rest of the ssh config. A network or Tailscale machine
 * that an ssh config alias also reaches is one row that connects through the alias (so the user's own user, key and port apply).
 * Each row says whether it is already in My machines (by the address it reaches), so the picker opens it instead of installing again.
 * @param {{ network: Found[], tailscale: Found[], config: Found[] }} lists @param {{ address: string }[]} machines
 * @returns {(Found & { added: boolean, alias: string })[]}
 */
function combine({ network, tailscale, config }, machines) {
  const byAddress = new Map(config.map((c) => [hostOf(c.address), c]));
  const used = new Set();
  const rows = [...network, ...tailscale].map((f) => {
    const alias = byAddress.get(hostOf(f.address)) ?? byAddress.get(hostOf(f.destination));
    if (!alias) return { ...f, alias: '' };
    used.add(alias);
    return { ...f, destination: alias.destination, alias: alias.name, detail: f.remoteLoginOff ? f.detail : '' };
  });
  const all = [...rows, ...config.filter((c) => !used.has(c)).map((c) => ({ ...c, alias: '' }))];
  // where each machine in the list really goes: an alias it was added as resolves through the config
  const reach = new Set(
    machines.flatMap((m) => {
      const viaConfig = config.find((c) => c.destination === m.address);
      return [hostOf(m.address), ...(viaConfig ? [hostOf(viaConfig.address)] : [])];
    }),
  );
  return all.map((f) => ({ ...f, added: reach.has(hostOf(f.destination)) || reach.has(hostOf(f.address)) }));
}

/**
 * Everything the picker offers, found in parallel (about a second and a half).
 * @param {{ machines: { address: string }[], home?: string, run?: typeof collect, exists?: (p: string) => boolean }} o
 */
async function discover({ machines, home, run = collect, exists }) {
  const [config, network, tailscale] = await Promise.all([
    fromSshConfig({ home, run }),
    fromBonjour({ run }),
    fromTailscale({ run, exists }),
  ]);
  return combine({ network, tailscale, config }, machines);
}

/**
 * Whether ssh on `destination` answers now (its port open), looked up as ssh would (an alias through the config): the Add machine card
 * asks this every few seconds while a Mac's Remote Login is off, and continues the add once it is on.
 * @param {{ destination: string, run?: typeof collect, connect?: (port: number, host: string) => net.Socket, timeoutMs?: number }} o
 * @returns {Promise<boolean>}
 */
async function reachable({ destination, run = collect, connect = (port, host) => net.connect(port, host), timeoutMs = 2500 }) {
  const { target, args } = sshTarget(normalAddress(destination));
  const v = resolved(await run('ssh', ['-G', ...args, '--', target], 5000));
  const host = v.hostname || target.slice(target.lastIndexOf('@') + 1);
  const port = Number(v.port) || 22;
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const done = (/** @type {boolean} */ ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

module.exports = { reachable, discover, combine, fromSshConfig, fromBonjour, fromTailscale, configAliases, collect, vmNetworks };
