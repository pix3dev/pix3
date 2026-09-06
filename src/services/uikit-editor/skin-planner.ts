/**
 * Which kit part each UI node type wears, as PURE DATA.
 *
 * The mapping lives here rather than inside the operation because two callers need the same
 * answer against two different worlds: `ApplyUiKitSkinOperation` writes it onto LIVE nodes
 * through `UpdateObjectPropertyOperation`, and the T0 expander
 * (`PrototypeBootstrapService`) writes it into `.pix3scene` FILES through `applyScenePatches`
 * before any of those nodes exists. A duplicated table would drift the moment a texture slot is
 * renamed, and the file lane would go quietly wrong — the scene still loads, the skin just never
 * appears.
 *
 * Property names are the inspector/YAML ones, so a write is valid in both worlds unchanged.
 */
import {
  resolveIconName,
  type ButtonSkinState,
  type PaletteId,
  type SkinComponent,
} from '@/services/uikit';
import type {
  KitManifest,
  KitPartRecord,
  KitSliceBorder,
} from '@/services/uikit-editor/UiKitProjectWriter';

/**
 * The manifest key a node's property is resolved by.
 *
 * Lives here, not in the writer, so that a caller of the planner never has to import the writer
 * MODULE (which pulls the asset pipeline and the theme service behind it) just to name a part.
 */
export function partKey(
  component: SkinComponent,
  role?: PaletteId | null,
  state?: ButtonSkinState | null
): string {
  return [component, role ?? null, state ?? null].filter(Boolean).join('/');
}

/**
 * The manifest key a glyph button is resolved by: `icon-button/<glyph>/<role>/<state>`.
 *
 * The glyph is part of the key because a kit ships several of them, and {@link partKey} alone
 * (component/role/state) could only address one.
 */
export function iconPartKey(icon: string, role: PaletteId, state: ButtonSkinState): string {
  return ['icon-button', resolveIconName(icon), role, state].join('/');
}

/** One property write a skin implies. */
export interface SkinPropertyWrite {
  propertyPath: string;
  value: unknown;
  /**
   * `texture` = a picture slot; `border` = one of the four nine-slice scalars;
   * `typography` = part of the caption recipe (face, weight, outline, drop, tracking, size).
   */
  kind: 'texture' | 'border' | 'typography';
}

/** Node types that draw a caption and therefore take the kit's typography. */
export const CAPTION_NODE_TYPES: readonly string[] = [
  'Button2D',
  'Label2D',
  'Checkbox2D',
  'Slider2D',
];

/** The default `UIControl2D.labelFontSize`: a node still on it has never been sized by hand. */
export const DEFAULT_LABEL_FONT_SIZE = 16;

/** The caption size a button-like control of this height wears (the preview's own ratio). */
export function captionSizeForHeight(height: number): number {
  return Math.max(8, Math.round(Math.max(1, height) * 0.38));
}

export interface CaptionPlanOptions {
  /** The caption itself — a Cyrillic one is drawn by the supplier face, at ITS weight. */
  text?: string;
  /** The node's height, used only when its font size is still the default. */
  height?: number;
  /** The node's current `labelFontSize`; a hand-set size is never overwritten. */
  currentFontSize?: number;
}

/**
 * The caption recipe as property writes.
 *
 * Applying a kit used to touch only the art, so a skinned button kept 16 px Arial while the
 * page that designed it showed a display face at `height × 0.38` with the kit's outline — two
 * different kits on one screen. The manifest carries the recipe (`KitManifest.typography`), so
 * this is a lookup rather than a re-render.
 */
export function planCaptionPatches(
  manifest: KitManifest,
  nodeType: string,
  options: CaptionPlanOptions = {}
): SkinPropertyWrite[] {
  const t = manifest.typography;
  if (!t || !CAPTION_NODE_TYPES.includes(nodeType)) return [];

  const cyrillic = /[\u0400-\u04FF]/.test(options.text ?? '');
  const write = (propertyPath: string, value: unknown): SkinPropertyWrite => ({
    propertyPath,
    value,
    kind: 'typography',
  });
  // `Label2D` spells its outline `outlineWidth` / `outlineColor` (the inherited pair aliases them
  // and is not in its schema), so the write has to use the name the node's schema knows.
  const isLabel = nodeType === 'Label2D';
  const writes: SkinPropertyWrite[] = [
    write('labelFontFamily', cyrillic ? t.cyrFamily : t.family),
    write('labelFontWeight', cyrillic ? t.cyrWeight : t.weight),
    write(isLabel ? 'outlineWidth' : 'labelOutlineWidth', t.outlineWidth),
    write(isLabel ? 'outlineColor' : 'labelOutlineColor', t.outlineColor),
    write('labelShadowColor', t.shadowColor ?? ''),
    write('labelShadowOffsetX', t.shadowOffsetX),
    write('labelShadowOffsetY', t.shadowOffsetY),
    write('labelLetterSpacing', t.letterSpacing),
  ];
  // Size only when nobody has chosen one: a hand-tuned caption must survive a re-skin.
  const height = options.height ?? 0;
  if (
    height > 0 &&
    (options.currentFontSize ?? DEFAULT_LABEL_FONT_SIZE) === DEFAULT_LABEL_FONT_SIZE
  ) {
    writes.push(write('labelFontSize', captionSizeForHeight(height)));
  }
  return writes;
}

/** What a node type wears, so the mapping is readable in one place. */
type SkinPlanner = (
  manifest: KitManifest,
  role: PaletteId
) => { textures: Record<string, KitPartRecord | undefined>; borderFrom: string | null };

const PLANNERS: Record<string, SkinPlanner> = {
  Button2D: (m, role) => ({
    textures: {
      textureNormal: m.parts[partKey('button', role, 'normal')],
      textureHover: m.parts[partKey('button', role, 'hover')],
      texturePressed: m.parts[partKey('button', role, 'pressed')],
      textureDisabled: m.parts[partKey('button', role, 'disabled')],
    },
    borderFrom: partKey('button', role, 'normal'),
  }),
  Checkbox2D: m => ({
    textures: {
      textureBox: m.parts[partKey('checkbox')],
      // The kit draws one box; "checked" differs by the mark laid over it, which is its own
      // texture slot. Setting both keeps the node from falling back mid-toggle.
      textureBoxChecked: m.parts[partKey('checkbox')],
      textureMark: m.parts[partKey('checkbox-mark')],
    },
    // Checkbox2D carries no sliceBorder* — it is drawn at its own square size.
    borderFrom: null,
  }),
  Slider2D: (m, role) => ({
    textures: {
      textureTrack: m.parts[partKey('slider-track')],
      // A slider's fill and a bar's fill are the same picture in the kit; the generator has no
      // separate `slider-fill`.
      textureFill: m.parts[partKey('bar-fill', role)],
      textureThumb: m.parts[partKey('slider-thumb')],
    },
    borderFrom: partKey('slider-track'),
  }),
  Bar2D: (m, role) => ({
    textures: {
      textureTrough: m.parts[partKey('bar-trough')],
      textureFill: m.parts[partKey('bar-fill', role)],
    },
    borderFrom: partKey('bar-trough'),
  }),
  TiledSprite2D: (m, role) => ({
    textures: { texture: m.parts[partKey('panel-body', role)] },
    borderFrom: partKey('panel-body', role),
  }),
  Sprite2D: (m, role) => ({
    // Sprite2D stretches its one texture and has no nine-slice, so a panel body on it is only
    // right at the size it was baked at. Offered anyway: it is what a placeholder rectangle
    // wants, and the alternative is the user converting the node by hand first.
    textures: { texture: m.parts[partKey('panel-body', role)] },
    borderFrom: null,
  }),
};

/** The node types a kit knows how to skin. */
export const SKINNABLE_NODE_TYPES: readonly string[] = Object.keys(PLANNERS);

/** The interactive UI node types — the ones the T0 expander skins on its own. */
export const UI_CONTROL_NODE_TYPES: readonly string[] = [
  'Button2D',
  'Checkbox2D',
  'Slider2D',
  'Bar2D',
];

export function isSkinnableNodeType(nodeType: string): boolean {
  return nodeType in PLANNERS;
}

/**
 * Every property write dressing one node of `nodeType` in `manifest` implies.
 *
 * Empty when the type is not skinnable or the kit has none of its parts — a caller can treat an
 * empty plan as "nothing to do" without a second lookup.
 */
export function planSkinPatches(
  nodeType: string,
  manifest: KitManifest,
  role: PaletteId
): SkinPropertyWrite[] {
  const planner = PLANNERS[nodeType];
  if (!planner) return [];

  const plan = planner(manifest, role);
  const writes: SkinPropertyWrite[] = [];
  for (const [propertyPath, record] of Object.entries(plan.textures)) {
    if (!record) continue;
    writes.push({ propertyPath, value: textureRef(record), kind: 'texture' });
  }
  if (writes.length === 0) return writes;

  const border = plan.borderFrom ? (manifest.parts[plan.borderFrom]?.sliceBorder ?? null) : null;
  if (border) {
    for (const [propertyPath, value] of borderWrites(border)) {
      writes.push({ propertyPath, value, kind: 'border' });
    }
  }
  return writes;
}

/** A `TextureResourceRef` pointing at a kit part. */
export function textureRef(record: KitPartRecord): { type: 'texture'; url: string } {
  return { type: 'texture', url: `res://${record.path}` };
}

/** The four scalar inspector fields a nine-slice border is written through. */
function borderWrites(border: KitSliceBorder): [string, number][] {
  return [
    ['sliceBorderLeft', border.left],
    ['sliceBorderRight', border.right],
    ['sliceBorderTop', border.top],
    ['sliceBorderBottom', border.bottom],
  ];
}
