// DEV ONLY: the bench scenarios for MoMo (run from the host console), kept apart from scenarios.mjs: its switches (momo, momo-tasks, momo-voice), the reminder and the cards it raises in its own chat.
import { momoSuggestionsScenario, momoBriefScenario } from './scenariosMomoSuggestions.mjs';
import { momoDraftScenario } from './scenariosMomoDraft.mjs';
import { momoOptionsScenario } from './scenariosMomoOptions.mjs';
import { momoReportScenario } from './scenariosMomoReport.mjs';

/** `momo-recipients [many|blocked|off]`: MoMo asks to send to people; `need` gives the host's controls once they exist. */
export function momoRecipientsScenario(/** @type {() => { momoRecipients: (shape: string) => Promise<string> }} */ need) {
  return {
    usage: 'momo-recipients [many|blocked|off]',
    about:
      'MoMo asks to send to people: three names (the default), more than the card lists with "and N more" (many), nobody it can name, with Dismiss only (blocked), or an older Mac\'s card with no count (off)',
    run: (/** @type {string[]} */ [shape = 'three']) => need().momoRecipients(shape),
  };
}

/**
 * `momo-tasks [on|off|failed|empty]`: the Mac lists momo.tasks.list with the four-tab panel (on, the default, every tab with rows and a card up in MoMo's chat),
 * is an older Mac that does not (off), lists it and fails the read (failed), or lists it with no task in any tab (empty).
 * @param {() => { momoTasks: (mode: boolean | 'failed' | 'empty') => Promise<string> | string }} need
 * @param {(arg: string, usage: string) => boolean} onOff the console's on/off reading, which refuses anything else
 */
export function momoTasksScenario(need, onOff) {
  const usage = 'momo-tasks [on|off|failed|empty]';
  return {
    usage,
    about:
      'the Mac lists momo.tasks.list in its hello with the four tabs (on, the default, with a card up in MoMo’s chat), is an older Mac that does not (off), lists it and fails the read (failed), or lists it with nothing in any tab (empty)',
    run: (/** @type {string[]} */ [arg = 'on']) =>
      need().momoTasks(arg === 'failed' || arg === 'empty' ? arg : onOff(arg, 'momo-tasks [on|off]')),
  };
}

/**
 * Every MoMo scenario of the console, in the order `run` lists them.
 * @param {() => any} need the host's controls (scripts/mobile-dev-host/controls.mjs)
 * @param {(arg: string | undefined, usage: string) => boolean} onOff
 */
export function momoScenarios(need, onOff) {
  return {
    momo: {
      usage: 'momo on|off',
      about: 'MoMo allowed or not for the account',
      run: (/** @type {string[]} */ [arg]) => need().momo(onOff(arg, 'momo on|off')),
    },
    'momo-tasks': momoTasksScenario(need, onOff),
    'momo-suggestions': momoSuggestionsScenario(need),
    'momo-brief': momoBriefScenario(need),
    'momo-voice': {
      usage: 'momo-voice [on|off|fail|empty]',
      about:
        'a voice note for MoMo comes back as a made-up sentence (on, the default), as a speech failure (fail) or as silence (empty), or the Mac is an older one that does not list the method (off)',
      run: (/** @type {string[]} */ [arg = 'on']) => {
        if (!['on', 'off', 'fail', 'empty'].includes(arg)) throw new Error('momo-voice [on|off|fail|empty]');
        return need().momoVoice(arg);
      },
    },
    'momo-recipients': momoRecipientsScenario(need),
    'momo-draft': momoDraftScenario(need),
    'momo-options': momoOptionsScenario(need),
    'momo-report': momoReportScenario(need),
    'momo-remind': {
      usage: 'momo-remind [title]',
      about: 'MoMo raises a reminder in its chat, with Done, Snooze and Dismiss',
      run: (/** @type {string[]} */ args) => need().remind(args.join(' ') || undefined),
    },
  };
}
