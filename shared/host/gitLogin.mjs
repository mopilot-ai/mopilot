// The remote GitHub device sign-in target and protocol capability, separate from every chat harness and model credential.
export const GIT_HOST = 'github.com';
export const GIT_LOGIN = 'git:github.com';
export const GIT_SIGNIN_FEATURE = 'gitSignin';

/** Only the device page is relayed; CLI output must never open an arbitrary page or carry credentials in a URL. */
export const gitDevicePage = (url) => url === 'https://github.com/login/device';

/** Git sign-in targets require a capable Host; ordinary harness sign-ins keep their existing protocol. */
export const gitLoginNeeds = (method, params) =>
  ['host.login', 'host.loginStatus', 'host.loginCancel'].includes(method) && params?.harness === GIT_LOGIN ? [GIT_SIGNIN_FEATURE] : [];
