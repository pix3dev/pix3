---
name: pix3-ui-conventions
description: Conventions for building or restyling EDITOR UI in Pix3 — Lit panels, dialogs, toolbars, popovers, inspector rows, or any `pix3-*` component and its `.ts.css`. Use BEFORE writing or editing a component so the result matches the rest of the app: vector icons via IconService (never emoji), Light-DOM Lit on ComponentBase, sibling `.ts.css`, theme tokens instead of hardcoded colors, DI for services, and the mutation gateway for state. NOT for game/runtime logic (use pix3-game-dev) or debugging the running editor (use debug-running-game).
---

# Building editor UI on Pix3

New UI must look and behave like it was always part of the app. Reach for the
existing primitives and tokens; don't invent a parallel style. Most "this panel
feels off" problems are one of the five checks below.

## 1. Icons are vector, via `IconService` — never emoji

This is the rule that gets broken most. **Never** paste emoji (📎 🔑 ✕ ✓ 📄 🗑 ⚙)
or Unicode symbol glyphs (↻ ● ⏸ ▶ ✚ →) into a template as a UI icon. They ignore
the theme colour, render differently on every OS, don't align to text, and can't
be sized. Use the shared icon service instead:

```ts
import { IconService, IconSize } from '@/services/IconService';

@inject(IconService)
private readonly icons!: IconService;

// in render():
html`<button class="my-icon-btn" aria-label="Refresh">
  ${this.icons.getIcon('refresh-cw', IconSize.SMALL)}
</button>`
```

- `getIcon(name, size)` returns an inline `<svg>` with `stroke="currentColor"`,
  so it inherits the button's `color` and theme accent automatically.
- Names are [Feather](https://feather.icons) icon ids (`x`, `check`, `key`,
  `paperclip`, `file-text`, `send`, `plus`, `copy`, `refresh-cw`, …) **plus** the
  custom SVGs registered in `IconService.registerCustomIcons()` (`grid`, `snap`,
  `stop`, `sparkles`, `viewport`, node-type icons, …).
- Sizes: `IconSize.SMALL` (14) for inline/toolbar buttons, `MEDIUM` (16),
  `LARGE` (18) for primary toolbar buttons, `XLARGE` (24).
- **Missing icon?** Register a custom SVG in `IconService.registerCustomIcons()`
  (viewBox + `stroke="currentColor"`/`fill="currentColor"`, no hardcoded colour).
  Do **not** fall back to a glyph. An unknown Feather name silently renders a
  `box` fallback and warns — verify the name exists
  (`node -e "console.log('NAME' in require('feather-icons').icons)"`).
- For icon+label buttons, wrap the icon in a span and lay out with flexbox:
  ```css
  .my-btn { display: inline-flex; align-items: center; gap: 0.3rem; }
  .my-btn svg { display: block; width: 0.9rem; height: 0.9rem; }
  ```
  `display: block` on the SVG kills the inline-baseline gap.
- `pix3-toolbar-button` already renders an icon from its `icon=` attribute — use
  it for viewport/toolbar buttons instead of hand-rolling.
- Emoji are acceptable **only inside user-authored content** (chat messages,
  asset names the user typed) — never in chrome (buttons, headers, statuses).

## 2. Component shape (see AGENTS.md “Component System”)

- Extend `ComponentBase` from `@/fw`, not raw `LitElement`.
- **Light DOM by default** (global styles apply). Shadow DOM only when you truly
  need isolation: `static useShadowDom = true`.
- Styles live in a sibling `[component].ts.css`, imported for side effects
  (`import './my-panel.ts.css';`). Scope every rule under the element tag
  (`pix3-my-panel .thing { … }`) so Light-DOM styles don't leak.
- Subscribe to services/state in `connectedCallback`, store the disposer, and
  call it in `disconnectedCallback`.

## 3. Theme tokens, not hardcoded colours

- Accent: `--pix3-accent-color` (#ffcf33) and `--pix3-accent-rgb` (for
  `rgba(var(--pix3-accent-rgb), α)`).
- Match the palette the other panels use so it reads as one app:
  - text `rgba(245, 247, 250, 0.9)` (dim variants at .6/.45),
  - control bg `rgba(16, 20, 24, 0.9)`, input bg `rgba(10, 13, 15, 0.6)`,
  - borders `1px solid rgba(255, 255, 255, 0.12)`,
  - radius ~`0.25rem`, focus `outline: 2px solid rgba(var(--pix3-accent-rgb), 0.6)`.
  - status green `#5ec27a`, error red `#e05c5c`.
- Copy an existing recent panel (`runtime-panel.ts.css`,
  `pix3-agent-chat-panel.ts.css`) rather than eyeballing new values.

## 4. State & mutations go through the gateway

- Never mutate `appState` or node properties directly. UI dispatches a Command
  (`CommandDispatcher.execute`) or invokes an Operation via `OperationService`.
- Read reactive UI state with `subscribe(appState.section, cb)`; nodes live in
  the `SceneGraph` (not reactive) — bridge by ID.

## 5. Services via DI

- `@inject(SomeService)`; services are `@injectable()` singletons. Requires
  `reflect-metadata` (already imported in `main.ts`).

## Quick checklist before finishing a UI change

- [ ] No emoji / symbol glyphs used as icons — all via `IconService`.
- [ ] Component extends `ComponentBase`, styles in a scoped sibling `.ts.css`.
- [ ] Colours come from theme tokens / the shared palette, not literals.
- [ ] Subscriptions disposed in `disconnectedCallback`.
- [ ] State changes flow through Commands/Operations, not direct mutation.
- [ ] `npm run type-check` and `npm run lint` are clean for the touched files.
