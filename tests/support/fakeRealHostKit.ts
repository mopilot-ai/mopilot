// The acceptance run's pieces as stand-ins for the dev host's real Host (scripts/mobile-dev-host/realHost.mjs): they keep what they were asked, and the Host they open answers the Mac's enrollment courier.

export const key = (c: string) => `${c.repeat(43)}=`;

/** A kit that keeps what it was asked, with a Host that answers the courier's calls. */
export function fakeKit(
  o: { harnesses?: any[] | null; pending?: any[]; failStep?: boolean; forwarder?: { code: number; stdout: string; stderr: string } } = {},
) {
  const calls: any[][] = [];
  const hostCalls: any[][] = [];
  const ran: string[] = [];
  const ctx = {
    state: { nodePath: '/opt/node' },
    m: {
      run: async (command: string) => (
        ran.push(command),
        command.includes('nohup') ? (o.forwarder ?? { code: 0, stdout: '4321\n', stderr: '' }) : { code: 0, stdout: '', stderr: '' }
      ),
    },
  };
  const k = {
    makeCtx: (vm: string) => (calls.push(['makeCtx', vm]), ctx),
    runSteps: async (a: any) => (
      calls.push(['runSteps', a.only, a.ctx === ctx]),
      [
        { id: 'A1', title: 'The machine can run the Host', status: 'PASS', detail: 'Linux' },
        o.failStep
          ? { id: 'A5', title: 'Pair', status: 'FAIL', detail: 'refused' }
          : { id: 'A5', title: 'Pair', status: 'PASS', detail: 'ok' },
      ]
    ),
    STEPS: ['steps'] as any[],
    session: async () => ({
      request: async (method: string, params: any) => {
        hostCalls.push([method, params]);
        return (
          (
            {
              'host.hello': { features: ['clients', 'relay'], agreed: true },
              'host.challenge': { hostId: 'hostkey1' },
              'host.clientAdd': { fingerprint: 'fp1' },
              status: {
                harnesses:
                  (o.harnesses as any[] | null) === null
                    ? undefined
                    : (o.harnesses ?? [
                        { id: 'fake', detected: true, signedIn: true },
                        { id: 'claude', detected: true, signedIn: false, signIn: ['login', 'api-key'] },
                        { id: 'codex', detected: false, signedIn: false },
                      ]),
              },
              'host.pending': { cards: o.pending ?? [] },
              'host.relayEnroll': { hostPub: key('P'), hostEphPub: key('Q') },
            } as Record<string, any>
          )[method] ?? {}
        );
      },
      close: () => void hostCalls.push(['close']),
    }),
    provideFakeAgent: async () => void calls.push(['provideFakeAgent']),
    restart: async () => void calls.push(['restart']),
    hostUp: async () => void calls.push(['hostUp']),
    removeTestAgent: async (_c: any, opts: any) => void calls.push(['removeTestAgent', opts]),
    cleanup: async () => void calls.push(['cleanup']),
  };
  return { k, calls, hostCalls, ran };
}
