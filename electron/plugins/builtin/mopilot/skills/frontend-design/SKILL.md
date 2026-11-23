---
name: frontend-design
description: Use when building or restyling a web page, component or app UI where visual quality matters (landing pages, dashboards, forms, prototypes). Guides you to a deliberate, coherent design instead of generic defaults, then to verify it in a browser.
---

# Frontend design

Make design decisions on purpose. A generic default look is the failure to avoid, and so is a clever look that is hard to use.

## Before writing code

1. Read the project: its framework, component library, tokens, existing pages. Match them unless the user asks for a new direction.
2. State, in a few lines, who the page is for, the one job it must do, and the visual direction (for example: calm and editorial, dense and technical, playful). Pick one direction and hold it.

## Decisions

- **Type.** Choose a type pairing with intent: a display face for headings and a readable text face. Set a scale (for example 1.25 ratio) and use few sizes. Body text at 16px or more, line height 1.4 to 1.6, line length 45 to 75 characters.
- **Color.** Define tokens once (CSS variables): background, surface, text, muted text, border, one accent, plus success, warning and danger. Check contrast (4.5:1 for body text). Support dark mode by redefining the tokens, not by overriding components.
- **Space and layout.** Use a spacing scale (4 or 8px steps) and a clear grid. Group related items, separate unrelated ones, and give the main action visual weight. Design the narrow screen first and check wide ones.
- **Components.** Cover every state: hover, focus-visible, active, disabled, loading, empty, error. Targets at least 44px on touch. Keyboard order follows visual order.
- **Motion.** Short (150 to 250ms), purposeful, and off when the user prefers reduced motion.
- **Content.** Use real, specific copy and plausible data, not lorem ipsum. Short labels beat sentences.
- **Imagery.** Prefer SVG, CSS shapes and real assets over stock-looking filler. Give images alt text and fixed dimensions to avoid layout shift.

## Avoid

- Default system look with no decision behind it, purple-on-white gradients by reflex, cards inside cards, and decoration that does not help the reader.
- Many fonts, many accent colors, or inconsistent radii and shadows.
- Fixed pixel layouts that break at narrow widths, and color as the only signal.

## Build and check

1. Build the smallest working version of the structure first, then refine style.
2. Run it and look at it: open the page in the browser tools, check a phone width and a wide width, light and dark, keyboard tab order, and the empty and error states.
3. Fix what you see. Report what you changed and which decisions you made, in a few lines.
