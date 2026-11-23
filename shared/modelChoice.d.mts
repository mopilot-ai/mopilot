// Typed model intent and recommendation resolution shared by native adapters and window selection readers.
export function chatModelChoice<T>(
  saved: { model?: string | null } | null | undefined,
  reported: string | null | undefined,
  fallback: T,
): string | null | T;
export function effectiveModel(
  selected: string | null | undefined,
  recommended: string | null | undefined,
  configured?: string | null,
): string | null;
