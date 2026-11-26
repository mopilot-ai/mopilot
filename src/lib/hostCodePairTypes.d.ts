// What pairing a Mac by a code answers (R2b of #5576, electron/host/codePairClient.cjs): the machine added, or what went wrong and the fix offered in place. The dialog (rr-x1-mac-ui) draws it.
export type AddByCodeResult =
  | { ok: true; id: string; name: string; safety: string }
  | { ok: false; code: string; cause: string; fix: { id: string; label: string } | null };
