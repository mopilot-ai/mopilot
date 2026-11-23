// The directory services a Host's line protocol serves (fs.*, git.*): one set over the browsing roots and the ledger, made by the serve entry (./cli.mjs).
import { createHostGit } from './hostGit.mjs';
import { createHostRead } from './hostRead.mjs';
import { createHostFiles } from './hostFiles.mjs';
import { createHostSearch } from './hostSearch.mjs';

/** @param {{ hostFs: ReturnType<typeof import('./hostFs.mjs').createHostFs>, ledger: ReturnType<typeof import('./ledger.mjs').createLedger> }} o */
export const createHostDirs = ({ hostFs, ledger }) => ({
  hostFs,
  hostGit: createHostGit({ hostFs, ledger }),
  hostRead: createHostRead({ hostFs }),
  hostFiles: createHostFiles({ hostFs }),
  hostSearch: createHostSearch({ hostFs }),
});
