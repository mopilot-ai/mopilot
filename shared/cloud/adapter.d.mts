export type MachineState = 'starting' | 'running' | 'stopped' | 'gone';
export type Size = {
  id: string;
  label: string;
  cpus: number;
  memoryGb: number;
  pricePerHour: number | null;
  currency: string;
};
export type Region = { id: string; label: string };
export type CreateSpec = {
  name: string;
  size: string;
  region: string;
  command: string;
  network?: 'full' | 'limited';
};
export type Flags = {
  resume: boolean;
  selfStop: boolean;
  publicPrice: boolean;
  stopSavesMoney: boolean;
  limitedNetwork: boolean;
};
export interface CloudAdapter {
  id: string;
  flags: Readonly<Flags>;
  why?: Readonly<Partial<Record<keyof Flags, string>>>;
  create(spec: CreateSpec): Promise<{ id: string }>;
  status(id: string): Promise<MachineState>;
  stop(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  find(name: string): Promise<string | null>;
  sizes(): Promise<Size[]>;
  regions(): Promise<Region[]>;
}
export const MACHINE_STATES: readonly MachineState[];
export const ADAPTER_CALLS: readonly string[];
export const FLAG_NAMES: readonly (keyof Flags)[];
export class CloudError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, more?: { retryable?: boolean });
}
export const DEFAULT_WHY: Readonly<Record<keyof Flags, string>>;
export function whyOff(adapter: unknown, flag: string): string | null;
export function adapterProblem(adapter: unknown): string | null;
export function isMachineState(v: unknown): v is MachineState;
export function createFakeProvider(o?: {
  id?: string;
  boot?: (command: string, id: string) => void;
  flags?: Partial<Flags>;
}): CloudAdapter & {
  calls: { call: string; args: unknown[] }[];
  machines: Map<
    string,
    {
      name: string;
      size: string;
      region: string;
      command: string;
      state: string;
      disk: boolean;
      network: string;
    }
  >;
  failNext(call: string, error: unknown): void;
  set(machine: string, state: string): void;
};
