// This phone's name as its owner knows it, for the Mac's pairing card and the account's device list: the name the system gives, or on an iPhone that only says "iPhone" (unless the app may read the name the user set) its model, so two phones read apart; cleaned and cut short, else the platform's name.
import { cleanComputerName } from '../../shared/remote/computerName.mjs';

/** Short enough for one line on the Mac's card (which cuts at 60) and the account's device list. */
export const MAX_PHONE_NAME = 40;

/** What iOS answers instead of the name the user set. */
const GENERIC = new Set(['iPhone', 'iPad']);
/** The hardware id a table that doesn't know the model answers with ("iPhone18,2"): not a name anyone knows. */
const HARDWARE_ID = /^[A-Za-z]+\d+,\d+$/;

const short = (name: string) => [...name].slice(0, MAX_PHONE_NAME).join('').trim();

/**
 * @param constants expo-constants' default export, or what a test gives in its place
 * @param model the device's model name when the build can read it ("iPhone 16 Pro")
 */
export function phoneName(
  constants: { deviceName?: unknown; platform?: { ios?: unknown; android?: unknown } | null } | null | undefined,
  model?: string | null,
): string {
  const name = cleanComputerName(constants?.deviceName);
  const known = cleanComputerName(model);
  const usable = known && !HARDWARE_ID.test(known) ? known : null;
  if (name && !GENERIC.has(name)) return short(name);
  if (usable && (name || constants?.platform?.ios)) return short(usable);
  if (name) return short(name);
  if (constants?.platform?.ios) return 'iPhone';
  if (constants?.platform?.android) return 'Android phone';
  return 'Phone';
}
