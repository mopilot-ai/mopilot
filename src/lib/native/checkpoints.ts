// window.native.checkpoints' types (a chat's files on rewind), merged into NativeApi; the calls are declared in electron/bridge/checkpoints.cjs.
export {};

/** `none`: files can't be restored for that turn (no checkpoint, or it changed which files are ignored). */
export type CheckpointPlan = { ok: true; files: string[] } | { ok: true; none: 'checkpoint' | 'ignores' } | { ok: false; error: string };
/** `undo`: the id that puts the files back (also on a failure when the files couldn't be put back by themselves). */
export type CheckpointRestored = { ok: true; restored: number; undo: string } | { ok: false; error: string; undo?: string };
export type CheckpointUndone = { ok: true; restored: number } | { ok: false; error: string };

declare module '../native' {
  interface NativeApi {
    checkpoints: {
      /** What rewinding native thread `threadId` to before turn `turnId` would change in `cwd` (paths from the repository root). */
      plan(threadId: string, turnId: string, cwd: string): Promise<CheckpointPlan>;
      /** Make the `files` listed what they were when that turn started; what they are now is kept for undo. */
      restore(threadId: string, turnId: string, cwd: string, files: string[]): Promise<CheckpointRestored>;
      /** Put back what the files were before restore `undo`. */
      undo(threadId: string, cwd: string, undo: string): Promise<CheckpointUndone>;
    };
  }
}
