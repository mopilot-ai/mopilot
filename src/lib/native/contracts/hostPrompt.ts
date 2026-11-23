// What ssh (and MoPilot, before it adds its own key) asks while a machine is added, as the window receives it (electron/host/sshPrompt.cjs).
export type HostSshPrompt =
  | { kind: 'hostKey'; destination: string; host: string; keyType: string; fingerprint: string; text: string }
  | { kind: 'password' | 'passphrase'; destination: string; account?: string; key?: string; text: string }
  | {
      kind: 'keyConsent';
      destination: string;
      host: string;
      publicKeyFile: string;
      addsTo: string;
      store: 'file';
      choices: ['add'];
      text: string;
    }
  | { kind: 'confirm' | 'secret'; destination: string; text: string };
