// Approval display identity follows its native owner or host-card hint, independently of the chat's current harness.
import { parseKind } from './harnessKind.mjs';

function kindOf(value) {
  if (typeof value !== 'string') return null;
  const parsed = parseKind(value);
  return parsed ? (parsed.basic ? `acp:${parsed.basic}` : parsed.basic === null ? parsed.family : null) : null;
}

/** Undefined means legacy/no origin; null means an explicit origin could not be identified. */
export function approvalHarness(request, fallback = undefined) {
  if (request?.sourceHarness !== undefined) return kindOf(request.sourceHarness);
  const source = request?.source;
  const native = source ? (kindOf(source.kind) ?? kindOf(source.key)) : null;
  if (native) return native;
  if (request?.params?.harness !== undefined) return kindOf(request.params.harness);
  return source ? null : fallback;
}

/** Publish only the display kind; private source fields remain with main's answer owner. */
export function publishApproval(request) {
  const { source, ...approval } = request;
  const harness = approvalHarness(request);
  if (harness !== undefined) approval.sourceHarness = harness;
  return { source, approval };
}
