# Recipe: recipe-playable-ad

## What this is

The playable-ad shape: a portrait scene with a tap-to-start gate, a short piece
of gameplay, and an end screen whose CTA button reports game end and opens the
store through the engine Playable SDK (`mraid.open` when a network provides it,
`window.open` otherwise). One scene, no menu — an ad has no menu.

The gameplay itself is deliberately a placeholder (`hero-sprite` bobbing on a
`core:Sine`) plus an auto-win timer. Replace both: keep the gate and the CTA,
build the middle. If the brief needs real mechanics, start from `recipe-arena-2d`,
`recipe-bouncer-2d` or `recipe-tapper-2d` and port this gate/CTA structure over.

## Node map

| id | what |
| --- | --- |
| `ui-root` | scene root; hosts `GameFlow` (the phase driver: intro → playing → ended) |
| `background` | full-screen `ColorRect2D` (palette background) |
| `hero-sprite` | placeholder gameplay object, bobbing on a `core:Sine` |
| `hud-label` | in-game text line |
| `intro-overlay` → `intro-dim`, `intro-label` | the tap gate; the first tap hides it, starts the game, and unlocks browser audio |
| `end-screen` → `end-dim`, `end-label`, `cta-button` | end screen, `initiallyVisible: false` |
| `cta-button` | hosts `CtaButton` — `playable.gameEnd()` + `playable.openStore(storeUrl)` |

`GameFlow.finish()` reveals the end screen; call it from your gameplay code for
a real win/lose instead of the placeholder timer.

## Placeholders

| role | file | node |
| --- | --- | --- |
| hero | `sprites/pix3-logo.png` | `hero-sprite` |

## Tunables

```yaml
tunables:
  autoWinAfterSec: { node: ui-root, component: "user:GameFlow", property: autoWinAfterSec, min: 0, max: 120, default: 15 }
  introNode: { node: ui-root, component: "user:GameFlow", property: introNode, default: intro-overlay }
  endNode: { node: ui-root, component: "user:GameFlow", property: endNode, default: end-screen }
  ctaUrl: { node: cta-button, component: "user:CtaButton", property: storeUrl, default: "https://play.google.com/store/apps" }
  bgColor: { node: background, property: color, default: "#16213e" }
```

`component` present → `set_component_property`; absent → `set_property`.

## Extension points

- **Real gameplay.** Replace `hero-sprite` and set `autoWinAfterSec: 0`, then
  call `finish()` on the `GameFlow` component from your own script when the
  player wins or loses. Everything else (gate, end screen, CTA) stays.
- **Fail state.** Add a `lose-label` inside `end-screen` and pick the text in
  your `finish()` caller — a playable that can only be won reads as a demo.
- **Second CTA.** Any `Button2D` with a `user:CtaButton` component works; the
  store URL is per-component, so an early "install now" banner is one node.
- **Network requirements.** Keep everything self-contained: an ad bundle is a
  single HTML file, so no external fetches, and prefer few, small textures.

## Do not touch

- The node ids above (rename `name`, never `id`).
- `intro-overlay` must exist and be visible at start: the first tap is what
  unlocks browser audio, so a playable without a gate ships silent.
- `end-screen` must keep `initiallyVisible: false`.
- Do not import rapier — it would put a ~2 MB wasm payload in an ad bundle.

## Verify

1. `play_start` on `scenes/main.pix3scene`; `intro-overlay` is visible.
2. `game_input` a tap → `intro-overlay` hides and `hero-sprite` starts bobbing.
3. Wait `autoWinAfterSec` → `end-screen` becomes visible with `cta-button`.
4. Press `cta-button` → the SDK reports game end and opens `storeUrl`.
