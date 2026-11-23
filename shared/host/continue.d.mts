export const CONTINUE_CODES: Readonly<Record<string, string>>;
export const CONTINUE_FAMILIES_FEATURE: string;
export const CONTINUE_REFUSAL_COPY: Readonly<{ agent_missing: string; agent_signed_out: string; harness_not_configured: string }>;
export class ContinueRefusal extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>);
  code: string;
  details: Record<string, unknown>;
}
