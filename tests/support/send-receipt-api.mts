// Compile-time callers exercise the actual controller's synchronous and awaited overloads without dispatching.
import { ChatController } from '../../electron/session/controller.cjs';
import type { SendReceipt } from '../../shared/sendReceipt.mjs';
declare const controller: InstanceType<typeof ChatController>;
const implicit = controller.send('chat', { text: 'background' }, null);
const explicit = controller.send('chat', { text: 'background' }, null, false);
const noOrigin = controller.send('chat', { text: 'background' });
const sync: { action: 'started' | 'steered' | 'queued' | 'failed'; id: string }[] = [implicit, explicit, noOrigin];
const pending: Promise<SendReceipt> = controller.send('chat', { text: 'renderer' }, 7, true);
const accepted: SendReceipt = await controller.send('chat', { text: 'renderer' }, undefined, true);
void sync;
void pending;
void accepted;
