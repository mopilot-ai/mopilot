// Machines the Add machine picker offers (electron/host/discovery.cjs): concrete hosts of the ssh config and its Includes resolved with ssh -G, Bonjour ssh services on this network without this Mac (real dns-sd output), online Tailscale peers, one row for a machine both found and in the config, and Added for what is already in My machines.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeProc } from './support/ports/proc.ts';
const require = createRequire(import.meta.url);
const {
  discover,
  reachable,
  combine,
  fromSshConfig,
  fromBonjour,
  vmNetworks,
  fromTailscale,
  configAliases,
  collect,
} = require('../electron/host/discovery.cjs');
import { EventEmitter } from 'node:events';
const { register } = require('../electron/app/ipc/host.cjs');

const tmp = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('the ssh config gives its concrete hosts, through Includes (relative, ~, absolute, globbed), never HostName lines or patterns', (t) => {
  const home = tmp(t);
  const ssh = path.join(home, '.ssh');
  fs.mkdirSync(path.join(ssh, 'conf.d'), { recursive: true });
  fs.writeFileSync(
    path.join(ssh, 'config'),
    [
      'Host mac-mini-test  # the mini',
      '  HostName 192.168.86.151',
      'Host=box other *.corp !bad gpu?',
      'Include conf.d/*.conf ~/extra.conf /nowhere/x.conf',
      'Include missing-dir/*.conf',
      'Host box',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(ssh, 'conf.d', 'a.conf'), 'Host alpha\nInclude loop.conf\n');
  fs.writeFileSync(path.join(ssh, 'conf.d', 'b.txt'), 'Host not-included\n');
  fs.writeFileSync(path.join(ssh, 'loop.conf'), 'Host looped\nInclude loop.conf\n');
  fs.writeFileSync(path.join(home, 'extra.conf'), 'host Beta\n');
  assert.deepEqual(configAliases(path.join(ssh, 'config'), home), ['mac-mini-test', 'box', 'other', 'alpha', 'looped', 'Beta']);
  assert.deepEqual(configAliases(path.join(ssh, 'none'), home), []);
});

test('each config host is resolved by ssh itself: user, host name and a port other than 22; a name ssh would read as an option is left out', async (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host mini oci bare -oProxy\n');
  const asked: string[][] = [];
  const run = async (bin: string, args: string[]) => {
    asked.push([bin, ...args]);
    const alias = args.at(-1);
    if (alias === 'mini') return 'user daxhill\nhostname 192.168.86.151\nport 22\n';
    if (alias === 'oci') return 'user ubuntu\nhostname 203.0.113.10\nport 2222\n';
    return '';
  };
  assert.deepEqual(await fromSshConfig({ home, run }), [
    { source: 'config', name: 'mini', destination: 'mini', detail: 'daxhill@192.168.86.151', address: '192.168.86.151' },
    { source: 'config', name: 'oci', destination: 'oci', detail: 'ubuntu@203.0.113.10:2222', address: '203.0.113.10' },
    { source: 'config', name: 'bare', destination: 'bare', detail: 'bare', address: 'bare' },
  ]);
  assert.deepEqual(asked[0], ['ssh', '-G', '--', 'mini']);
});

// as dns-sd prints them on macOS 27 (captured)
const BROWSE = `Browsing for _ssh._tcp.local.
DATE: ---Sun 01 Nov 2026---
16:55:10.587  ...STARTING...
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
16:55:10.588  Add        3  14 local.               _ssh._tcp.           DUs-MacBook-Pro
16:55:10.589  Add        3  14 local.               _ssh._tcp.           Gone box
16:55:10.700  Add        2  14 local.               _ssh._tcp.           Du’s Mac mini
16:55:10.800  Add        2  14 local.               _ssh._tcp.           Odd port
16:55:10.810  Add        2  14 local.               _ssh._tcp.           Silent
16:55:10.820  Add        2  14 local.               _ssh._tcp.           Twin (2)
16:55:10.900  Rmv        0  14 local.               _ssh._tcp.           Gone box
`;
const reached = (host: string, port = 22) =>
  `Lookup Du’s Mac mini._ssh._tcp.local\nDATE: ---Sun 01 Nov 2026---\n16:55:21.577  ...STARTING...\n16:55:21.584  Du’s\\032Mac\\032mini._ssh._tcp.local. can be reached at ${host}.:${port} (interface 14)\n`;

test('Bonjour gives the machines that advertise ssh here, by their own names, without this Mac, a removed one or another port', async () => {
  const run = async (bin: string, args: string[]) => {
    if (args[0] === '-B') return BROWSE;
    if (args[0] === '-G')
      return args[2] === 'Dus-Mac-mini.local' ? '20:06:57.014  Add  40000002      14  Dus-Mac-mini.local.   192.168.86.151   4500\n' : '';
    const name = args[1];
    if (name === 'DUs-MacBook-Pro') return reached('DUs-MacBook-Pro.local');
    if (name === 'Du’s Mac mini') return reached('Dus-Mac-mini.local');
    if (name === 'Odd port') return reached('odd.local', 2222);
    if (name === 'Twin (2)') return reached('dus-macbook-pro-2.local');
    return '';
  };
  assert.deepEqual(await fromBonjour({ run, self: async () => 'DUs-MacBook-Pro\n' }), [
    {
      source: 'network',
      name: 'Du’s Mac mini',
      destination: 'Dus-Mac-mini.local',
      detail: '',
      address: '192.168.86.151',
    },
  ]);
  // with no name for this Mac, nothing is taken for it; a machine without an IPv4 answer keeps its host name
  const all = await fromBonjour({ run, self: async () => '' });
  assert.deepEqual(
    all.map((f: any) => [f.name, f.address]),
    [
      ['DUs-MacBook-Pro', 'DUs-MacBook-Pro.local'],
      ['Du’s Mac mini', '192.168.86.151'],
      ['Twin', 'dus-macbook-pro-2.local'],
    ],
  );
  assert.deepEqual(await fromBonjour({ run: async () => '' }), []);
  // a virtual machine running on this Mac isn't a machine to add, and a name seen twice on the network drops its " (2)"
  const dig = (host: string) => (host === 'vm.local' ? '192.168.64.2' : '192.168.86.73');
  const twoNames = async (bin: string, args: string[]) => {
    if (args[0] === '-B' && args[1] === '_ssh._tcp')
      return 'A/R\n1:00:00.000  Add  3  36 local.  _ssh._tcp.  Managed’s Virtual Machine\n1:00:00.000  Add  2  14 local.  _ssh._tcp.  daxhill-mac (2)\n';
    if (args[0] === '-L' && args[1] === 'Managed’s Virtual Machine') return 'x can be reached at vm.local.:22 (interface 36)';
    if (args[0] === '-L' && args[1] === 'daxhill-mac (2)') return 'x can be reached at daxhill-mac.local.:22 (interface 14)';
    if (args[0] === '-G') return ` Add 2 14 ${args[2]}. ${dig(args[2])} 120 `;
    return '';
  };
  assert.deepEqual(
    (await fromBonjour({ run: twoNames as any, self: async () => 'me', vmNets: async () => ['192.168.64.'] })).map((f: any) => [
      f.name,
      f.address,
    ]),
    [['daxhill-mac', '192.168.86.73']],
  );
  // a VM that offers only AirPlay is left out too
  assert.deepEqual(
    await fromBonjour({
      run: (async (_bin: string, args: string[]) => {
        if (args[0] === '-B' && args[1] === '_airplay._tcp') return 'A/R\n1:00:00.000  Add  3  36 local.  _airplay._tcp.  Guest\n';
        if (args[0] === '-L' && args[1] === 'Guest') return 'x can be reached at vm.local.:7000 (interface 36) model=MacBookPro';
        if (args[0] === '-G') return ' Add 2 36 vm.local. 192.168.64.2 120 ';
        return '';
      }) as any,
      self: async () => 'me',
      vmNets: async () => ['192.168.64.'],
    }),
    [],
  );
  // the same name twice is told apart by where it is
  const twins = await fromBonjour({
    run: (async (_bin: string, args: string[]) => {
      if (args[0] === '-B' && args[1] === '_ssh._tcp')
        return 'A/R\n1:00:00.000  Add  3  14 local.  _ssh._tcp.  Mini\n1:00:00.000  Add  2  14 local.  _ssh._tcp.  Mini (2)\n';
      if (args[0] === '-L' && args[1] === 'Mini') return 'x can be reached at a.local.:22 (interface 14)';
      if (args[0] === '-L' && args[1] === 'Mini (2)') return 'x can be reached at b.local.:22 (interface 14)';
      return '';
    }) as any,
    self: async () => 'me',
    vmNets: async () => [],
  });
  assert.deepEqual(
    twins.map((f: any) => [f.name, f.detail]),
    [
      ['Mini', 'a.local'],
      ['Mini', 'b.local'],
    ],
  );
});

const AIRPLAY = `Browsing for _airplay._tcp.local.
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
20:38:55.100  Add        3  14 local.               _airplay._tcp.       Du’s Mac mini
20:38:55.101  Add        3  14 local.               _airplay._tcp.       Office iMac
20:38:55.102  Add        3  14 local.               _airplay._tcp.       Samsung 8 Series (55)
20:38:55.103  Add        3  14 local.               _airplay._tcp.       DUs-MacBook-Pro
20:38:55.104  Add        2  14 local.               _airplay._tcp.       Quiet Mac
`;
const airplayAt = (host: string, model: string) =>
  `Lookup x._airplay._tcp.local\n20:38:55.469  x._airplay._tcp.local. can be reached at ${host}.:7000 (interface 14)\n acl=0 deviceid=AA model=${model} srcvers=870.14.1\n`;

test('a Mac that is here (its AirPlay names the model) but offers no ssh has Remote Login off, and is offered as such; a TV, this Mac and one that does offer ssh are not', async () => {
  const run = async (_bin: string, args: string[]) => {
    if (args[0] === '-B') return args[1] === '_ssh._tcp' ? BROWSE : AIRPLAY;
    if (args[0] === '-G')
      return args[2] === 'office-imac.local' ? '20:39:00.000  Add  2  14  office-imac.local.   192.168.86.20   120\n' : '';
    if (args[2] === '_airplay._tcp') {
      if (args[1] === 'Office iMac') return airplayAt('office-imac.local', 'iMac21,1');
      if (args[1] === 'Samsung 8 Series (55)') return airplayAt('samsung.local', 'QN55Q80');
      if (args[1] === 'DUs-MacBook-Pro') return airplayAt('DUs-MacBook-Pro.local', 'Mac14,6');
      return '';
    }
    return args[1] === 'Du’s Mac mini' ? reached('Dus-Mac-mini.local') : '';
  };
  const rows = await fromBonjour({ run, self: async () => 'DUs-MacBook-Pro' });
  assert.deepEqual(
    rows.map((f: any) => [f.name, f.destination, f.address, f.detail, !!f.remoteLoginOff]),
    [
      ['Du’s Mac mini', 'Dus-Mac-mini.local', 'Dus-Mac-mini.local', '', false],
      ['Office iMac', 'office-imac.local', '192.168.86.20', 'Remote Login is off', true],
    ],
  );
});

class Sock extends EventEmitter {
  destroyed = false;
  timeout = 0;
  onTimeout = () => {};
  setTimeout(ms: number, fn: () => void) {
    this.timeout = ms;
    this.onTimeout = fn;
  }
  destroy() {
    this.destroyed = true;
  }
}
test('whether ssh answers now: looked up as ssh would (an alias, its port), then one TCP connect, closed again', async () => {
  const dialed: [number, string][] = [];
  let next: (s: Sock) => void = (s) => setImmediate(() => s.emit('connect'));
  const connect = (port: number, host: string) => {
    dialed.push([port, host]);
    const s = new Sock();
    next(s);
    return s as any;
  };
  const run = async (_b: string, args: string[]) => (args.at(-1) === 'mini' ? 'hostname 192.168.86.151\nport 2222\n' : '');
  assert.equal(await reachable({ destination: 'mini', run, connect }), true);
  assert.equal(await reachable({ destination: 'me@studio.local', run, connect }), true);
  assert.deepEqual(dialed, [
    [2222, '192.168.86.151'],
    [22, 'studio.local'],
  ]);
  next = (s) => setImmediate(() => s.emit('error', new Error('ECONNREFUSED')));
  assert.equal(await reachable({ destination: 'mini', run, connect }), false);
  let last: Sock | null = null;
  next = (s) => {
    last = s;
    setImmediate(() => s.onTimeout());
  };
  assert.equal(await reachable({ destination: 'mini', run, connect, timeoutMs: 10 }), false);
  assert.equal((last as unknown as Sock).destroyed, true);
  // the real lookup and socket, against a port nothing listens on
  assert.equal(await reachable({ destination: '127.0.0.1', run: async () => 'hostname 127.0.0.1\nport 1\n' }), false);
});

test('Tailscale gives its online macOS and Linux peers by MagicDNS name, from the app or the PATH; anything unreadable gives nothing', async () => {
  const status = {
    Peer: {
      a: { HostName: 'gpu-box', DNSName: 'gpu-box.tail1234.ts.net.', OS: 'linux', Online: true, TailscaleIPs: ['100.64.0.5', 'fd7a::5'] },
      b: { HostName: 'phone', DNSName: 'phone.tail1234.ts.net.', OS: 'iOS', Online: true },
      c: { HostName: 'old', DNSName: 'old.tail1234.ts.net.', OS: 'macOS', Online: false },
      d: { DNSName: 'studio.tail1234.ts.net.', OS: 'macOS', Online: true },
      e: { HostName: 'nodns', OS: 'linux', Online: true },
      f: null,
    },
  };
  const bins: string[] = [];
  const run = async (bin: string) => (bins.push(bin), JSON.stringify(status));
  assert.deepEqual(await fromTailscale({ run, exists: () => true }), [
    {
      source: 'tailscale',
      name: 'gpu-box',
      destination: 'gpu-box.tail1234.ts.net',
      detail: '',
      address: '100.64.0.5',
    },
    {
      source: 'tailscale',
      name: 'studio',
      destination: 'studio.tail1234.ts.net',
      detail: '',
      address: 'studio.tail1234.ts.net',
    },
  ]);
  await fromTailscale({ run, exists: () => false });
  assert.deepEqual(bins, ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale']);
  assert.deepEqual(await fromTailscale({ run: async () => 'not json', exists: () => false }), []);
  assert.deepEqual(await fromTailscale({ run: async () => '{}', exists: () => false }), []);
  assert.deepEqual(await fromTailscale({ run: async () => 'null', exists: () => false }), []);
  // by default it looks for the app on disk
  assert.equal((await fromTailscale({ run: async () => '{}' })).length, 0);
});

test('a machine found here and named in the ssh config is one row that connects through the alias; what is in My machines says Added', () => {
  const mini = {
    source: 'network',
    name: 'Du’s Mac mini',
    destination: 'Dus-Mac-mini.local',
    detail: 'Dus-Mac-mini.local',
    address: '192.168.86.151',
  };
  const ts = { source: 'tailscale', name: 'gpu', destination: 'gpu.ts.net', detail: 'gpu.ts.net', address: '100.64.0.5' };
  const vm = { source: 'network', name: 'VM', destination: 'vm.local', detail: 'vm.local', address: 'vm.local' };
  const cfgMini = {
    source: 'config',
    name: 'mac-mini-test',
    destination: 'mac-mini-test',
    detail: 'daxhill@192.168.86.151',
    address: '192.168.86.151',
  };
  const cfgGpu = { source: 'config', name: 'gpu', destination: 'gpu', detail: 'me@gpu.ts.net', address: 'gpu.ts.net' };
  const cfgOci = { source: 'config', name: 'oci', destination: 'oci', detail: 'ubuntu@1.2.3.4', address: '1.2.3.4' };
  const rows = combine({ network: [mini, vm], tailscale: [ts], config: [cfgMini, cfgGpu, cfgOci] }, [
    { address: 'mac-mini-test' },
    { address: 'me@vm.local' },
  ]);
  assert.deepEqual(
    rows.map((r: any) => [r.source, r.name, r.destination, r.alias, r.added, r.detail]),
    [
      ['network', 'Du’s Mac mini', 'mac-mini-test', 'mac-mini-test', true, ''],
      ['network', 'VM', 'vm.local', '', true, 'vm.local'],
      ['tailscale', 'gpu', 'gpu', 'gpu', false, ''],
      ['config', 'oci', 'oci', '', false, 'ubuntu@1.2.3.4'],
    ],
  );
});

test('discover runs the three in parallel and combines them', async (t) => {
  const home = tmp(t);
  const run = async (bin: string, args: string[]) =>
    args[0] === '-B' ? BROWSE : bin.endsWith('scutil') ? 'nobody' : args[1] === 'Du’s Mac mini' ? reached('Dus-Mac-mini.local') : '';
  const rows = await discover({ machines: [], home, run, exists: () => false });
  assert.deepEqual(
    rows.map((r: any) => r.name),
    ['Du’s Mac mini'],
  );
});

test('a program’s output: all of it when it ends, what it printed when stopped, as soon as it is enough; a program that cannot start gives nothing', async (t) => {
  assert.equal(await collect('/bin/sh', ['-c', 'echo done'], 5000), 'done\n');
  const started = Date.now();
  assert.equal(await collect('/bin/sh', ['-c', 'echo first; exec sleep 5'], 300), 'first\n');
  assert.ok(Date.now() - started < 3000);
  const early = Date.now();
  assert.match(
    await collect('/bin/sh', ['-c', 'echo "can be reached at x.local.:22"; exec sleep 5'], 5000, /can be reached at/),
    /x\.local/,
  );
  assert.ok(Date.now() - early < 3000);
  useFakeProc(t, {
    spawn: () => {
      throw new Error('EMFILE');
    },
  });
  assert.equal(await collect('ssh', [], 100), '');
});

test('IPC: the picker asks only when it opens, with the machines already added', async () => {
  const handlers = new Map<string, any>();
  const seen: { machines?: unknown } = {};
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      allowed: () => true,
      create: () => ({ list: () => ({ machines: [{ id: 'ssh:mac-mini-test' }, { id: 'ssh:me@box' }], resolved: true }) }),
      find: async (o: any) => (Object.assign(seen, o), [{ name: 'x' }]),
      probePort: async (o: any) => o.destination === 'me@box',
    },
  );
  assert.equal(seen.machines, undefined, 'nothing is looked for before a window asks');
  assert.deepEqual(await handlers.get('host:discover')({}), { value: [{ name: 'x' }] });
  assert.deepEqual(await handlers.get('host:reachable')({}, 'me@box'), { value: true });
  assert.deepEqual(await handlers.get('host:reachable')({}), { value: false });
  assert.deepEqual(seen.machines, [{ address: 'mac-mini-test' }, { address: 'me@box' }]);
});

test('a bridge with a VM on it hides its network; Internet Sharing’s, with real machines behind it, does not', async () => {
  const ifaces = mock.method(os, 'networkInterfaces', () => ({
    bridge100: [{ family: 'IPv4', address: '192.168.64.1' }],
    bridge101: [{ family: 'IPv4', address: '192.168.2.1' }],
    bridge102: [{ family: 'IPv6', address: 'fe80::1' }],
    bridge103: undefined,
    en0: [{ family: 'IPv4', address: '192.168.86.2' }],
  }));
  const asked: string[] = [];
  const run = async (_bin: string, [name]: string[]) => {
    asked.push(name);
    return name === 'bridge101' ? 'member: en5 flags=3' : 'member: vmenet0 flags=3';
  };
  assert.deepEqual(await vmNetworks(run as any), ['192.168.64.']);
  assert.ok(!asked.includes('en0'));
  ifaces.mock.restore();
});

test('a machine with Remote Login off keeps saying so when an ssh config alias reaches it', () => {
  const [row] = combine(
    {
      network: [
        {
          source: 'network',
          name: 'Mini',
          destination: 'mini.local',
          detail: 'Remote Login is off',
          address: '1.2.3.4',
          remoteLoginOff: true,
        },
      ],
      tailscale: [],
      config: [{ source: 'config', name: 'mini', destination: 'mini', detail: 'me@1.2.3.4', address: '1.2.3.4' }],
    },
    [],
  );
  assert.equal(row.detail, 'Remote Login is off');
  assert.equal(row.destination, 'mini');
});
