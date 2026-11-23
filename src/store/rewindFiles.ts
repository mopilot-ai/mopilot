// A Codex chat's rewind with its files: what restoring the folder to before the turn would change is shown and asked first, the files listed are restored from main's checkpoint (electron/session/turnCheckpoints.cjs), and Undo puts them back.
import { native } from '../lib/native';
import { errorText } from '../lib/ignored';
import { get, toast } from './core';

/** How many changed paths the question names before it says "and N more". */
const LISTED = 8;
/** Why a turn's files can't be restored, said once the conversation has been rewound. */
const NONE = {
  checkpoint: 'Only the conversation was rewound: this message has no file checkpoint, so its files are as they were.',
  ignores: 'Only the conversation was rewound: this turn changed which files are ignored, so its files can’t be restored safely.',
} as const;

/**
 * A rewind's file restore, once asked: the rewind should not go on, or it should, with the files restored (how many,
 * and their undo) when any were, and what to say once the conversation is rewound.
 */
export type FileRestore = { go: false } | { go: true; restored: { count: number; undo: () => Promise<void> } | null; note: string | null };

const undoOf = (nativeId: string, cwd: string, id: string) => async () => {
  const back = await native.checkpoints.undo(nativeId, cwd, id).catch((e) => ({ ok: false as const, error: errorText(e) }));
  toast(back.ok ? 'Put the files back' : `Couldn't put the files back: ${back.error}`, back.ok ? 'info' : 'error');
};

/**
 * Before chat `chatId` (native thread `nativeId`) is rewound to before turn `turnId`: restore its folder's files to how
 * they were when that turn started, asking first with the files listed; only those are restored. A turn with no
 * checkpoint (a folder that is no repository, a turn from before checkpoints, one that shared its folder with another
 * chat's turn) rewinds the conversation only, and says so.
 */
export async function restoreTurnFiles(chatId: string, nativeId: string, turnId: string): Promise<FileRestore> {
  const cwd = get().threads[chatId]?.cwd;
  if (!cwd) return { go: true, restored: null, note: null };
  const plan = await native.checkpoints.plan(nativeId, turnId, cwd).catch((e) => ({ ok: false as const, error: errorText(e) }));
  if (!plan.ok) return toast(`Couldn't rewind: ${plan.error}`, 'error'), { go: false };
  if ('none' in plan) return { go: true, restored: null, note: NONE[plan.none] };
  if (!plan.files.length) return { go: true, restored: null, note: null };
  const names = plan.files.slice(0, LISTED).join('\n');
  const more = plan.files.length > LISTED ? `\n…and ${plan.files.length - LISTED} more` : '';
  const count = plan.files.length === 1 ? '1 file' : `${plan.files.length} files`;
  const asked =
    `Rewinding also restores ${count} to how they were before this message:\n\n${names}${more}\n\n` +
    'Edits made to them since, by anyone, are undone too. Commits stay: the files go back as uncommitted changes. ' +
    'Ignored files and submodules stay as they are. You can undo the file restore from the message that follows.';
  if (!confirm(asked)) return { go: false };
  const done = await native.checkpoints
    .restore(nativeId, turnId, cwd, plan.files)
    .catch((e) => ({ ok: false as const, error: errorText(e) }));
  if (!done.ok) {
    // files left half restored can still be put back
    const undo = 'undo' in done && done.undo ? undoOf(nativeId, cwd, done.undo) : null;
    toast(`Couldn't restore the files: ${done.error}`, 'error', undo ? { action: { label: 'Undo', run: () => void undo() } } : undefined);
    return { go: false };
  }
  return { go: true, restored: { count: done.restored, undo: undoOf(nativeId, cwd, done.undo) }, note: null };
}
