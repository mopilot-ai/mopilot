// The Host's managed-policy file (plan W2): the shared reader on this Host's path. A root-owned file the Host's user cannot write is read, kept as last good, and watched; a Host stop closes the watch.
import fs from 'node:fs';
import { createManagedReader } from '../../shared/managedPolicyReader.mjs';

/** @param {Omit<Parameters<typeof createManagedReader>[0], 'product' | 'fs'> & { fs?: typeof import('node:fs') }} [o] */
export const createManagedFile = (o = {}) => createManagedReader({ ...o, product: 'host', fs: o.fs ?? fs });
