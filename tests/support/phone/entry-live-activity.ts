// Observable Live Activity wiring for the production entry test: one controller per runtime, started once and stopped on unmount.
export function createProductionLiveActivity(runtime: unknown) {
  const w = globalThis as any;
  const activity = {
    runtime,
    started: 0,
    stopped: 0,
    forgotten: 0,
    forget: async () => void activity.forgotten++,
    start: async () => void activity.started++,
    stop: () => void activity.stopped++,
  };
  (w.__phoneActivities ??= []).push(activity);
  return activity;
}
