// ACP form presentation and response types shared across the main and renderer boundaries.
export type AcpValue = string | number | boolean | string[];
export interface AcpField {
  key: string;
  type: 'string' | 'array' | 'number' | 'integer' | 'boolean';
  title: string;
  description: string | null;
  required: boolean;
  options: { value: string; label: string; description: string | null }[] | null;
  min: number | null;
  max: number | null;
  format: string | null;
  default?: AcpValue;
}
export interface AcpForm {
  fields: AcpField[];
}
export interface AcpAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, AcpValue>;
}
export interface AcpDelivery {
  status: 'pending' | 'written' | 'answered' | 'failed' | 'retired' | 'denied' | 'cancelled' | 'sending';
  error?: string | null;
}
export interface AcpQuestion extends AcpDelivery {
  id: string;
  kind: 'question';
  harness: string;
  message: string;
  toolCallId: string | null;
  form: AcpForm;
  /** the questions a machine's agent asked (Codex request_user_input, Claude Code AskUserQuestion), drawn as the app's own question card; absent for a real form */
  asked?: import('../hostAsked.mjs').AskedQuestion[];
  /** how many times a machine could not take an answer and the question came back to be answered again */
  retried?: number;
  action?: AcpAnswer['action'];
}
export function parseAcpForm(schema: unknown, message?: string): AcpForm;
export function validateAcpAnswer(form: AcpForm, answer: unknown): AcpAnswer;
export function acpFormDefaults(form: AcpForm): Record<string, AcpValue>;
