// Stylesheets imported by renderer entry points (src/main.tsx) load as empty modules in unit tests.
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:') && url.split(/[?#]/)[0].endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
