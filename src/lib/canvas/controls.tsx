// Canvas controls use value callbacks rather than DOM-event callbacks, matching authored plans and filters.
import type { CSSProperties, ReactNode } from 'react';
import { toneColor } from './theme';
import { busyField } from '../focus';
type Content = { children?: ReactNode; style?: CSSProperties };
export function Button({
  children,
  variant = 'secondary',
  disabled,
  type = 'button',
  style,
  onClick,
}: Content & { variant?: string; disabled?: boolean; type?: 'button' | 'submit' | 'reset'; onClick?: () => void }) {
  return (
    <button className={`canvas-button ${variant}`} type={type} disabled={disabled} style={style} onClick={onClick}>
      {children}
    </button>
  );
}
export function Pill({
  children,
  active,
  tone,
  size,
  leadingContent,
  keyboardHint,
  disabled,
  title,
  style,
  onClick,
}: Content & {
  active?: boolean;
  tone?: string;
  size?: string;
  leadingContent?: ReactNode;
  keyboardHint?: string;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const appearance = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: size === 'sm' ? '2px 6px' : '4px 10px',
    borderRadius: 20,
    border: '1px solid var(--border)',
    background: active ? 'var(--secondary)' : 'transparent',
    color: `var(--${toneColor(tone)})`,
    ...style,
  };
  const content = (
    <>
      {leadingContent}
      {children}
      {keyboardHint && <kbd>{keyboardHint}</kbd>}
    </>
  );
  return onClick ? (
    <button type="button" aria-pressed={!!active} style={appearance} disabled={disabled} title={title} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span style={appearance} title={title}>
      {content}
    </span>
  );
}
type TextControl = { value?: string; onChange?: (value: string) => void; placeholder?: string; disabled?: boolean; style?: CSSProperties };
export function TextInput({ value, onChange, placeholder, disabled, type = 'text', style }: TextControl & { type?: string }) {
  return (
    <input
      className="canvas-input"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      {...busyField(!!disabled)}
      type={type}
      style={style}
    />
  );
}
export function TextArea({ value, onChange, placeholder, disabled, rows = 3, style }: TextControl & { rows?: number }) {
  return (
    <textarea
      className="canvas-input"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      {...busyField(!!disabled)}
      rows={rows}
      style={style}
    />
  );
}
export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  style,
}: TextControl & { options: { value: string; label: string; disabled?: boolean }[] }) {
  return (
    <select
      className="canvas-input"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      disabled={disabled}
      aria-label={placeholder}
      style={style}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
type CheckControl = { checked?: boolean; onChange?: (checked: boolean) => void; disabled?: boolean; style?: CSSProperties };
export function Checkbox({ checked, onChange, disabled, label, style }: CheckControl & { label?: ReactNode }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange?.(event.target.checked)} disabled={disabled} />
      {label}
    </label>
  );
}
export function Toggle({ checked = false, onChange, disabled, size, style }: CheckControl & { size?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange?.(!checked)}
      disabled={disabled}
      style={{ fontSize: size === 'sm' ? 'var(--canvas-small)' : 'var(--canvas-body)', ...style }}
    >
      {checked ? 'On' : 'Off'}
    </button>
  );
}
export function IconButton({
  title,
  children,
  onClick,
  disabled,
  variant,
  size,
  style,
}: Content & { title?: string; onClick?: () => void; disabled?: boolean; variant?: string; size?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        borderRadius: variant === 'circle' ? '50%' : 4,
        fontSize: size === 'sm' ? 'var(--canvas-small)' : 'var(--canvas-body)',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
