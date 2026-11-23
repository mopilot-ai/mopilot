// The Codex installs main finds and the one chats run (electron/platform/userTools.cjs adds whether the user's terminal
// runs it too), read once per visit: Codex's Version row and its page header name the install from the same answer.
import { useEffect, useState } from 'react';
import { native } from '../lib/native';
import { errorText } from '../lib/ignored';
import type { OffPathFields } from '../lib/cliSource';
import type { CliCandidate } from '../lib/native/contracts/harnesses';

export type CodexBinaries = { candidates: CliCandidate[]; current: string } & OffPathFields;

// main probes every install for this answer: views open at once share it, and the next visit asks again
let shared: { read: Promise<CodexBinaries>; users: number } | null = null;

/** `bins` once main has answered; `error` when the lookup failed, so a view says why instead of detecting forever. */
export function useCodexBinaries(): { bins: CodexBinaries | null; error: string | null } {
  const [bins, setBins] = useState<CodexBinaries | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!shared) shared = { read: native.codex.binaries(), users: 0 };
    const s = shared;
    s.users++;
    let open = true;
    s.read.then(
      (b) => open && setBins(b),
      (e) => open && setError(errorText(e)),
    );
    return () => {
      open = false;
      if (--s.users === 0 && shared === s) shared = null;
    };
  }, []);
  return { bins, error };
}
