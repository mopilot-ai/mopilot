// The Remote Run milestones the acceptance run can check (`--milestone M1|M2|M5`): which steps each one runs after the install and pairing every one needs.
import { STEPS } from '../steps.mjs';
import { M1_STEPS } from './m1.mjs';
import { M2_STEPS } from './m2.mjs';
import { M4_STEPS } from './m4.mjs';
import { M5_STEPS } from './m5.mjs';
import { M6_STEPS } from './m6.mjs';

export const MILESTONES = Object.freeze({ M1: M1_STEPS, M2: M2_STEPS, M4: M4_STEPS, M5: M5_STEPS, M6: M6_STEPS });
/** The steps of the base run every milestone needs: the machine, the Host installed, a client paired, the fake agent running a turn. */
const SETUP = ['A1', 'A2', 'A3', 'A5', 'A6'];

/** Whether the name on the command line is a milestone. @param {string} name */
export const isMilestone = (name) => Object.hasOwn(MILESTONES, name);

/** The steps of one milestone's run, in order: the setup (each required, since a milestone step has nothing to run on without it) and the milestone's own. @param {keyof typeof MILESTONES} id */
export const milestoneSteps = (id) => [...STEPS.filter((s) => SETUP.includes(s.id)).map((s) => ({ ...s, fatal: true })), ...MILESTONES[id]];
