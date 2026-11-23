// The one action a Host's refusal of a queued message offers in place (Install, Sign in, Update): its button label and what pressing it does, each an action the app already has elsewhere.
import { native } from '../lib/native';
import { startInstall } from '../lib/hostInstall';
import { startSignin } from '../lib/hostSignin';
import type { HostMachineRow } from '../lib/hostMachines';
import { hostUpdateLine } from '../lib/machineStatus';
import { PERMISSION_LABEL } from '../harness/permissionsMenu';
import { hostPermissionFamily } from '../../shared/host/permissions.mjs';
import { newChatWithMessage, type RefusedMessage } from './refusalNewChat';
import type { QueuedMessage } from '../../shared/model/session';

type Refusal = NonNullable<QueuedMessage['refusal']>;
/** The button's words, naming the machine where the action is on it; null when the refusal offers no action. An Update is offered only where the machine's row offers one (an older Host that can be updated from here): for a newer Host, a machine added by command or one not listed, `machine` says so and the label is null. */
export function refusalActionLabel(r: Refusal, machine?: HostMachineRow): string | null {
  switch (r.action) {
    case 'install':
      return `Install on ${r.machine}`;
    case 'signIn':
    case 'orgSignIn':
      return 'Sign in';
    case 'update':
      return (machine && hostUpdateLine(machine)?.update?.label) || null;
    case 'openMachines':
      // an unknown Mac is paired again where the machine is added with its code
      return r.code === 'unknown_client' ? 'Pair again' : 'Machine settings';
    case 'newChat':
      return `New chat on ${r.machine}`;
    case 'chooseFolder':
      return 'Choose a folder';
    case 'useMode':
      return r.mode ? `Use ${PERMISSION_LABEL[r.mode as keyof typeof PERMISSION_LABEL] ?? r.mode}` : null;
    default:
      return null;
  }
}

/** The refused message and what takes it out of the queue once it has gone to a new chat. */
/** `removeRow` resolves true when the row was taken out of the queue; `opts` are what the message was queued with (Plan, a goal, a model pick), for a message that is sent again. */
export type QueuedRefusal = RefusedMessage & { removeRow: () => Promise<boolean | void>; opts?: QueuedMessage['opts'] };

/** Whether the button opens the machine's folder picker first (the row shows it, then calls `runRefusalAction` with the folder picked). */
export const picksFolder = (r: Refusal) => r.action === 'chooseFolder';

/** Does what the button says; a failure rejects with the reason to show. `queued` is the refused message: the actions that move it to a new chat carry it, and `removeRow` takes it out of the queue once it is there. `folder` is the one picked for "Choose a folder". */
export async function runRefusalAction(r: Refusal, queued?: QueuedRefusal, folder?: string): Promise<void> {
  switch (r.action) {
    case 'install':
      return startInstall(r.hostId, r.agent ?? '');
    case 'signIn':
      return startSignin(r.hostId, r.agent ?? '');
    case 'orgSignIn':
      await native.host.orgSignIn();
      return;
    case 'update':
      await native.host.update(r.hostId);
      return;
    case 'openMachines': {
      // a Mac the machine does not know pairs again the way the Add sheet does (the install over ssh is idempotent and pairs); a machine added by command has no ssh to do it from, so it is added again in Settings
      if (r.code === 'unknown_client' && r.hostId.startsWith('ssh:')) {
        const out = await native.host.add(r.hostId.slice(4));
        if (!out.ok || !out.paired) throw new Error(out.error || `Could not pair with ${r.machine} again.`);
        (await import('../store/core')).toast(`Paired ${r.machine} again`);
        return;
      }
      // where a machine is added again or its access granted; imported here because the store reaches this file through the queue
      (await import('../store/chats')).openSettings('connections')();
      return;
    }
    case 'newChat':
    case 'chooseFolder':
      // "Choose a folder" arrives here with its folder once the picker has one; without it there is nothing to start
      if (queued && (r.action === 'newChat' || folder) && (await newChatWithMessage(r, queued, folder))) await queued.removeRow();
      return;
    case 'useMode': {
      // the chat goes on under the most the machine allows: that is its pick from now on, and the refused message goes out again under it (its first mode was frozen with it, so it is sent anew, not retried)
      const family = hostPermissionFamily(r.agent ?? '');
      if (!queued || !r.mode || !family) return;
      const [{ setChatConfig }, { sendMessage }, { get, setDraft }] = await Promise.all([
        import('../store/projects'),
        import('../store/send'),
        import('../store/core'),
      ]);
      const before = get().chatConfig[queued.chatId]?.hostPermission;
      setChatConfig(queued.chatId, { hostPermission: { hostId: r.hostId, harness: family, value: r.mode } } as never);
      // the row is not taken out by this click (another window already did, or it could not be): nothing is sent a second time
      if ((await queued.removeRow()) === false) return void setChatConfig(queued.chatId, { hostPermission: before } as never);
      const o = queued.opts;
      const sent = await sendMessage(queued.chatId, queued.text, queued.attachments, {
        ...(o?.plan || (o?.hostMode as string | undefined) === 'plan' ? { plan: true } : {}),
        ...(o?.goal ? { goal: o.goal } : {}),
        ...(o?.model ? { model: o.model } : {}),
        ...(o?.effort ? { effort: o.effort } : {}),
        ...(o?.prefix ? { prefix: o.prefix } : {}),
        ...(o?.human ? { human: true } : {}),
      });
      // it did not go (told by the send): the words are given back to the composer, and the pick is what it was
      if (sent === false) {
        setDraft(queued.chatId, { text: queued.text, attachments: queued.attachments });
        setChatConfig(queued.chatId, { hostPermission: before } as never);
      }
      return;
    }
    default:
  }
}
