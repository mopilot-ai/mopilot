// MoMo's answer chips (alignment row 6): the outlined one-tap answers under the latest question, from the reply's `Options:` line (shared/momoOptions.mjs). A tap sends the label as the person's own message, as typing it would; the chips go with the next turn, whoever starts it, and are not drawn on a read-only chat. The row itself is ChipRow.tsx, shared with the controls of the app's own that ask a question without a model turn.
import { useState } from 'react';
import { sendMessage } from '../../store/send';
import { ChipRow } from './ChipRow';

export function OptionChips({ chatId, options }: { chatId: string; options: readonly string[] }) {
  const [busy, setBusy] = useState(false);
  const pick = async (label: string) => {
    setBusy(true);
    // false: main did not take it and said why (a toast); the chips stay for another try
    if ((await sendMessage(chatId, label, [], { human: true })) === false) setBusy(false);
  };
  return <ChipRow options={options} disabled={busy} onPick={(label) => void pick(label)} />;
}
