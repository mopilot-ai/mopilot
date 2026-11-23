// The Scheduled dialog's controls: a select that opens a menu of options (with a hint or disabled), and an on/off switch.
import { Menu, MenuItem, useAnchor } from '../../ui/Popover';
import { ChevronDown } from '../../ui/icons';

/** A select's option: [value, label], or one with a hint (where it runs) or that can't be picked now. */
type SchedOption = [string, string] | { value: string; label: string; hint?: string; disabled?: boolean };
const optionOf = (o: SchedOption) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o);

export function SchedSelect({
  label,
  value,
  options,
  onChange,
  display,
}: {
  label: string;
  value: string;
  options: SchedOption[];
  onChange: (v: string) => void;
  display?: string;
}) {
  const a = useAnchor();
  const opts = options.map(optionOf);
  const cur = opts.find((o) => o.value === value);
  return (
    <>
      <button ref={a.ref} className="sched-select" aria-label={label} onClick={a.toggle}>
        <span>{display ?? cur?.label ?? value}</span>
        <ChevronDown size={14} />
      </button>
      <Menu anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end" width={opts.some((o) => o.hint) ? 300 : 200}>
        {opts.map((o) => (
          <MenuItem key={o.value} checked={o.value === value} hint={o.hint} disabled={o.disabled} onSelect={() => onChange(o.value)}>
            {o.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span className="toggle-knob" />
    </button>
  );
}
