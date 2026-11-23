// The billing switch in the model picker: which modes a harness can move to.
// Pure, so tests/billingModes.test.ts can run it; the store-bound hook is useBilling (src/session/harness/billing.ts).

/** routed: Claude Code on a model config of the user's own provider; chosen in Settings, where its config is picked, never offered here. */
export type BillingMode = 'subscription' | 'apiKey' | 'mopilot' | 'routed';

/** The modes a harness can move to from `mode`: each one that is already set up (a sign-in, a key or MoPilot credits). */
export function billingOptions(mode: BillingMode, has: { subscription: boolean; apiKey: boolean; credits: boolean }): BillingMode[] {
  return (['subscription', 'apiKey', 'mopilot'] as const).filter((m) => m !== mode && (m === 'mopilot' ? has.credits : has[m]));
}
