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
import { IconService, IconSize } from '@/services/editor/IconService';

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

## 6. Adding a menu command

The main menu is generated from command metadata — there is no menu file to edit.

- **Pick the section by what the command acts on**, not by what feels close:
  `file` (the project as a file), `edit` (undo/dup/delete + Editor Settings),
  `create` (new nodes), `node` (operations on the selection), `view` (what the
  viewport shows), `run` (play/stop and preview), `project` (settings, build,
  export, bake), `window` (open or focus a panel or editor). Anything that opens
  a panel goes in `window` — the View/Tools split it replaced is why nobody
  could find Logs.
- **`menuOrder` is banded**: hundreds digit = semantic group, tens = slot, units
  reserved for later inserts. A separator is drawn automatically wherever the
  hundreds digit changes between neighbours, so grouping is the numbering, not
  markup. `(menuPath, menuOrder)` must be unique and `menuOrder` is mandatory —
  `CommandRegistry.menu.spec.ts` fails the build otherwise, naming the offenders.
- **A two-state command is checkable, not a verb**: give it
  `checked: snapshot => …` and title it with the noun the check mark modifies
  (`Grid`, not `Toggle Grid`). The same predicate feeds `commandRegistry
  .isChecked(id)`, which the viewport toolbar reads for its pressed state — so a
  toggle cannot show one thing in the menu and another on the toolbar.
- **Ellipsis** means the command asks for input or confirmation *before* acting.
  Opening a panel or a tab is not a dialog.
- **A submenu** is `menuPath: 'node/align'`. Its row is not a command, so its
  label and its slot in the parent both live in `SUBMENU_ROWS`.
- The menu title supplies context: under `Run` the row is `Stop`, not
  `Stop Game`; under `Create` it is the node type, not `Create <Type>`.

Rationale and the full inventory: `.plans/done/ui-consistency-pass.md` §2.

## 7. Inspector controls: one primitive set

`src/ui/object-inspector/inspector-controls.ts.css` is the whole vocabulary, and
every rule in it is scoped under `pix3-inspector-panel` — that file's older
sibling is 1500 lines of unscoped Light-DOM globals, one of which was styling
`pix3-panel` across the entire editor. Do not add a seventh button class.

- `.inspector-btn` — quiet action, icon + label. `--primary` for the single
  "add" action of a list, `--danger` for destructive (neutral at rest, red only
  on hover/focus), `--toggle` for a pressed state (`aria-pressed`), `--icon` for
  icon-only.
- **Icon-only** is for a control with ≤3 neighbours whose glyph is conventional
  (`trash-2`, `plus`, `eye`, `lock`, `rotate-ccw`, chevrons). Anything else keeps
  its label — "edit the groups this node belongs to" has no icon anyone knows.
  Icon-only controls MUST carry both `title` and `aria-label`; a spec asserts it
  across the whole inspector.
- **Enabled/disabled state is `.inspector-switch`** (`role="switch"`,
  `aria-checked`), never a button labelled with its own current state. Do not
  reach for `eye`/`eye-off` here: in this editor those mean *visibility*.
- **A single choice is `.inspector-segment`**, a `role="radiogroup"` with roving
  tabindex — not a row of buttons that happen to look pressed.
- **A sub-block is `.inspector-subsection`** (header + right-hand actions slot +
  body + hint). Two systems that do comparable things get the same shape: that is
  why Anchors and Flow now read alike instead of one being a button and the other
  a checkbox.
- **Section order comes from the schema**, not the alphabet: three pinned bands
  (`Node`, `Transform`, `Layout`) and then declaration order. `groups[name]
  .expanded === false` starts a section collapsed; collapse state persists per
  node type under one `localStorage` key.

## Quick checklist before finishing a UI change

- [ ] No emoji / symbol glyphs used as icons — all via `IconService`.
- [ ] Component extends `ComponentBase`, styles in a scoped sibling `.ts.css`.
- [ ] Colours come from theme tokens / the shared palette, not literals.
- [ ] Subscriptions disposed in `disconnectedCallback`.
- [ ] State changes flow through Commands/Operations, not direct mutation.
- [ ] A new menu command has a unique banded `menuOrder`, the right section, and
      a `checked` predicate if it is a toggle.
- [ ] Inspector controls reuse the primitives; icon-only ones have `title` +
      `aria-label`.
- [ ] `npm run type-check` and `npm run lint` are clean for the touched files.
