// electron-builder's schema check of a configuration, the one a build runs first (a build also merges config files and warns of deprecated options, which this does not): tests call it so a rejected option fails a unit test instead of a release.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateSchema } = require('app-builder-lib/out/util/config/schemaValidator.js');
const schema = require('app-builder-lib/scheme.json');

/** Throws what electron-builder would say about `config` (an unknown option, or one in the wrong place). */
// the validator coerces types in place: it gets a copy
export const checkBuilderConfig = (config: unknown): void => validateSchema(schema, structuredClone(config), { name: 'electron-builder' });
