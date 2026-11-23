// What stands in for the app's relay boot in the cloud acceptance run. The app's boot mints a one-time join command through MoPilot's relay with the signed-in account's token, which a run from a script has not got. This one gives the launcher the same four calls (start, view, allow, deny) with a command that lets the run's own SSH key in, and says the machine "asks" once SSH answers: the launcher, its adapter and its waits are the app's own.
import { launcherFor } from './ssh.mjs';
import { NAME } from './limits.mjs';

/** How often the machine is looked at while it boots. */
export const WATCH_MS = 5000;

/**
 * The first-boot script's one line: `nc` (the run reaches the Host's socket with `nc -U`), then the run's key for the Ubuntu user. The key goes last, so SSH answering means the rest is done.
 * @param {string} pub
 */
export const bootCommand = (pub) =>
  [
    'for i in 1 2 3 4 5 6; do command -v nc >/dev/null 2>&1 && break; DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y -qq netcat-openbsd >/dev/null 2>&1 || sleep 10; done',
    'install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh',
    `echo '${pub}' >> /home/ubuntu/.ssh/authorized_keys`,
    'chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys',
    'chmod 600 /home/ubuntu/.ssh/authorized_keys',
  ].join('; ');

/**
 * @param {any} cloud the run's cloud state: `readers`, `addr`, `keyFile`, `pub`, `t`, `deps` (makeChannel, sleep, now)
 * @returns {(o: { onView: (view: any) => void }) => { start(): Promise<any>, view(): any, allow(extra?: any): { id: string }, deny(): void }}
 */
export function createStandInBoot(cloud) {
  return ({ onView }) => {
    let view = { state: 'idle', command: '', expiresAt: 0, machine: null, error: '' };
    let live = false;
    /** @param {string} state @param {string} [command] */
    const set = (state, command = view.command) => {
      view = { ...view, state, command };
      onView(view);
    };
    async function watch() {
      const channel = cloud.deps.makeChannel(launcherFor(cloud.addr, cloud.keyFile));
      while (live) {
        try {
          const machine = (await cloud.readers.instances()).find((m) => m.name.startsWith(`${NAME}-`) && m.state === 'RUNNING');
          const ip = machine ? await cloud.readers.address(machine.id) : null;
          if (ip) {
            cloud.addr.ip = ip;
            if (live && (await channel.run('true')).code === 0) {
              cloud.t.ssh = cloud.deps.now();
              return set('asking');
            }
          }
        } catch (error) {
          // a read that failed is tried again at the next look; a launch that then fails says what the watch last saw
          cloud.watchError = /** @type {Error} */ (error).message;
        }
        await cloud.deps.sleep(WATCH_MS);
      }
    }
    return {
      async start() {
        live = true;
        set('waiting', bootCommand(cloud.pub));
        void watch();
        return view;
      },
      view: () => view,
      allow(extra) {
        live = false;
        return { id: String(extra?.cloud?.id) };
      },
      deny() {
        live = false;
      },
    };
  };
}
