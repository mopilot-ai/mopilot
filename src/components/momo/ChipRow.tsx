// The outlined one-tap chip row of MoMo's questions (alignment row 6), drawn once for both its users: the answers under a model's `Options:` line (OptionChips.tsx, whose tap sends the label as the person's message) and a control of the app's own such as the draft card's account question (whose tap only changes that control and sends nothing to the model). It draws and reports the tap; what a tap does is the caller's.
import type { CSSProperties } from 'react';
import { SHELL_COPY } from './shell/shellCopy';
import styles from './momoOptions.module.css';

export function ChipRow({
  options,
  onPick,
  disabled = false,
  label = SHELL_COPY.answers,
}: {
  options: readonly string[];
  /** a tap: the chip's label and its place in the row */
  onPick: (label: string, index: number) => void;
  disabled?: boolean;
  /** the group's accessible name */
  label?: string;
}) {
  return (
    <div className={styles.chips} role="group" aria-label={label} data-option-chips="">
      {options.map((text, i) => (
        <button
          key={text}
          type="button"
          className={styles.chip}
          style={{ '--i': i } as CSSProperties}
          disabled={disabled}
          onClick={() => onPick(text, i)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
