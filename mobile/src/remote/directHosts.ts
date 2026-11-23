// The phone's direct path to its Hosts, made once per signed-in vault (X3): the Host lane on the relay (`?as=hostlink`, the account's token), the sessions of shared/remote/phoneHosts.mjs on it, and the card store the machine page reads.
import { createPhoneRelay } from '../../../shared/remote/phoneRelay.mjs';
import { createPhoneHosts } from '../../../shared/remote/phoneHosts.mjs';
import { createCardStore } from './hostCards';
import { createHostChatKit, type StartedChat } from './hostChat';

type Prim = Parameters<typeof createPhoneHosts>[0]['prim'];
type Vault = Parameters<typeof createPhoneHosts>[0]['vault'];

/** The Host lane's address for the relay's WebSocket URL. */
export const hostLaneUrl = (url: string) => `${url}${url.includes('?') ? '&' : '?'}as=hostlink`;

const bytesHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export type DirectHosts = ReturnType<typeof createDirectHosts>;

export function createDirectHosts(o: {
  prim: Prim;
  vault: Vault & {
    /** The chats the phone started on each Host, kept in the vault (phoneVault.mjs); a vault without them keeps none. */
    getStarted?: () => Promise<Record<string, unknown>>;
    setStarted?: (machineId: string, chats: StartedChat[]) => Promise<unknown>;
  };
  relayUrl: string;
  auth: { relayToken: () => Promise<string> };
  // biome-ignore lint/suspicious/noExplicitAny: the platform's WebSocket, typed by createPhoneRelay's own contract
  open: (url: string, token: string) => any;
  deviceName: () => string;
  /** The host-chat flag (hostChatFlag.ts): read for every chat, and told what the Mac says. */
  hostChat?: {
    on: () => boolean;
    why: () => 'saved' | 'build' | 'mac' | 'off';
    told: (on: boolean, mac?: string) => void;
    subscribe: (fn: () => void) => () => void;
  };
  /** A request to the Mac over the phone channel (`machines.enroll`, `machines.forget`). */
  // biome-ignore lint/suspicious/noExplicitAny: the Mac's answers are read by shared/remote/phoneDirectEnroll.mjs, which checks them
  request: (method: string, params: Record<string, unknown>) => Promise<any>;
}) {
  const cards = createCardStore();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  cards.subscribe(changed);
  // the flag's late read or a Mac's answer changes what the screens that follow it show
  o.hostChat?.subscribe(changed);
  // the lane's frames and presence go to the sessions made below, which exist by the time the first one arrives
  const kit = createHostChatKit({
    phones: () => phones,
    cards,
    newId: () => bytesHex(o.prim.randomBytes(16)),
    changed,
    store:
      o.vault.getStarted && o.vault.setStarted
        ? { load: () => o.vault.getStarted!(), save: (m, c) => o.vault.setStarted!(m, c) }
        : undefined,
    enabled: o.hostChat?.on,
    why: o.hostChat?.why,
    told: o.hostChat?.told,
  });
  // the Host's own list of a machine's chats is read once when the machine first answers in a session (a new pairing, a Host that came back), and
  // again at each probe; a machine that cannot list is not asked again by every change, and a read in flight is shared
  const synced = new Set<string>();
  const reading = new Map<string, Promise<boolean>>();
  const sync = (machineId: string) => {
    synced.add(machineId);
    let going = reading.get(machineId);
    if (!going) reading.set(machineId, (going = kit.sync(machineId).finally(() => reading.delete(machineId))));
    return going;
  };
  const ended = (machineId: string) => {
    synced.delete(machineId);
    kit.chats.sessionEnded(machineId);
  };
  const phones: ReturnType<typeof createPhoneHosts> = createPhoneHosts({
    onEvent: kit.chats.onEvent,
    onSessionEnd: ended,
    // direct access given up: the machine's chats go, and when it is enrolled again its list is read again (not skipped as already read)
    onForget: (machineId: string) => {
      synced.delete(machineId);
      kit.forgetStarted(machineId);
    },
    prim: o.prim,
    vault: o.vault,
    relayUrl: o.relayUrl,
    lane: () => {
      const relay = createPhoneRelay({
        open: o.open,
        onFrame: (frame: unknown) => phones.handleFrame(frame),
        onEvent: (event: unknown) => phones.handleEvent(event as Parameters<typeof phones.handleEvent>[0]),
        onClose: () => undefined,
      });
      return {
        connect: async () => void (await relay.connect(hostLaneUrl(o.relayUrl), await o.auth.relayToken())),
        request: (m: Parameters<typeof relay.request>[0]) => relay.request(m),
        send: (f: Parameters<typeof relay.send>[0]) => relay.send(f),
        close: () => relay.close(),
        connected: () => relay.connected(),
      };
    },
    macEnroll: (hostId: string, params: object) => o.request('machines.enroll', { ...params, hostId }),
    macForget: (hostId: string) => o.request('machines.forget', { hostId }),
    cards,
    deviceName: o.deviceName,
    changed,
  });
  // a machine that answers again takes what waited for it
  listeners.add(() => phones.records().forEach((r: { machineId: string }) => kit.flush(r.machineId)));
  listeners.add(() => {
    for (const r of phones.records() as { machineId: string }[])
      if (!synced.has(r.machineId) && phones.link(r.machineId) === 'up') void sync(r.machineId);
  });
  return {
    phones,
    cards,
    chat: kit,
    /** Asks every enrolled Host now, so a machine's row is right before its page is opened (launch and foreground, #4604); a Host that does not answer reads Offline. */
    async probe() {
      await phones.load().catch(() => undefined);
      await kit.restore(phones.records().map((r: { machineId: string }) => r.machineId));
      await Promise.all(
        phones.records().map(async (r: { machineId: string }) => {
          // the Host's own list of its chats, once the machine answers
          if (await phones.refresh(r.machineId)) await sync(r.machineId);
        }),
      );
      // the app was away (or just started): frames sent to a followed chat meanwhile may have been missed, so each is read again
      for (const r of phones.records() as { machineId: string }[]) kit.chats.sessionEnded(r.machineId);
    },
    /** A machine's session ended: its chats are read again from it when it next answers. */
    sessionEnded: ended,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
