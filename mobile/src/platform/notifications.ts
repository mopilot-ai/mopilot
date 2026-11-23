// expo-notifications, expo-task-manager and SecureStore bound to the push modules: permission, token, channels, taps and Android data messages.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { CATEGORY_SPECS, OPEN_ACTION, replyDraft } from '../push/actions';
import { ALLOW_ACTION, ANSWER_ACTION, DENY_ACTION } from '../push/approvalAction';

const APPROVAL_ACTIONS = new Set([ALLOW_ACTION, DENY_ACTION, ANSWER_ACTION]);
import { channelIdsExcept, channelSpecs, SYSTEM_CHANNEL, type LockScreen } from '../push/channels';
import { parsePushPayload, type PushPayload } from '../push/payload';
import type { LocalNotification } from '../push/dataMessage';
import type { PermissionPort } from '../push/permission';
import type { SecretPort } from '../push/titleKeys';
import type { TokenSource } from '../push/registration';

export const DATA_MESSAGE_TASK = 'mopilot-push-data-message';

export const permissionPort: PermissionPort = {
  async status() {
    const p = await Notifications.getPermissionsAsync();
    if (p.granted) return 'granted';
    return p.canAskAgain ? 'undetermined' : 'denied';
  },
  async request() {
    const p = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
    return p.granted ? 'granted' : 'denied';
  },
};

/** What the OS says when this build cannot get a push token at all: no entitlement, no native module, no Google Play services. */
const PERMANENT = /entitlement|aps-environment|native module|cannot find|not (?:available|linked|installed)|google play services/i;
let tokenFailure: string | null = null;
export const tokenSource: TokenSource = {
  get platform() {
    return Platform.OS === 'ios' ? 'apns' : 'fcm';
  },
  get failure() {
    return tokenFailure;
  },
  async get() {
    try {
      const token = await Notifications.getDevicePushTokenAsync();
      tokenFailure = null;
      return typeof token.data === 'string' && token.data ? token.data : null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // only a failure no retry can cure (a build without the entitlement or the module) is "not available"; the rest may pass
      tokenFailure = PERMANENT.test(reason) ? reason : null;
      // a development build without push says why it has no token
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn(`[push] no device token: ${reason}`);
      return null;
    }
  },
  onRefresh(listener) {
    const subscription = Notifications.addPushTokenListener((event) =>
      listener(typeof event.data === 'string' && event.data ? event.data : null),
    );
    return () => subscription.remove();
  },
};

export const secretPort: SecretPort = {
  get: (key, options) => keychain(SecureStore.getItemAsync(key, options)),
  set: (key, value, options) => keychain(SecureStore.setItemAsync(key, value, options)),
  remove: (key, options) => keychain(SecureStore.deleteItemAsync(key, options)),
};

const VISIBILITY = {
  show: Notifications.AndroidNotificationVisibility.PUBLIC,
  private: Notifications.AndroidNotificationVisibility.PRIVATE,
  hide: Notifications.AndroidNotificationVisibility.SECRET,
} as const;

/** Android channels must exist before a notification names one; iOS has none. */
export async function setupChannels(lock: LockScreen = 'show', prune = true) {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(SYSTEM_CHANNEL.id, {
    name: SYSTEM_CHANNEL.name,
    description: SYSTEM_CHANNEL.description,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  // a lock-screen choice is fixed when its channels are created, so the other choices' channels are removed rather than left behind
  if (prune) for (const id of channelIdsExcept(lock)) await Notifications.deleteNotificationChannelAsync(id).catch(() => undefined);
  for (const c of channelSpecs(lock)) {
    await Notifications.setNotificationChannelAsync(c.id, {
      name: c.name,
      description: c.description,
      importance:
        c.importance === 'high'
          ? Notifications.AndroidImportance.HIGH
          : c.importance === 'low'
            ? Notifications.AndroidImportance.LOW
            : Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: VISIBILITY[c.lock],
      ...(c.silent && { sound: null, enableVibrate: false }),
    });
  }
}

/** The Review/Open and Reply buttons of an iOS notification; every action opens the app, and a reply needs the device unlocked. */
export async function setupCategories() {
  if (Platform.OS !== 'ios') return;
  for (const c of CATEGORY_SPECS) {
    await Notifications.setNotificationCategoryAsync(
      c.id,
      c.actions.map((a) => ({
        identifier: a.identifier,
        buttonTitle: a.buttonTitle,
        ...(a.textInput && { textInput: a.textInput }),
        // Allow and Deny run in the background (about 30 s); Allow needs the device unlocked, Deny does not
        options: a.background
          ? { opensAppToForeground: false, isAuthenticationRequired: a.background === 'unlocked' }
          : { opensAppToForeground: true, isAuthenticationRequired: a.identifier !== OPEN_ACTION },
      })),
    );
  }
}

/**
 * What a push carries. Android's data message lands in `content.data`; an iOS push has custom keys (kind, ref, card) beside `aps`, and
 * Expo hands those over in the trigger's payload while `content.data` is null, so a tap read only from `data` opens nothing.
 */
export function pushData(request: Notifications.NotificationRequest): unknown {
  const { data } = request.content;
  if (data && Object.keys(data).length) return data;
  const trigger = request.trigger as { type?: string; payload?: unknown } | null;
  return trigger?.type === 'push' ? trigger.payload : data;
}

/** The data of the notification the Notifications page's test button sends; it is drawn even while the app is on screen. */
const isTest = (data: unknown) => !!data && typeof data === 'object' && (data as { test?: unknown }).test === true;

/**
 * While the app is on screen every push triggers a drain, and `present` decides whether it is also drawn as a banner: the chat that is
 * open is not announced again (the live socket already shows it), another chat is.
 */
export function quietForeground(onPush: (payload: PushPayload) => void, present: (payload: PushPayload) => boolean = () => false) {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const data = pushData(n.request);
      const payload = parsePushPayload(data);
      if (payload && !isTest(data)) onPush(payload);
      // a clearing is never drawn here: on a locked phone it replaces the waiting notification, and with the app open it could not, so that one is withdrawn instead
      if (payload?.kind === 'cleared') void withdrawDelivered(payload.ref).catch(() => undefined);
      const show = isTest(data) || (!!payload && payload.kind !== 'cleared' && present(payload));
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: false, shouldSetBadge: false };
    },
  });
}

/** Takes a chat's delivered "needs you" notifications off the lock screen and out of Notification Center. */
export async function withdrawDelivered(ref: string) {
  const shown = await Notifications.getPresentedNotificationsAsync();
  const mine = shown.filter((n) => {
    const payload = parsePushPayload(pushData(n.request));
    return payload?.kind === 'needsYou' && payload.ref === ref;
  });
  await Promise.all(mine.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)));
}

/** Takes one notification this app drew (Android) away by its id. */
export const dismissLocal = (id: string) => Notifications.dismissNotificationAsync(id);

const handled = new Map<string, number>();
const REPEAT_MS = 3000;
/** Whether this response was already delivered: a launch replay is dropped once seen, a live repeat of the same response within seconds too. */
function seen(response: Notifications.NotificationResponse, launch: boolean) {
  const key = `${response.notification.request.identifier}|${response.notification.date}|${response.actionIdentifier}`;
  const at = handled.get(key);
  const duplicate = at !== undefined && (launch || Date.now() - at < REPEAT_MS);
  if (!duplicate) {
    handled.set(key, Date.now());
    if (handled.size > 50) handled.delete(handled.keys().next().value as string);
  }
  return duplicate;
}

let onApproval: ((payload: PushPayload, action: string, notificationId: string) => void) | null = null;
/** Where Allow, Deny and Answer go (P5); until it is set they do nothing, as a notification the phone cannot act on. */
export const setApprovalHandler = (fn: typeof onApproval) => {
  onApproval = fn;
};

/** A tap while running, plus the tap that launched the app; the same response reaches the listener once even when both report it. */
export function onTap(listener: (payload: PushPayload, reply?: string) => void) {
  const open = (response: Notifications.NotificationResponse | null, launch: boolean) => {
    const data = response && pushData(response.notification.request);
    const payload = response && !isTest(data) ? parsePushPayload(data) : null;
    if (!payload || !response || seen(response, launch)) return;
    if (APPROVAL_ACTIONS.has(response.actionIdentifier))
      return onApproval?.(payload, response.actionIdentifier, response.notification.request.identifier);
    listener(payload, replyDraft(response.actionIdentifier, response.userText) ?? undefined);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => open(response, false));
  void Notifications.getLastNotificationResponseAsync().then(
    (response) => open(response, true),
    () => undefined,
  );
  return () => subscription.remove();
}

export async function showLocal(n: LocalNotification) {
  await Notifications.scheduleNotificationAsync({
    identifier: n.id,
    content: { title: n.title, body: n.body ?? '', data: n.data },
    trigger: { channelId: n.channelId },
  });
}

/** The task body receives the data message as `data.data` (object or JSON string) or `data.dataString`, depending on the SDK path. */
export function taskData(data: unknown): unknown {
  const d = data as { data?: unknown; dataString?: unknown } | null;
  const raw = d?.dataString ?? d?.data ?? d;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Call once at module load, before the app renders, so a data message that starts the process finds its task. */
export function defineDataMessageTask(handle: (data: unknown) => Promise<void>) {
  TaskManager.defineTask(DATA_MESSAGE_TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody) => {
    if (!error) await handle(taskData(data)).catch(() => undefined);
  });
}
export const registerDataMessageTask = () =>
  Platform.OS === 'android' ? Notifications.registerTaskAsync(DATA_MESSAGE_TASK) : Promise.resolve();
