// Opt a main wiring case into the real controller-plan producer, using the live input seams main already captured.
// Import before loadMain installs its inspectable class mocks; callers explicitly supply their native ref and inventories.
import { createRequire } from 'node:module';
import type { Harness } from './electron-main-harness.ts';
const require = createRequire(import.meta.url);
const { ControllerPlans, planInputs } = require('../../electron/session/controllerPlan.cjs');

export function bindActualControllerPlans(h: Harness) {
  const wired = h.one('ControllerPlans');
  // The main harness records planInputs' arguments as an inspection object. Rebuild the real callable from those
  // exact main-owned closures rather than pretending the inspection object is an input producer.
  const plans = new ControllerPlans({ ...wired.opts, inputs: planInputs(wired.opts.inputs.planInputs) });
  wired.snapshot = plans.snapshot.bind(plans);
  return plans;
}
