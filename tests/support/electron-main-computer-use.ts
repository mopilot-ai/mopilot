// The fake electron/capabilities/computerUse.cjs loadMain() (electron-main-harness.ts) gives main: setupComputerUse's
// handles (helper, broker, grants, holds, refusals), recorded in inst.computerUse, and its small pure exports.

/**
 * @param inst the harness's record of created collaborators
 * @param makers the harness's stub, mock-function and resolved-mock makers
 */
export function computerUseFake(
  inst: any,
  { stub, fn, resolved }: { stub: (o?: any) => any; fn: (impl?: any) => any; resolved: (v?: any) => any },
) {
  return {
    setupComputerUse: fn((o: any) => {
      const s = stub({
        opts: o,
        cu: stub(),
        broker: stub({ ask: resolved('granted') }),
        // Codex Computer Use programs holding the desktop lock (nativeDesktopHold.cjs)
        nativeHolds: stub(),
        // the chat's transcript line for a refused app or a stopped native turn (controlRefusals.cjs)
        refusals: stub(),
        helper: stub({ start: resolved(), speechStatus: resolved('status'), speechRequest: resolved('req') }),
        // the saved computer-use settings (grants.cjs): Codex Computer Use is off until chosen
        grants: stub({ codexNativeComputer: fn(() => false), setCodexNativeComputer: fn((on: boolean) => on) }),
      });
      (inst.computerUse ??= []).push(s);
      return s;
    }),
    trayTooltip: fn((chat: string) => `Using (${chat})`),
    // the model a chat runs, for sizing its screenshots
    chatModel: fn((kind: string, record: any, prefs: any) => `${kind}:${record?.id ?? '-'}:${prefs ? 'prefs' : '-'}`),
    // the agent's name: the harness kind, and for a basic harness the label it looks up
    agentLabel: fn((kind: string, acpLabel: (id: string) => string | undefined) =>
      kind.startsWith('acp:') ? (acpLabel(kind.slice(4)) ?? null) : kind,
    ),
  };
}
