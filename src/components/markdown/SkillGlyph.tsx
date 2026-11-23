// The skill glyph: an outlined, stacked cube, kept apart from SkillLink so a row can draw it without the link's file menu.

/** Outlined, stacked cube used for inline skill mentions. */
export function SkillGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12 2 8 4.6v12L12 23l-8-4.4v-12L12 2Z" />
      <path d="m4 6.6 8 4.6 8-4.6M12 11.2V23M4 12.6l8 4.6 8-4.6M8 8.9l8-4.6" />
    </svg>
  );
}
