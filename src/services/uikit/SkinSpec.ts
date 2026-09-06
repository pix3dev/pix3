/**
 * UI Kit Forge — the ENGINE lane: one skin part, drawn to the exact size an engine node will
 * stretch it to, with the nine-slice insets it needs.
 *
 * Three rules separate this lane from the human/preview one (plan §3.5, §7, §9.3):
 *
 * 1. **`pad: 0` is forced.** The kit's default 24 px transparent margin lands INSIDE the
 *    frame, and a `Button2D` computes its hit box from `width`/`height` — about 20 % of the
 *    button would be dead border.
 * 2. **`feDropShadow` is not used.** Its blur differs by GPU and browser, so two
 *    collaborators regenerating one theme would get different bytes (§7), and at `pad: 0` the
 *    shadow would be clipped anyway. `shadowMode` is forced to 0.
 * 3. **No captions.** The engine draws them (`Button2D` / `UIControl2D` label), so the part is
 *    built with `stripText` on and carries no `<text>` at all (§3.4).
 *
 * The border comes from {@link sliceBorder} in DESIGN units (scale 1, pad 0) and maps
 * straight onto `TiledSprite2D.sliceBorderLeft/Right/Top/Bottom`. It is `null` when the theme
 * bulges or leans the edges — a `puffy` or `skew` shape is not nine-sliceable by
 * construction, and a host must render it per size instead (§3.2).
 */
import type { ForgeTheme, PaletteId } from './ForgeTheme';
import { runBuild } from './build-context';
import { glossIsTopStrip, sliceBorder, type SliceBorder } from './slices';
import {
  compBarFill,
  compBarTrough,
  compButton,
  compCheckMarkBox,
  compCheckboxBox,
  compHeaderPlate,
  compIconButton,
  compPanelBody,
  compPanelSlot,
  compSliderThumb,
  compSliderTrack,
  type ButtonSkinState,
} from './skins';

export type { ButtonSkinState };

/** The glyph an `icon-button` carries when the spec names none. */
export const DEFAULT_SKIN_ICON = 'close';

/**
 * The parts an engine node can wear today, plus the two a dialog is assembled from.
 *
 * `panel` is an alias of `panel-body`: a window is NOT one picture in this lane — it is a
 * body plus a header plate plus a close button, laid out by a `TemplateSpec` (§3.3).
 */
export type SkinComponent =
  | 'button'
  | 'icon-button'
  | 'panel'
  | 'panel-body'
  | 'header-plate'
  | 'slot'
  | 'checkbox'
  | 'checkbox-mark'
  | 'slider-track'
  | 'slider-thumb'
  | 'bar-trough'
  | 'bar-fill';

export interface SkinSpec {
  component: SkinComponent;
  colorRole: PaletteId;
  /** Design units — the part is rendered at EXACTLY this size. */
  width: number;
  height: number;
  /** Only meaningful for `button` and `icon-button`; defaults to `normal`. */
  state?: ButtonSkinState;
  /**
   * `icon-button` only: which glyph it carries (an {@link ICON_NAMES} name or one of the
   * function aliases, e.g. `settings` → `gear`). Defaults to `close`.
   *
   * Baking a glyph into the skin is safe where baking a CAPTION is not: glyphs are
   * language-independent, so a kit stays valid in every locale (plan §7).
   */
  icon?: string;
}

export interface SkinPart {
  svg: string;
  w: number;
  h: number;
  /** `null` = not nine-sliceable (skew / puffy). */
  sliceBorder: SliceBorder | null;
  state?: ButtonSkinState;
}

/** The theme as the engine lane uses it: no padding, no filter-based shadow. */
export function engineLaneTheme(theme: ForgeTheme): ForgeTheme {
  return { ...theme, pad: 0, shadowMode: 0 };
}

/** The two components whose skin is a button face and swaps texture per state. */
export type ButtonLikeComponent = 'button' | 'icon-button';

/**
 * The parts a node STRETCHES over an arbitrary rectangle through the nine-slice.
 *
 * A button is not one of them: it is baked at a real size (see `UiKitProjectWriter`'s
 * `DEFAULT_BUTTON_SIZE`), so its gloss may take whatever share of the face the theme asks for.
 */
export const STRETCHED_COMPONENTS: readonly SkinComponent[] = [
  'panel',
  'panel-body',
  'header-plate',
  'slot',
  'slider-track',
  'bar-trough',
  'bar-fill',
];

/**
 * The floor of the gloss cap, design px. Anything at or under this reads as a HIGHLIGHT rather
 * than as a two-tone face, whatever the corner radius is.
 */
export const MIN_GLOSS_BAND = 16;

/**
 * Keep a stretchable part's gloss band inside the top nine-slice inset.
 *
 * `theme.glossH` is a PERCENT OF THE FACE, so on a 256-tall panel the default 51 % is a 127 px
 * band — and `sliceBorder()` has to fold the whole band into the top inset (a nine-slice
 * stretches the middle, so a band crossing the boundary would grow with the node). Top and
 * bottom insets then eat 256 of any window shorter than ~2 × 127 and the frame squashes.
 *
 * The band is therefore capped at `max(radius, MIN_GLOSS_BAND)` design px for the stretchable
 * parts — the corner arc is already in the inset, so a band no taller than it costs nothing —
 * by lowering `glossH` for THIS build only. `glossType` is untouched: the look of the highlight
 * is the author's choice, its height is a structural constraint.
 */
export function capGlossForStretch(theme: ForgeTheme, height: number): ForgeTheme {
  if (!theme.glossOn || !glossIsTopStrip(theme)) return theme;

  const faceH = Math.max(1, height - 2 * theme.outline - theme.bevel);
  const cap = Math.max(theme.radius, MIN_GLOSS_BAND);
  // The band's own arithmetic, mirrored from `glossFor()` / `sliceBorder()`: a fixed offset
  // above the gloss rect plus its height.
  const offset = theme.glossType === 'dome' ? 2 : 0.7 * Math.max(2, theme.radius * 0.45);
  const maxGlossH = Math.max(0, ((cap - offset) / faceH) * 100);
  return theme.glossH <= maxGlossH ? theme : { ...theme, glossH: maxGlossH };
}

/**
 * Is this theme's silhouette nine-sliceable at all?
 *
 * `puffy` bulges the middle of every edge and `skew` leans the vertical ones — in both cases
 * no edge is uniform along its length, so stretching the middle slices flattens the shape.
 */
export function isNineSliceable(theme: ForgeTheme): boolean {
  return !(theme.skew > 0.1 || theme.puffy > 0.1);
}

/**
 * The theme ONE part is actually drawn with: the engine lane's, with the gloss capped when the
 * part is a stretchable one.
 *
 * Exported because a host that re-derives the slicing metadata from the rasterized pixels
 * (`UiKitProjectWriter` runs `frameMeta` over the PNG) has to hand `frameMeta` this theme, not the
 * author's: the two disagree exactly by the cap, and the host's answer is the one that reaches
 * `TiledSprite2D`. That mismatch was real — a 256 px panel came back with a 228 px top inset from
 * the writer while `buildSkin` reported 66.
 */
export function skinBuildTheme(spec: SkinSpec, theme: ForgeTheme): ForgeTheme {
  const base = engineLaneTheme(theme);
  return STRETCHED_COMPONENTS.includes(spec.component)
    ? capGlossForStretch(base, Math.max(1, Math.round(spec.height)))
    : base;
}

/**
 * Parts drawn by `recessRect` / `compBarFill` rather than `bevelRect`: no lip, no strip gloss,
 * so `sliceBorder()`'s bevel/gloss terms do not apply to them.
 *
 * Running the generic formula over a 240×36 trough returned `{52, 52, 35, 35}` — the half-side
 * clamp ate the whole frame and there was no stretchable middle at all, so `Bar2D` squashed the
 * trough instead of extending it. The non-uniform zone of these shapes is only the outline plus
 * the corner arc, plus the fixed-height shading band under the top edge (`recessRect`: depth `d`)
 * and the lip along the bottom (`d*0.8` for a recess, `bevel*0.7` for the fill).
 */
export const FLAT_COMPONENTS: readonly SkinComponent[] = [
  'slot',
  'slider-track',
  'bar-trough',
  'bar-fill',
];

export function flatPartBorder(
  component: SkinComponent,
  t: ForgeTheme,
  w: number,
  h: number
): SliceBorder {
  const ow = Math.max(1, t.outline);
  let r: number;
  let top: number;
  let bottom: number;
  if (component === 'bar-fill') {
    r = Math.min(t.radius * 0.55, h / 2);
    // gloss band at y=3 of height 0.3h on top, the dark lip of bevel*0.7 at the bottom
    top = Math.max(r, t.glossOn ? 3 + h * 0.3 : 0);
    bottom = Math.max(r, t.bevel * 0.7);
  } else {
    const d = Math.max(2, t.bevel * 0.6); // recessRect depth
    r =
      component === 'slider-track'
        ? h / 2
        : component === 'bar-trough'
          ? t.radius * 0.8
          : Math.min(h / 2, t.radius); // slot
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    top = Math.max(r, ow + d);
    bottom = Math.max(r, ow + d * 0.8);
  }
  const side = ow + r;
  const clampW = Math.max(0, Math.floor((w - 1) / 2));
  const clampH = Math.max(0, Math.floor((h - 1) / 2));
  return {
    left: Math.min(Math.ceil(side), clampW),
    right: Math.min(Math.ceil(side), clampW),
    top: Math.min(Math.ceil(ow + top), clampH),
    bottom: Math.min(Math.ceil(ow + bottom), clampH),
  };
}

/** Draw one part for the engine lane. */
export function buildSkin(spec: SkinSpec, theme: ForgeTheme): SkinPart {
  const w = Math.max(1, Math.round(spec.width));
  const h = Math.max(1, Math.round(spec.height));
  const t = skinBuildTheme(spec, theme);
  const state = spec.state ?? 'normal';

  const raw = runBuild({ theme: t, stripText: true }, () => {
    switch (spec.component) {
      case 'button':
        return compButton(spec.colorRole, '', w, h, { state });
      case 'icon-button':
        return compIconButton(spec.colorRole, spec.icon ?? DEFAULT_SKIN_ICON, w, h, { state });
      case 'panel':
      case 'panel-body':
        return compPanelBody(spec.colorRole, w, h);
      case 'header-plate':
        return compHeaderPlate('', spec.colorRole, w, h);
      case 'slot':
        return compPanelSlot(w, h);
      case 'checkbox':
        return compCheckboxBox(w, h);
      case 'checkbox-mark':
        return compCheckMarkBox(w, h);
      case 'slider-track':
        return compSliderTrack(w, h);
      case 'slider-thumb':
        return compSliderThumb(w, h);
      case 'bar-trough':
        return compBarTrough(w, h);
      case 'bar-fill':
        return compBarFill(spec.colorRole, w, h);
      default: {
        const never: never = spec.component;
        throw new Error(`UI Kit Forge: unknown skin component "${String(never)}"`);
      }
    }
  });

  // Design units in, design units out: scale 1 and pad 0, so the four numbers go straight
  // into TiledSprite2D's inspector fields.
  //
  // An icon button is the exception among the sliceable shapes: its glyph sits in the CENTRE,
  // which is the region a nine-slice stretches, so promising insets here would smear the glyph
  // on any node that is not exactly the baked size. It scales uniformly instead.
  const border = !isNineSliceable(t)
    ? null
    : spec.component === 'icon-button'
      ? null
      : FLAT_COMPONENTS.includes(spec.component)
        ? flatPartBorder(spec.component, t, raw.w, raw.h)
        : sliceBorder(t, { width: raw.w, height: raw.h, scale: 1, frameW: raw.w, frameH: raw.h });

  const part: SkinPart = { svg: raw.svg, w: raw.w, h: raw.h, sliceBorder: border };
  if (spec.component === 'button' || spec.component === 'icon-button') part.state = state;
  return part;
}

/** The four states of one button, in the order a `Button2D` names its texture slots. */
export const BUTTON_STATES: readonly ButtonSkinState[] = ['normal', 'hover', 'pressed', 'disabled'];

/**
 * Build all four states of a button at one size — they share their outer geometry.
 *
 * `component` widens it to a {@link ButtonLikeComponent}: a glyph button wears the same four
 * states, and a caller that omits the field still gets a captioned button.
 */
export function buildButtonStates(
  spec: Omit<SkinSpec, 'component' | 'state'> & { component?: ButtonLikeComponent },
  theme: ForgeTheme
): Record<ButtonSkinState, SkinPart> {
  const component: ButtonLikeComponent = spec.component ?? 'button';
  const out = {} as Record<ButtonSkinState, SkinPart>;
  for (const state of BUTTON_STATES) {
    out[state] = buildSkin({ ...spec, component, state }, theme);
  }
  return out;
}
