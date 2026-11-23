// Types for shared/claudeModels.mjs: Claude Code's model list as the model menu lists it.
import type { ClaudeModelInfo } from './model/native';
import type { HarnessModel } from './model/harness';

export function claudeModels(info: ClaudeModelInfo[]): HarnessModel[];
export function claudeDefaultModel(info: { value: string; resolvedModel?: string }[]): string | null;
