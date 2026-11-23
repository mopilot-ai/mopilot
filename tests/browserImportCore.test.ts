// Browser import cases registered in their original order with shared fake sessions, storage, and temporary readers.
import {
  registerCookieLedger,
  registerRepeatedImport,
  registerLedgerFailures,
  registerStaleRemoval,
  registerWriteFailure,
} from './support/browser-import/cookie-ledger.ts';
import {
  registerRetiredReads,
  registerCancellation,
  registerOverlappingJobs,
  registerQueuedCancellation,
} from './support/browser-import/lifecycle.ts';
import {
  registerImports,
  registerImportEdges,
  registerCookieOwnership,
  registerFlushFailure,
  registerSavedVersion,
} from './support/browser-import/imports.ts';
import { registerReaders } from './support/browser-import/readers.ts';
import { registerPasswords } from './support/browser-import/passwords.ts';

registerCookieLedger();
registerRetiredReads();
registerImports();
registerCancellation();
registerImportEdges();
registerReaders();
registerOverlappingJobs();
registerRepeatedImport();
registerPasswords();
registerLedgerFailures();
registerCookieOwnership();
registerStaleRemoval();
registerQueuedCancellation();
registerFlushFailure();
registerWriteFailure();
registerSavedVersion();
