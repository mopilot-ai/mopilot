// Presentation kind of a Host from its registration and cloud metadata.
import { isLocalHostId } from '../../shared/host/localMachine.mjs';
import type { HostMachineRow } from './hostMachines';

export type HostLocationKind = 'background' | 'cloud' | 'remote' | 'ssh';

export function hostLocationKind(id: string, cloud?: HostMachineRow['cloud']): HostLocationKind {
  if (isLocalHostId(id)) return 'background';
  if (cloud) return 'cloud';
  return id.startsWith('ssh:') ? 'ssh' : 'remote';
}
