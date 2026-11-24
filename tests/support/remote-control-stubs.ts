// The settings harness's stand-in for RemoteControl.tsx: Codex is not usable, so the Control this Mac tab shows no Codex rows.
export const remoteControlStubs = (stub: (name: string) => unknown) => ({
  useCodexControl: () => ({ usable: false, connected: false }),
  CodexClientRows: stub('CodexClientRows'),
  CodexSwitchRows: stub('CodexSwitchRows'),
  codexLinkOff: () => undefined,
});
