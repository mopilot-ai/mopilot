// window.native.routines's types (routines, #3571 G4), merged into NativeApi; the calls are declared in electron/bridge/routines.cjs.
export {};

/** A routine as Settings shows it (electron/app/ipc/routines.cjs view): its steps as lines, its parameters by name. */
export interface RoutineView {
  id: string;
  rev: number;
  kind: 'browser' | 'desktop';
  name: string;
  description: string;
  steps: string[];
  params: string[];
  runs: number;
  updatedAt: number;
}

/** Every answer: what was asked for, or why not. */
export type RoutinesResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

declare module '../native' {
  interface NativeApi {
    routines: {
      list(): Promise<RoutinesResult<{ routines: RoutineView[]; skillsProblem: string | null }>>;
      saveLast(chatId: string, name: string): Promise<RoutinesResult<{ routine: RoutineView }>>;
      edit(id: string, rev: number, edit: { name?: string; description?: string }): Promise<RoutinesResult<{ routine: RoutineView }>>;
      remove(id: string): Promise<RoutinesResult<{ removed: boolean }>>;
      onChanged(cb: () => void): () => void;
    };
  }
}
