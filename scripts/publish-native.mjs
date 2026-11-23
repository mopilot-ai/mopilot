// Publishing a native helper binary: staged, signed and renamed into place so macOS never sees a rewritten Mach-O.

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

// Never overwrite a Mach-O inode that macOS may have mapped or cached a code signature for.
// Build and sign a fresh file on the destination filesystem, then publish it in one rename.
export function publishNativeBinary(
  source,
  destination,
  sign = (_staged) => {
    /* unsigned unless the caller passes a signer */
  },
) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(destination), '.native-'));
  const staged = path.join(staging, path.basename(destination));
  try {
    copyFileSync(source, staged);
    chmodSync(staged, 0o755);
    sign(staged);
    renameSync(staged, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return destination;
}
