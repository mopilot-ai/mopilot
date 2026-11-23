// The line a card keeps once it is answered: where it was answered, and with what when this phone did it.
import { Platform } from 'react-native';

export type Receipt = { by: 'phone' | 'mac' /** What was chosen, known only when this phone answered. */; choice?: string };

/** "Allowed once · answered on this iPhone", "Answered on your Mac". An answer from elsewhere is the Mac's. */
export function receiptLine(receipt: Receipt, os: string = Platform.OS): string {
  const where = receipt.by === 'phone' ? (os === 'ios' ? 'this iPhone' : 'this phone') : 'your Mac';
  return receipt.choice ? `${receipt.choice} · answered on ${where}` : `Answered on ${where}`;
}

/** What the person chose on a card, as its receipt says it: the choice's label, and for a plan that was sent back, that changes were asked for. */
export function choiceLabel(
  card: { kind?: string; choices?: { key: string; label: string; deny?: boolean }[] },
  key: string,
): string | undefined {
  const choice = card.choices?.find((c) => c.key === key);
  return choice && card.kind === 'plan' && choice.deny ? 'Asked for changes' : choice?.label;
}
