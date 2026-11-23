// Types for validated machine catalogs and machine/harness-scoped composer picks.
export interface MachineModel {
  id: string;
  name: string;
  default: boolean;
  efforts: string[];
  defaultEffort: string | null;
  description?: string;
  /** the model this entry runs, as a display name with its version (at most 60 characters); absent when the Host does not say */
  resolvedModel?: string;
  /** the pinned model id behind it */
  resolvedId?: string;
  supportsFastMode?: boolean;
  /** false: the model cannot run under "Approve for me"; absent when the Host does not say (no gate) */
  supportsAutoMode?: boolean;
}
export interface HostModelPick {
  hostId: string;
  harness: string;
  model: string;
  effort: string | null;
}
export function machineModels(value: unknown): MachineModel[];
/** The effort a model runs at when none is chosen: its Host's, else the shared default rule (`high` when offered, else the first level); null without levels. */
export function modelDefaultEffort(model: MachineModel): string | null;
export function hostModelSelection(
  models: MachineModel[],
  pick: HostModelPick | null | undefined,
  hostId: string,
  harness: string,
  remembered?: string | null,
): {
  model: MachineModel | null;
  effort: string | null;
  unavailable: boolean;
};
