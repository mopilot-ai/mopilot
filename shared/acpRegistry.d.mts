// Types for normalized ACP registry entries and their platform launch distributions.
export interface RegistryLaunch {
  args: string[];
  env: Record<string, string>;
}
export interface RegistryPackage extends RegistryLaunch {
  package: string;
}
export interface RegistryBinary extends RegistryLaunch {
  archive: string;
  cmd: string;
  sha256?: string;
}
export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  docsUrl: string;
  vendor: string;
  distribution: { binary?: Record<string, RegistryBinary>; npx?: RegistryPackage; uvx?: RegistryPackage };
}
export declare const ACP_REGISTRY_URL: string;
export declare function containedCommand(value: unknown): boolean;
export declare function registryAgent(value: unknown): RegistryAgent;
export declare function registryAgents(value: unknown): RegistryAgent[];
export declare function registryDistribution(
  agent: RegistryAgent,
  tools: { platform: string; arch: string; npm?: boolean; uv?: boolean },
): (({ kind: 'binary' } & RegistryBinary) | ({ kind: 'npx' | 'uvx' } & RegistryPackage)) | null;
export declare function registryDescriptor(agent: RegistryAgent): import('./harnessCatalog.mjs').NativeAcpDescriptor;
