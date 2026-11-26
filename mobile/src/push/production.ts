// Production wiring of the push modules to Expo: the controller for the app, and the headless Android data-message handler.
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { phonePrimitives } from '../platform/crypto';
import { onForeground } from '../platform/lifecycle';
import {
  defineDataMessageTask,
  registerDataMessageTask,
  onTap,
  permissionPort,
  dismissLocal,
  quietForeground,
  secretPort,
  setupCategories,
  setupChannels,
  showLocal,
  tokenSource,
} from '../platform/notifications';
import type { MobileRuntime } from '../contracts';
import { createPushController } from './controller';
import type { LiveActivityController } from './liveActivityController';
import { buildNotification, testNotification, withdrawn } from './dataMessage';
import { createPushAdmit, guardTaps } from '../momoPhone/pushStamps';
import { createPermissionFlow } from './permission';
import { parsePrefs } from './prefs';
import { parsePushPayload, type PushPayload } from './payload';
import { createPushRegistration } from './registration';
import { createTitleKeys } from './titleKeys';

/** The keychain service and (iOS) access group that the notification extension reads; the group comes from app config, never source. */
export const TITLE_KEY_SERVICE = 'mopilot-push';
const extra = () => (Constants.expoConfig?.extra as { push?: { keychainAccessGroup?: string } } | undefined)?.push ?? {};
const titleKeys = () =>
  createTitleKeys({
    secrets: secretPort,
    options: {
      keychainService: TITLE_KEY_SERVICE,
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      accessGroup: extra().keychainAccessGroup,
    },
  });

const kv = (name: string) => ({
  read: () => keychain(SecureStore.getItemAsync(name)),
  write: (value: string | null) => keychain(value === null ? SecureStore.deleteItemAsync(name) : SecureStore.setItemAsync(name, value)),
});
const dismissStore = () => {
  const store = kv('push-prompt-dismissed-at');
  return {
    read: async () => {
      const raw = await store.read();
      return raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
    },
    write: (at: number | null) => store.write(at === null ? null : String(at)),
  };
};

const prefsStore = () => {
  const store = kv('push-prefs');
  /** `ok` is false when the store could not be read, which is different from nothing being saved yet. */
  const readChecked = async () => {
    try {
      return { ok: true, prefs: parsePrefs(await store.read()) };
    } catch {
      return { ok: false, prefs: parsePrefs(null) };
    }
  };
  return {
    readChecked,
    read: async () => (await readChecked()).prefs,
    write: async (prefs: ReturnType<typeof parsePrefs>) => {
      await store.write(JSON.stringify(prefs));
      // the lock-screen choice lives in the channels, which must follow the saved value
      await syncChannels().catch(() => undefined);
    },
  };
};

let channelQueue: Promise<unknown> = Promise.resolve();
/**
 * Make the Android channels match the saved lock-screen choice. Calls run one after another and each reads the saved choice when it runs, so
 * quick changes and a headless task racing the app all end on the latest saved value; an unreadable store changes nothing.
 */
export function syncChannels(): Promise<void> {
  const run = channelQueue.then(async () => {
    const stored = await prefsStore().readChecked();
    if (stored.ok) await setupChannels(stored.prefs.lockScreen);
  });
  channelQueue = run.catch(() => undefined);
  return run;
}

/** The running app's push listener, if any: set while a controller is started, so a headless data message can wake the same process's drain. */
let pushListener: ((payload: PushPayload) => void) | null = null;

/**
 * The headless handler for an Android data message: open the sealed title if possible, and always show a notification. When the
 * app's controller is alive in this process (backgrounded, not killed) it also drains the mailbox; a killed app has no runtime and
 * drains at its next launch or foreground, never from a second runtime (one socket and one ratchet writer per device).
 */
export function handleDataMessage(data: unknown) {
  const turn = inbox.then(() => handleOne(data));
  inbox = turn.catch(() => undefined);
  return turn;
}

/** A push of an old MoMo home is refused: it neither draws a notification nor opens a card. The copy, the keys and the vault are loaded only when a MoMo push arrives. */
const admitPush = createPushAdmit({
  context: async () => (await import('../platform/pushStampContext')).momoStampContext(),
  cache: async () => (await import('../platform/momoHomeStore')).openMomoHomeCache(),
  wasUsed: async () => (await import('../platform/momoHomeStore')).momoHomeWasUsed(),
  mark: async () => (await import('../platform/momoHomeStore')).markMomoHomeUsed(),
});

/** Data messages are handled one after another, in the order they arrived: a clearing must not take its notification away before the "needs you" it follows has been drawn. Never rejects, so the chain goes on after a failure. */
let inbox: Promise<unknown> = Promise.resolve();

async function handleOne(data: unknown) {
  const gone = withdrawn(data);
  if (gone) {
    // a chat's waiting card is gone: its notification is taken away, nothing is drawn, and a running app refreshes
    await Promise.all(gone.ids.map((id) => dismissLocal(id).catch(() => undefined)));
    pushListener?.(gone.payload);
    return;
  }
  const stored = await prefsStore().readChecked();
  // an unreadable store must not widen what the lock screen shows: use the private set, created without removing any other
  const prefs = stored.ok ? stored.prefs : { ...stored.prefs, lockScreen: 'private' as const };
  const note = await buildNotification(data, {
    keys: titleKeys().all,
    open: phonePrimitives().aeadOpen,
    prefs: async () => prefs,
    admit: admitPush,
  });
  if (note) {
    // a data message can arrive before the app ever ran with the channels of the saved lock-screen choice
    await (stored.ok ? syncChannels() : setupChannels('private', false)).catch(() => undefined);
    await showLocal(note);
    const payload = parsePushPayload(data);
    if (payload) pushListener?.(payload);
  }
}
/** Register the Android task at module load, before React renders. */
export function installDataMessageTask() {
  defineDataMessageTask(handleDataMessage);
  void registerDataMessageTask().catch(() => undefined);
}

export function createProductionPush(
  runtime: MobileRuntime,
  hooks: { beforeSignOut?: () => Promise<unknown>; liveActivity?: LiveActivityController } = {},
) {
  void syncChannels().catch(() => undefined);
  void setupCategories().catch(() => undefined);
  const prefs = prefsStore();
  const controller = createPushController({
    runtime,
    permission: createPermissionFlow({ port: permissionPort, store: dismissStore() }),
    registration: createPushRegistration({
      relay: { register: (platform, token) => runtime.pushRegister(platform, token), unregister: () => runtime.pushUnregister() },
      tokens: tokenSource,
      store: kv('push-registered-token'),
    }),
    prefs,
    showTest: async () => showLocal(testNotification(await prefs.read())),
    beforeSignOut: hooks.beforeSignOut,
    liveActivity: hooks.liveActivity,
    titleKeys: titleKeys(),
    taps: guardTaps(admitPush, onTap),
    pushes(listener) {
      pushListener = listener;
      return () => {
        if (pushListener === listener) pushListener = null;
      };
    },
    foreground: onForeground,
  });
  quietForeground(
    (payload) => pushListener?.(payload),
    async (payload) => (await admitPush(payload)) && controller.present(payload),
  );
  return controller;
}
