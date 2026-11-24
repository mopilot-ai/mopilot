// Whether MoMo may use this machine as a task machine (the `momo.hostLink` flag, default off): the app turns it on for a Host it runs by setting MOPILOT_MOMO_HOST_LINK=1 in that Host's environment, and every part of the link (allowing a home's key, serving it, offering the home a key, binding a dialler) reads it here.

/** @param {Record<string, string | undefined>} [env] */
export const hostLinkOn = (env = process.env) => env.MOPILOT_MOMO_HOST_LINK === '1';
