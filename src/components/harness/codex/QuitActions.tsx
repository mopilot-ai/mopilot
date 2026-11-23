// What the user can do about a Codex copy that keeps quitting: pick another in Settings → Codex → Advanced, where the
// installed copies are listed, or copy the crash output. The banner and a Codex chat's failed read show them.
import { useStore, toast, toastFailure } from '../../../store/core';
import { navigate } from '../../../store/panes';
import { readFamilies } from '../../../store/chatRetry';
import { native } from '../../../lib/native';
import { codexCrashOutput } from '../../../harness/codexQuit';
import { Copy } from '../../ui/icons';

/** The two actions, while a copy that quit as it started is named (main says which: AppState.codexQuit). */
export function CodexQuitActions() {
  const quit = useStore((s) => s.codexQuit);
  const connError = useStore((s) => s.connError);
  if (!quit) return null;
  const output = codexCrashOutput(quit, connError);
  return (
    <>
      <button type="button" className="btn-pill" onClick={() => navigate({ name: 'settings', section: 'codex', tab: 'advanced' })}>
        Use another Codex
      </button>
      <button
        type="button"
        className="btn-pill soft"
        onClick={() =>
          native.clipboard.write(output).then(() => toast('Crash output copied'), toastFailure("Couldn't copy the crash output"))
        }
      >
        <Copy size={13} /> Copy crash output
      </button>
    </>
  );
}

/** The actions in a chat whose read failed, when Codex holds its history (another harness's read has nothing to pick). */
export function ChatCodexQuitActions({ chatId }: { chatId: string }) {
  const reads = useStore((s) => s.runtime[chatId]?.errorFromRead === true && readFamilies(chatId).has('codex'));
  return reads ? <CodexQuitActions /> : null;
}
