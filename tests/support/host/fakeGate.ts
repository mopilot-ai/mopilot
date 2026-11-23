// A stand-in for the gate lane's `home.gate` (host/src/momoServices/gate.mjs) in the runner's and the routines' tests: the one taint tracker (`taintFor`) and the decision the runner relies on, a write from the owner's turn in a chat holding outside content is a card that runs once approved. The gate's own tests are its own.
import { createRequire } from 'node:module';

const { ToolError } = createRequire(import.meta.url)('../../../electron/capabilities/contract/registry.cjs');

const isWrite = (tool: string, args: any) =>
  tool === 'momo_memory_save' || tool === 'momo_memory_forget' || (tool === 'momo_open_loops' && args?.action !== 'list');

export function fakeGate() {
  const tainted = new Set<string>();
  const calls: any[] = [];
  /** Cards put to the owner: the exact line, and whether it was approved. */
  const cards: { chatId: string; tool: string; args: any; approved: boolean }[] = [];
  return {
    calls,
    cards,
    tainted,
    taintFor: (chatId: string) => ({
      tainted: () => tainted.has(chatId),
      toolResult: async () => void tainted.add(chatId),
      reset: async () => void tainted.delete(chatId),
    }),
    approve: (i: number) => void (cards[i].approved = true),
    async run(call: any, run: () => unknown) {
      calls.push(call);
      if (tainted.has(call.chatId) && isWrite(call.tool, call.args)) {
        const key = JSON.stringify([call.chatId, call.tool, call.args]);
        const card = cards.find((c) => JSON.stringify([c.chatId, c.tool, c.args]) === key);
        if (!card) {
          cards.push({ chatId: call.chatId, tool: call.tool, args: call.args, approved: false });
          throw new ToolError('This needs the owner’s approval first.', 'approval_pending');
        }
        if (!card.approved) throw new ToolError('This needs the owner’s approval first.', 'approval_pending');
      }
      return run();
    },
  };
}
