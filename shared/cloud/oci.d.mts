import type { CloudAdapter } from './adapter.mjs';
export type OciConfig = {
  tenancy: string;
  user: string;
  fingerprint: string;
  region: string;
  compartmentId: string;
  subnetId: string;
  availabilityDomain?: string;
  imageId?: string;
};
export function parseSize(id: string): {
  shape: string;
  ocpus: number;
  memoryInGBs: number;
};
export function createOciAdapter(o: {
  config: OciConfig;
  fetch: typeof fetch;
  sign: (signingString: string) => string | Promise<string>;
  now?: () => Date;
}): CloudAdapter;
