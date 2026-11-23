// A stand-in Oracle Cloud for the cloud acceptance run's tests: a `fetch` that keeps instances and disks, answers the calls the app's OCI adapter and the run's readers make, and logs every request. A fake Host reached through the channel completes the machine.
export const CONFIG = {
  tenancy: 'ocid1.tenancy.t',
  user: 'ocid1.user.u',
  fingerprint: 'aa:bb',
  region: 'us-phoenix-1',
  compartmentId: 'ocid1.compartment.c',
  subnetId: 'ocid1.subnet.s',
};
export const ADS = ['xYz:PHX-AD-1', 'xYz:PHX-AD-2', 'xYz:PHX-AD-3'];

export type OciOptions = {
  /** availability domains that have no capacity */
  capacityIn?: string[];
  /** a deleted machine leaves its disk AVAILABLE until the disk itself is deleted */
  keepDisk?: boolean;
  /** a machine that cannot be deleted */
  deleteRefused?: boolean;
  /** SOFTSTOP leaves the machine STOPPING */
  stopStuck?: boolean;
  /** the machine has no public address after it is started again */
  noAddressAfterStart?: boolean;
  /** something already in the compartment */
  preExisting?: boolean;
  /** the machine cannot be made: OCI's own code */
  createRefused?: string;
  /** a delete is accepted and changes nothing */
  deleteIgnored?: boolean;
  /** a block volume appears with the machine */
  strayBlockVolume?: boolean;
  /** the instance list fails this many times, once it has answered `listOkFirst` times */
  listFailures?: number;
  listOkFirst?: number;
};

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

export function fakeOci(o: OciOptions = {}) {
  const s = {
    instances: new Map<string, { id: string; displayName: string; lifecycleState: string; ad: string; started: number }>(),
    disks: new Map<string, { id: string; lifecycleState: string; sizeInGBs: number; ad: string }>(),
    blocks: new Map<string, { id: string; lifecycleState: string; sizeInGBs: number }>(),
    log: [] as string[],
    creates: [] as any[],
    actions: [] as string[],
    deletes: [] as string[],
    seq: 0,
    starts: 0,
    listFailures: o.listFailures ?? 0,
    lists: 0,
  };
  if (o.preExisting) s.instances.set('pre', { id: 'pre', displayName: 'prod-thing', lifecycleState: 'RUNNING', ad: ADS[0], started: 0 });
  const live = (m: { lifecycleState: string }) => m.lifecycleState !== 'TERMINATED';
  const fetch = async (url: string, init: any) => {
    const u = new URL(url);
    const p = u.pathname.replace('/20160918', '');
    const method = init.method as string;
    s.log.push(`${method} ${p}${u.search}`);
    if (!init.headers.authorization?.startsWith('Signature version="1"')) return ok({ code: 'NotAuthenticated' }, 401);
    const id = decodeURIComponent(p.split('/')[2] ?? '');
    if (method === 'GET') {
      if (p === '/regions') return ok([{ name: CONFIG.region }, { name: 'us-ashburn-1' }]);
      if (p === '/availabilityDomains') return ok(ADS.map((name) => ({ name })));
      if (p === '/instances') {
        if (++s.lists > (o.listOkFirst ?? 0) && s.listFailures > 0) {
          s.listFailures--;
          return ok({ code: 'InternalError', message: 'try again' }, 500);
        }
        return ok([...s.instances.values()].map((m) => ({ id: m.id, displayName: m.displayName, lifecycleState: m.lifecycleState })));
      }
      if (p.startsWith('/instances/')) {
        const m = s.instances.get(id);
        if (!m) return ok({ code: 'NotAuthorizedOrNotFound' }, 404);
        if (m.lifecycleState === 'PROVISIONING') m.lifecycleState = 'RUNNING';
        return ok({ id, lifecycleState: m.lifecycleState });
      }
      if (p === '/bootVolumes')
        return ok(
          [...s.disks.values()].filter((d) => d.lifecycleState !== 'TERMINATED' && d.ad === u.searchParams.get('availabilityDomain')),
        );
      if (p === '/volumes') return ok([...s.blocks.values()].filter((d) => d.lifecycleState !== 'TERMINATED'));
      if (p === '/vnicAttachments') {
        const m = s.instances.get(u.searchParams.get('instanceId') ?? '');
        return ok(m ? [{ lifecycleState: 'ATTACHED', vnicId: `vnic-${m.id}` }] : []);
      }
      if (p.startsWith('/vnics/')) {
        const m = [...s.instances.values()].at(-1);
        const hidden = o.noAddressAfterStart && s.starts > 0;
        return ok(m && !hidden ? { publicIp: '203.0.113.7' } : {});
      }
      if (p === '/shapes') return ok([{ shape: 'VM.Standard.A1.Flex' }]);
      if (p === '/images') return ok([{ id: 'ocid1.image.i', displayName: 'Canonical-Ubuntu-24.04-aarch64' }]);
      if (p.startsWith('/subnets/'))
        return ok({
          lifecycleState: 'AVAILABLE',
          cidrBlock: '10.0.0.0/24',
          prohibitPublicIpOnVnic: false,
          securityListIds: ['sl'],
          routeTableId: 'rt',
        });
      if (p.startsWith('/securityLists/'))
        return ok({
          ingressSecurityRules: [{ source: '0.0.0.0/0', protocol: 'all' }],
          egressSecurityRules: [{ destination: '0.0.0.0/0', protocol: 'all' }],
        });
      if (p.startsWith('/routeTables/'))
        return ok({ routeRules: [{ destination: '0.0.0.0/0', networkEntityId: 'ocid1.internetgateway.x' }] });
    }
    if (method === 'POST' && p === '/instances') {
      const body = JSON.parse(init.body);
      s.creates.push(body);
      if (o.createRefused) return ok({ code: o.createRefused, message: 'The account is at its limit.' }, 400);
      if (o.capacityIn?.includes(body.availabilityDomain))
        return ok({ code: 'OutOfHostCapacity', message: 'Out of host capacity for shape VM.Standard.A1.Flex.' }, 500);
      const made = {
        id: `ocid1.instance.${++s.seq}`,
        displayName: body.displayName,
        lifecycleState: 'PROVISIONING',
        ad: body.availabilityDomain,
        started: 0,
      };
      s.instances.set(made.id, made);
      s.disks.set(`disk-${made.id}`, {
        id: `disk-${made.id}`,
        lifecycleState: 'AVAILABLE',
        sizeInGBs: body.sourceDetails.bootVolumeSizeInGBs,
        ad: body.availabilityDomain,
      });
      if (o.strayBlockVolume) s.blocks.set(`block-${made.id}`, { id: `block-${made.id}`, lifecycleState: 'AVAILABLE', sizeInGBs: 10 });
      return ok({ id: made.id });
    }
    if (method === 'POST' && p.startsWith('/instances/')) {
      const action = u.searchParams.get('action') as string;
      s.actions.push(action);
      const m = s.instances.get(id)!;
      if (action === 'SOFTSTOP') m.lifecycleState = o.stopStuck ? 'STOPPING' : 'STOPPED';
      else {
        s.starts++;
        m.lifecycleState = 'RUNNING';
      }
      return ok({ id });
    }
    if (method === 'DELETE' && p.startsWith('/instances/')) {
      s.deletes.push(p);
      if (o.deleteIgnored) return ok({});
      if (o.deleteRefused) return ok({ code: 'InternalError', message: 'cannot delete now' }, 500);
      const m = s.instances.get(id);
      if (!m || !live(m)) return ok({ code: 'NotAuthorizedOrNotFound' }, 404);
      m.lifecycleState = 'TERMINATED';
      if (!o.keepDisk && u.searchParams.get('preserveBootVolume') === 'false') s.disks.get(`disk-${id}`)!.lifecycleState = 'TERMINATED';
      return ok({});
    }
    if (method === 'DELETE' && p.startsWith('/volumes/')) {
      s.deletes.push(p);
      s.blocks.get(id)!.lifecycleState = 'TERMINATED';
      return ok({});
    }
    if (method === 'DELETE' && p.startsWith('/bootVolumes/')) {
      s.deletes.push(p);
      s.disks.get(id)!.lifecycleState = 'TERMINATED';
      return ok({});
    }
    return ok({ code: 'NotFound', message: `no stand-in answer for ${method} ${p}` }, 404);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, state: s };
}

/** The fake Host on the machine, as the run's channel reaches it. */
export type HostOptions = {
  /** probes of `true` that fail before SSH answers */
  sshFailures?: number;
  noNc?: boolean;
  askFails?: boolean;
  notLinux?: boolean;
  noNode?: boolean;
  /** the Host answers only after this many looks following a start */
  slowHost?: number;
};

export function fakeHost(oci: ReturnType<typeof fakeOci>, o: HostOptions = {}) {
  const seen = { launchers: [] as string[][], probes: 0, looks: 0 };
  let sshFailures = o.sshFailures ?? 0;
  /** looks since the machine was last started */
  let sinceStart = 0;
  let starts = 0;
  const makeChannel = (launcher: (command: string, stdin: boolean) => { bin: string; args: string[] }) => {
    const respond = (command: string) => {
      const m = [...oci.state.instances.values()].at(-1);
      const running = m?.lifecycleState === 'RUNNING';
      if (command === 'true')
        return running && sshFailures-- <= 0 ? { code: 0, stdout: '', stderr: '' } : { code: 255, stdout: '', stderr: 'refused' };
      if (command.startsWith('uname -sm')) {
        if (o.askFails) return { code: 255, stdout: '', stderr: 'Permission denied' };
        return {
          code: 0,
          stdout: `${o.notLinux ? 'Darwin arm64' : 'Linux aarch64'}\n${o.noNc ? '' : 'have nc\n'}have loginctl\n`,
          stderr: '',
        };
      }
      if (command.includes('.mopilot-host/runtime')) {
        return o.noNode
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 0, stdout: '/home/ubuntu/.mopilot-host/runtime/current/bin/node\n', stderr: '' };
      }
      if (command.includes('pgrep')) {
        if (oci.state.starts !== starts) (starts = oci.state.starts), (sinceStart = 0);
        seen.looks++;
        const up = running && ++sinceStart > (starts > 0 ? (o.slowHost ?? 0) : 0);
        return { code: 0, stdout: up ? '4242\n' : '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    return {
      async run(command: string) {
        seen.launchers.push(launcher(command, false).args);
        return respond(command);
      },
      open(command: string) {
        seen.launchers.push(launcher(command, true).args);
        let fn: (chunk: string) => void = () => undefined;
        return {
          write(text: string) {
            for (const line of text.split('\n').filter(Boolean)) {
              const { id, method, params } = JSON.parse(line);
              const answer = method === 'host.hello' ? { agreed: true } : method === 'status' ? { running: true } : {};
              setImmediate(() => fn(`${JSON.stringify({ id, result: answer })}\n`));
              if (method === 'chat.start')
                setImmediate(() =>
                  setImmediate(() =>
                    fn(
                      `${JSON.stringify({ chatId: params.chatId, frame: { item: { t: 'assistant', text: `fake-acp: ${params.text}`, stopReason: 'end_turn' } } })}\n`,
                    ),
                  ),
                );
            }
          },
          onData(f: (chunk: string) => void) {
            fn = f;
          },
          kill() {},
          closed: new Promise(() => undefined),
        };
      },
    };
  };
  return { makeChannel: makeChannel as any, seen };
}
