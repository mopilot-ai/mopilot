// Grants, concurrency, and ownership matrix suites registered in their original order with shared fake surfaces.
import { registerGrants } from './support/grants-matrix/grants.ts';
import { registerConcurrency } from './support/grants-matrix/concurrency.ts';
import { registerOwnership } from './support/grants-matrix/ownership.ts';

export const GUARDS = ['electron/', 'shared/'];

registerGrants();
registerConcurrency();
registerOwnership();
