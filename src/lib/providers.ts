// Who bills what: the Accounts & billing page groups by provider and names each one.

export type ProviderId = 'anthropic' | 'openai' | 'mopilot';

export const PROVIDER_LABEL: Record<ProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', mopilot: 'MoPilot' };
