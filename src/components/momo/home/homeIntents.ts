// What a user move is called on the wire: the intent kinds the home serves (shared/momoHomeApi.mjs), and for a move no home serves yet the action's own name, which the home refuses in words ("MoMo can’t do that yet.") instead of this client pretending.
import type { MomoHomeAction } from './homeActions';

type Intent = { kind: string; [key: string]: unknown };

/** The intent for one action. */
export function toIntent(a: MomoHomeAction): Intent {
  switch (a.type) {
    case 'setup.choose':
      return { kind: 'choose-home', machineId: a.machineId };
    case 'move.start':
      return { kind: 'move', toId: a.machineId };
    case 'move.cancel':
      return { kind: 'move-cancel' };
    case 'move.retry':
      return { kind: 'move-retry' };
    case 'move.stay':
      return { kind: 'move-stay' };
    case 'move.dismiss':
      return { kind: 'move-ack' };
    case 'home.reclaim':
      return { kind: 'reclaim', moveId: a.moveId, toId: a.toId };
    case 'home.wake':
      return { kind: 'wake' };
    case 'machine.update':
      return { kind: 'update-machine', machineId: a.machineId };
    case 'machine.setUp':
      return { kind: 'set-up-machine', machineId: a.machineId };
    case 'chat.send':
      return { kind: 'send', turnId: a.turnId, text: a.text };
    case 'chat.check':
      return { kind: 'check-turn', turnId: a.rowId };
    case 'fix.run':
      return { kind: 'fix', id: a.id };
    // a result's own action belongs to its task, not to a machine
    case 'task.act':
      return { kind: 'task.act', id: a.id, fixId: a.fixId };
    case 'intent':
      return a.intent as Intent;
    default: {
      const { type, ...rest } = a;
      return { kind: type, ...rest };
    }
  }
}
