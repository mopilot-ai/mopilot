// What a cloud acceptance run may spend on the test tenancy (Always Free only; production shares its A1 allowance): one machine at a time, never a paid shape, a boot volume of at most 50 GB, nothing outside the test compartment.
export const LIMITS = Object.freeze({
  shape: 'VM.Standard.A1.Flex',
  size: 'VM.Standard.A1.Flex:1:6',
  ocpus: 1,
  memoryGb: 6,
  /** The adapter's `create` asks for this boot volume (shared/cloud/oci.mjs), and the compartment may hold no more disk than it. */
  bootGb: 50,
  machines: 1,
});

/** The display name every machine of the run starts with; the launcher adds its own suffix. */
export const NAME = 'mopilot-accept';
