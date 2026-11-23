// Claude Code's mark: an orange rounded square with a white asterisk, for the harness picker and the review findings in the diff.
import { MARKS } from '../../../lib/brandColors';
export function ClaudeMark({ size }: { size: number }) {
  return (
    <svg className="harness-icon claude" width={size} height={size} viewBox="0 0 24 24" aria-label="Claude Code">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill={MARKS.claude.tile} />
      <g stroke={MARKS.claude.glyph} strokeWidth="1.9" strokeLinecap="round">
        <path d="M12 6.2v11.6M6.2 12h11.6M7.9 7.9l8.2 8.2M16.1 7.9l-8.2 8.2" />
      </g>
    </svg>
  );
}
