// Runs turn ownership, native plugin lifecycle and recovery cases in their original order.
import { registerTurns } from './support/control-lifecycle/turns.ts';
import { registerNative } from './support/control-lifecycle/native.ts';
import { registerRecovery } from './support/control-lifecycle/recovery.ts';

export const GUARDS = ['electron/', 'shared/'];

registerTurns();
registerNative();
registerRecovery();
