// Physical key normalization and native menu accelerator contracts.
export interface ShortcutKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}
export function comboFromEvent(event: ShortcutKey, mac?: boolean): string | null;
export function toAccelerator(combo: string | null | undefined): string | null;
export function isEditingShortcut(combo: string | null | undefined, platform?: string): boolean;
export function nativeShortcutAccelerator(combo: string | null | undefined, platform?: string): string | null;
