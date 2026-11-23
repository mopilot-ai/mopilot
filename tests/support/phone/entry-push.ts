// Observable push wiring for the production entry test: one controller per runtime, and the Android task installed once at load.
export function createProductionPush(runtime: unknown, hooks?: { beforeSignOut?: () => Promise<unknown> }) {
  const w = globalThis as any;
  const push = { runtime, hooks };
  (w.__phonePushes ??= []).push(push);
  return push;
}
export function installDataMessageTask() {
  const w = globalThis as any;
  w.__phoneTaskInstalls++;
  w.__phoneTaskBeforeRegister = w.__phoneRegistered === undefined;
}
