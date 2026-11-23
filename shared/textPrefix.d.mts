// Types for Unicode-preserving bounded text prefixes shared by main and renderer.
export function prefixCodePoints(text: string, max: number): string;
export function prefixUnits(s: string, n: number): string;
export function suffixUnits(s: string, n: number): string;
export function wellFormedText(s: string): string;
