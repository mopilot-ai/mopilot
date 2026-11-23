# Interface style guide

The rules for interface work: where the design tokens live, which shared components to use, and how layout, motion,
text and accessibility are expected to behave. The detailed rules and their guards live in the guides linked from
each section; this page is the entry point.

## Principles

- **Calm and dense.** MoPilot sits beside an agent doing real work. Surfaces are quiet, rows are compact and color
  marks state, not decoration.
- **One system.** A new surface reuses the tokens and components below. When none fits, extend the shared one rather
  than writing a parallel version.
- **Every theme, every size.** Each surface works in light and dark mode, under every theme preset and accent, at
  the smallest and largest Chat font size, and at the narrowest window (1024×682 with the side panels open).
- **The same on every agent.** Codex, Claude Code and ACP chats share one interface. An agent-specific difference
  shows as a capability (enabled, degraded or unavailable), never as a separate look.

## Tokens

[`src/styles/tokens.css`](../src/styles/tokens.css) defines every token. Read a token; never write a literal.

| Kind | Tokens | Rule |
| --- | --- | --- |
| Surfaces | `--main`, `--sidebar`, `--surface`, `--surface-2`, `--surface-3`, `--menu-bg`, `--composer-bg`, `--card-bg` | Derived at runtime from the palette; see [Colors](code-quality.md#colors). |
| Text | `--text`, `--text-ui`, `--text-2`, `--text-3`, `--text-4`, `--placeholder` | Step down for secondary text instead of lowering opacity by hand. |
| Accent and status | `--accent`, `--accent-soft`, `--green`, `--red`, `--yellow`, `--orange`, `--purple` | Tint with `color-mix(in srgb, var(--green) 15%, transparent)`. |
| Lines and shadows | `--divider`, `--hairline`, `--hairline-strong`, `--shadow-card`, `--menu-shadow` | Mix new shadows from `--shadow-ink`: `rgba(var(--shadow-ink), 0.4)`. |
| Type | `--fs-micro` … `--fs-title`, `--fs-display`, `--fs-code`, `--lh-prose`, `--lh-code` | Pick the nearest step; see [Type scale](code-quality.md#type-scale). |
| Shape and layout | `--row-h`, `--row-radius`, `--card-radius`, `--card-radius-lg`, `--menu-radius`, `--composer-radius`, `--composer-w`, `--sidebar-w` | Reuse the radius of the element kind you are building. |
| Motion | `--dur-fast`, `--dur-snap`, `--dur-base`, `--dur-sheet`, `--dur-slow`, `--ease-snap`, `--ease-move`, `--spring-press` | One duration per kind of moment, as the comments in `tokens.css` describe. |

Lint rules enforce the color and type tokens (`lint/rules/literal-color.grit`, `inline-color.grit`,
`type-scale.grit`), and the lint ratchet keeps their counts from rising.

## Components

Start from the shared primitives in [`src/components/ui/`](../src/components/ui/):

| Need | Use |
| --- | --- |
| Icons | `icons.tsx`: lucide icons plus MoPilot's own marks. Do not import an icon set directly. |
| A menu, submenu or tooltip | `Popover.tsx`, with `MenuList.tsx` for keyboard-navigable lists. |
| A small dialog | `Modal.tsx`: titled, dismissed by Escape, a click outside or its close button. |
| A transient message | `Toasts.tsx`, with at most one action. |
| A link to a web page | `WebLink.tsx`: a real anchor that opens the system browser. |

A component that owns its styles keeps them in a CSS Module next to it; global styles go in the area files under
`src/styles/app/`. [Stylesheets](code-quality.md#stylesheets) explains both and the tests that check them.

## Layout

- Chats and the composer are centered at `--composer-w`; panels open beside them, not over them.
- Rows are `--row-h` high with `--row-radius` corners. Lists keep one row per item at every font size.
- Text beside an icon stays on the icon's line at Chat font sizes up to 24px.
- Long names truncate with an ellipsis and show the full text in a tooltip.

## Motion

Motion explains a change; it never delays one. Use the motion tokens, keep hover feedback under `--dur-snap`, and
respect the system's reduced-motion setting, which `src/styles/app/motion.css` applies globally.

## Writing

- Follow the [interface copy guide](ui-copy.md): one short question per card, one line per notice, details in a
  tooltip.
- Write English in the source; the build makes it translatable ([interface languages](i18n.md)). Check that a longer
  translation still fits.
- Show the accurate state: say when something is degraded, blocked or unsupported, and never claim a success that did
  not happen.

## Accessibility and testability

- Every control has a role and an accessible name (its text, or `aria-label` for an icon button).
- State is a data or ARIA attribute (`data-state="merged"`, `aria-checked`), not a modifier class.
- Everything is reachable by keyboard; menus follow the WAI-ARIA patterns `MenuList.tsx` implements. Shortcuts follow
  the [keyboard shortcut guide](keyboard-shortcuts.md).
- Tests find elements by role, label or data attribute, never by a class, which CSS Modules hash.

## Checking a change

Look at the change in light and dark mode, at the smallest and largest Chat font size, at the narrowest window and
with a long translation. Attach before and after screenshots to the pull request.
