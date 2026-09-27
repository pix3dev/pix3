---
name: pix3-nodes
description: Compact property reference for the Pix3 2D node types used by the recipes — Group2D, ColorRect2D, Sprite2D, Label2D, Button2D, Bar2D, CanvasLayer2D, PostProcess — plus the Node2D base properties, anchor layout and paint order. Use when adding a node to a .pix3scene, choosing which node type to use, or checking a property name/type before writing it.
---

# 2D nodes — compact reference

Property names below are the exact YAML keys under `properties:`. A misspelled key is kept
silently and does nothing, so copy them from here or from an existing node in the project.

Phase 1 ships the full per-node reference as a file in this skill folder
(`node-types-reference.md`; grep `### <NodeName>`). If it is not there, this page and the
recipe's own scenes are your reference.

## Which node

| Need | Node |
| --- | --- |
| Scene root, a panel, a spawn band, any sized container | `Group2D` |
| Solid rectangle; the honest placeholder | `ColorRect2D` |
| An image (PNG/JPG/WebP/SVG you wrote) | `Sprite2D` |
| Text | `Label2D` |
| Tappable button | `Button2D` |
| Health / progress bar | `Bar2D` |
| Fixed HUD layer that ignores the 2D camera and is never post-processed | `CanvasLayer2D` |
| Bloom / vignette | `PostProcess` (no transform; set `affect2D: true` in a 2D scene) |
| Bare transform, no size | `Node2D` |

Other 2D types exist (`TiledSprite2D` nine-slice panels, `AnimatedSprite2D`, `Slider2D`,
`Checkbox2D`, `Joystick2D`, `ScrollContainer2D`, `InventorySlot2D`, `Camera2D`,
`SpineSkeleton2D`); do not guess their keys — read the full reference first. `Layout2D` is
removed and fails the load.

## Every 2D node (Node2D base)

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `transform` | block | — | `{ position: [x, y], scale: [sx, sy], rotation: degrees }` — centre of the node, Y up |
| `visible` | bool | true | On an overlay **instance**: editor-only hide (see pix3-scene-format) |
| `initiallyVisible` | bool | — | Applied when play mode starts; authored on an overlay file's root |
| `opacity` | number | 1 | 0..1, multiplies into children |
| `zIndex` | int | 0 | -4096..4096; higher draws on top; ties = tree order |
| `zAsRelative` | bool | true | Add to the parent's z instead of absolute |
| `blendMode` | enum | normal | `normal`, `additive` (glow/VFX), `multiply`, `subtract`; not inherited |
| `layout` | block | — | `{ enabled, horizontalAlign: left/center/right/stretch, verticalAlign: top/center/bottom/stretch }` |
| `flow` | block | — | `{ enabled, direction: vertical/horizontal, gap, paddingX, paddingY, align: start/center/end, autoSize }` |
| `effects` | list | — | `[{ type: core:tint, params: { color: "#hex", amount: 1 } }]` (also `core:adjust`, `core:grayscale`) |

Paint order = tree order (later sibling / deeper node on top) unless `zIndex` says otherwise.

## Group2D

Sized container; draws nothing. Use it as the scene root (`width: 1080, height: 1920`,
`layout` stretch/stretch) and for any panel whose children anchor or flow against it.

| Key | Type | Default |
| --- | --- | --- |
| `width` | number | 100 |
| `height` | number | 100 |

## ColorRect2D

The only untextured 2D fill. Build the game from these first, swap to sprites later.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `width` | number | 100 | |
| `height` | number | 100 | |
| `color` | colour | "#ffffff" | Quoted hex. Alpha via `opacity`, not the colour |

## Sprite2D

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `texture` | texture | — | `{ type: 'texture', url: 'res://sprites/x.png' }` (the recipes' form; a plain `texturePath: 'res://…'` string is also read) |
| `width` | number | 64 | Display size; the image is scaled to it |
| `height` | number | 64 | |
| `color` | colour | "#ffffff" | Tint; white = untinted |

Recipe placeholders are near-white `sprites/ph-*.png` + `effects: [{ type: core:tint, params: { color, amount: 1 } }]`.

## Label2D

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `label` | string | "" | The text; `\n` breaks lines. Never only emoji |
| `labelFontSize` | number | 16 | px |
| `labelColor` | colour | "#ffffff" | |
| `labelFontFamily` | string | Arial | A family the project ships in `fonts/`, else a system face |
| `labelFontWeight` | number/string | normal | 400 / 700 / 900 … |
| `labelAlign` | enum | center | `left`, `center`, `right` |
| `labelVAlign` | enum | middle | `top`, `middle`, `bottom` |
| `width` / `height` | number | 0 | 0 = auto-size, no wrap. Set `width` to word-wrap |
| `glowColor` / `glowStrength` | colour / 0–4 | "#ffffff" / 0 | Canvas-drawn neon glow; 2–3 reads as neon |
| `outlineColor` / `outlineWidth` | colour / px | "#000000" / 0 | Contrast outline |
| `labelShadowColor`, `labelShadowOffsetX/Y`, `labelLetterSpacing`, `typewriterSpeed` | | | see full reference |

Scripts: `label.setText('SCORE 5')`.

## Button2D

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `width` / `height` | number | 100 / 40 | |
| `label` | string | "" | Caption; `labelFontSize` (16), `labelColor` ("#ffffff"), `labelAlign` as on Label2D |
| `backgroundColor` | colour | "#4a4a4a" | Flat idle colour |
| `hoverColor` | colour | "#5a5a5a" | |
| `pressedColor` | colour | "#3a3a3a" | |
| `buttonAction` | string | "Submit" | Free identifier for scripts |
| `enabled` | bool | true | A disabled button takes no input |
| `textureNormal` / `textureHover` / `texturePressed` / `textureDisabled` | texture | — | Skin sprites; a set slot replaces the flat colour |
| `sliceBorderLeft/Right/Top/Bottom` | number | 0 | Nine-slice insets in source pixels |

Signals: `pressed`, `released`, `click`, `pointerdown`, `pointerup`. The recipes wire
buttons with `button.connect('pressed', this, handler)`.

## Bar2D

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `width` / `height` | number | 150 / 20 | |
| `minValue` / `maxValue` / `value` | number | 0 / 100 / 100 | Fill = value within the range (clamped) |
| `barColor` | colour | "#ff4444" | Fill colour |
| `backBackgroundColor` | colour | "#333333" | Trough colour |
| `showBorder` / `borderColor` / `borderWidth` | bool / colour / px | true / "#000000" / 2 | The recipes set `showBorder: false` |
| `textureTrough` / `textureFill` | texture | — | Skin sprites |

Scripts: `bar.maxValue = n; bar.setValue(v)`.

## CanvasLayer2D

A HUD band: rendered after post-processing (never blooms) with a fixed camera. Same keys as
`Group2D` (`width`, `height`, transform, layout). Put score/time/lives/buttons under it.
Its ancestors' transform, opacity and visibility still apply.

## PostProcess

No transform — keys sit flat in `properties`. The first active one in the tree wins.
`affect2D` (true), `bloomEnabled`, `bloomIntensity` (1), `bloomThreshold` (0.9),
`bloomSmoothing`, `bloomRadius`, `vignetteEnabled`, `vignetteOffset`, `vignetteDarkness`,
`chromaticAberrationEnabled`, `chromaticAberrationOffset`. Bloom lifts only what is already
bright: brighten the colour or lower `bloomThreshold` rather than raising intensity.

## Example — a new HUD label anchored top-right

```yaml
- id: combo-label
  type: Label2D
  name: Combo Label
  properties:
    label: ""
    labelFontSize: 40
    labelColor: "#f5ae39"
    labelAlign: right
    transform:
      position: [340, 790]
      scale: [1, 1]
      rotation: 0
    layout:
      enabled: true
      horizontalAlign: right
      verticalAlign: top
  children: []
```
