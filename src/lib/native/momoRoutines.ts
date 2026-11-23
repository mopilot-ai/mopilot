// window.native.momoRoutines's types (Settings › MoMo › Routines), merged into NativeApi; the calls are declared in electron/bridge/momoRoutines.cjs.

/** A routine MoMo proposed, waiting for the user's approval: what it will do, when, and what it reads ("Calendar, Files"; empty: none named). */
export type MomoProposal = { id: string; name: string; prompt: string; schedule: string; sources: string; rev: number };

/** A routine the user approved: what it does, when ("Every day at 9"; as a time and days when it is one), what it reads, paused or not. */
export type MomoRoutine = {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  rrule: string;
  parts: { time: string; days: string[] } | null;
  sources: string[];
  paused: boolean;
};

/** The user's change to a routine: what the form sets (a schedule as a time with days, or an RRULE). */
export type MomoRoutineEdit = {
  name?: string;
  prompt?: string;
  time?: string;
  days?: string[];
  rrule?: string;
  sources?: string[];
  paused?: boolean;
};

/** One run of a routine, as View history lists it: when it started and ended (null while going) and how it ended. */
export type MomoRoutineRun = {
  startedAt: number;
  endedAt: number | null;
  outcome: 'running' | 'completed' | 'failed' | 'interrupted' | string;
};

export type MomoRoutinesView = {
  /** every routine waiting for approval, whatever the proactivity level */
  proposals: MomoProposal[];
  /** every routine the user approved, paused ones too */
  routines: MomoRoutine[];
  /** the sources a routine may read, in Settings' order */
  sources: { id: string; label: string }[];
};

declare module '../native' {
  interface NativeApi {
    momoRoutines: {
      /** the proposals, the routines and the sources they may read; rejects (not_allowed) unless MoMo is on for the account */
      view(): Promise<MomoRoutinesView>;
      /** approve a routine MoMo proposed, as shown (`rev`): refused (changed) when it changed since; null when it is gone */
      approve(routineId: string, rev: number): Promise<{ id: string; name: string } | null>;
      /** pause, resume or edit a routine; the routine, or null when it is gone */
      edit(routineId: string, edit: MomoRoutineEdit): Promise<{ id: string } | null>;
      /** the user's Run now: starts one run at once and resolves to its chat; rejects with why nothing started (already running, harness at its limit, …) */
      runNow(routineId: string): Promise<{ chatId: string }>;
      /** one routine's runs from the last 30 days, newest first; empty when it hasn't run */
      history(routineId: string): Promise<MomoRoutineRun[]>;
      /** decline a proposed routine or remove one: whether it was there */
      remove(routineId: string): Promise<boolean>;
      onChanged(cb: () => void): () => void;
    };
  }
}
