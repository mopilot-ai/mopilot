export type RefusalAction = 'install' | 'signIn' | 'orgSignIn' | 'update' | 'openMachines' | 'newChat' | 'chooseFolder' | 'useMode';
/** `mode` with `useMode`: the most the machine allows, which the chat goes on under */
export type RefusalWords = { line: string; action: RefusalAction | null; retry: boolean; mode?: string; named?: true };
export type AgentState = 'ready' | 'signin' | 'missing' | null | undefined;
export type RefusalContext = {
  machine: string;
  agent?: string;
  message?: string;
  details?: Record<string, unknown>;
  agentState?: AgentState;
  agentWas?: AgentState;
  installable?: boolean;
  own?: boolean;
  context?: 'send' | 'continue';
};
export const REFUSAL_ACTIONS: readonly RefusalAction[];
export const REFUSAL_CODES: readonly string[];
export function refusalWords(code: string | undefined, context: RefusalContext): RefusalWords | null;
