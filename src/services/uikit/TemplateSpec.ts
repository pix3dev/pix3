/**
 * UI Kit Forge — templates: a composite delivered as PARTS PLUS A LAYOUT rather than as one
 * picture.
 *
 * Why (plan §3.3, §5): baking a dialog into a single PNG is unusable — without text half the
 * image is missing, and with a real `Button2D` on top it is drawn twice. Split into parts and
 * a layout it becomes exactly what a host needs: the editor host turns a {@link TemplateSpec}
 * into a `.pix3scene` prefab, the standalone host hands a human the parts and the JSON.
 *
 * The layout is derived from the showcase's settings screen (`showcase.ts:
 * scSettingsBase` and `SETTINGS_ROW`), translated from screen coordinates into the dialog's
 * own space: the showcase's panel starts at (16, 38), so a row at screen y 142 is at 104 here.
 *
 * This module produces DATA ONLY. It creates no nodes, touches no scene, and knows nothing
 * about the editor — a host decides what the tree becomes.
 */
import { C, LABEL_EDGE, faceFor, ink, type ForgeTheme, type PaletteId } from './ForgeTheme';
import { runBuild, type ForgeLang } from './build-context';
import { SETTINGS_ROW } from './showcase';
import { buildSkin, BUTTON_STATES, type ButtonSkinState, type SkinPart } from './SkinSpec';
import { tx } from './strings';

export type TemplateNodeType =
  | 'Group2D'
  | 'TiledSprite2D'
  | 'Sprite2D'
  | 'Button2D'
  | 'Label2D'
  | 'ColorRect2D';

export interface TemplateAnchor {
  h: 'left' | 'center' | 'right';
  v: 'top' | 'center' | 'bottom';
}

/**
 * Container flow: children stacked by the engine rather than by their authored positions.
 *
 * Mirrors `Node2D.flow`. A template still authors every child's rectangle, so a host whose
 * runtime has no flow yet draws exactly the same picture — the flow only decides where a row
 * ADDED BY HAND afterwards lands.
 */
export interface TemplateFlow {
  enabled: boolean;
  direction: 'vertical' | 'horizontal';
  gap: number;
  paddingX: number;
  paddingY: number;
  align: 'start' | 'center' | 'end';
  autoSize: boolean;
}

/**
 * The caption typography of a whole template, in DESIGN units — the same numbers the preview
 * draws with, so a prefab and the picture the user approved cannot drift.
 *
 * Two families, because a kit is bilingual and most display faces are Latin-only: a caption
 * picks `cyrFamily`/`cyrWeight` when its own characters need them (`ForgeTheme.faceFor`). A
 * CSS stack cannot express this — it carries one weight, and the Latin display faces are 400.
 */
export interface TemplateTypography {
  family: string;
  cyrFamily: string;
  weight: number;
  cyrWeight: number;
  /** Caption outline half-width, absolute px (`ForgeTheme.txtOut`). */
  outlineWidth: number;
  outlineColor: string;
  /** `null` when the theme's drop is too small to read as a shadow. */
  shadowColor: string | null;
  shadowOffsetX: number;
  shadowOffsetY: number;
  letterSpacing: number;
  /** Caption colour on the template's own panel ground. */
  inkColor: string;
}

/**
 * Caption size as a fraction of the element it sits in — the ratios the PREVIEW draws with,
 * lifted from the generators so the two cannot drift:
 * `compButton` (`skins/buttons.ts`) sizes its caption `h * 0.38`, `compHeaderPlate`
 * (`skins/panels.ts`) its title `h * 0.44`, and the showcase's settings row draws its label at
 * `SETTINGS_ROW.label` (23) inside a `SETTINGS_ROW.icon` (46) row — i.e. exactly half of it.
 * Body text is the odd one out (no generator draws a paragraph): 0.30 of the action-button
 * height puts it a step below a caption and a step above nothing.
 */
export const TEMPLATE_TYPE_SCALE = {
  buttonCaption: 0.38,
  headerTitle: 0.44,
  rowLabel: 0.5,
  bodyText: 0.3,
} as const;

/** A caption size in design px: a ratio of the element's own height, never a constant. */
function captionSize(elementHeight: number, ratio: number): number {
  return Math.max(8, Math.round(elementHeight * ratio));
}

/**
 * The caption recipe of one template, read off the theme through its own accessors.
 *
 * Both families are resolved here rather than left as a CSS stack: a stack carries ONE
 * weight, and the Latin display faces are weight 400, so a Cyrillic caption drawn through a
 * stack comes out thin. A host picks the family per caption (`isCyrText`).
 */
export function buildTypography(
  theme: ForgeTheme,
  colorRole: PaletteId,
  lang: ForgeLang | undefined
): TemplateTypography {
  return runBuild({ theme, lang }, () => {
    const latin = faceFor('A');
    // A Cyrillic probe, so the supplier answers rather than the primary.
    const cyr = faceFor('\u0410\u0430');
    const edge = LABEL_EDGE();
    return {
      family: latin.family,
      cyrFamily: cyr.family,
      weight: latin.weight,
      cyrWeight: cyr.weight,
      outlineWidth: Math.max(0, theme.txtOut),
      outlineColor: edge,
      // `label()` (svg-primitives) only draws the drop when it is above this threshold; below
      // it the shadow is invisible and would only cost the engine a second text pass.
      shadowColor: theme.txtDrop > 0.2 ? edge : null,
      shadowOffsetX: 0,
      shadowOffsetY: Math.max(0, theme.txtDrop),
      letterSpacing: Math.max(0, theme.track),
      inkColor: ink(C(colorRole)),
    };
  });
}

/**
 * The caption colour a role's ground asks for — `inkColor` of {@link buildTypography}, on its own.
 *
 * Exported because a caller that skins ONE node does not want a whole typography block: the T0
 * expander already has the manifest's recipe (which is judged against the kit's first role) and
 * only needs the per-button answer, since a green primary and a gray secondary do not take the
 * same ink. Kept next to `buildTypography` so the two can never disagree about how ink is
 * derived.
 */
export function captionInkForRole(theme: ForgeTheme, colorRole: PaletteId): string {
  return runBuild({ theme }, () => ink(C(colorRole)));
}

export interface TemplateNode {
  type: TemplateNodeType;
  /** Unique within the template — a host maps it onto a node name directly. */
  name: string;
  /** A key of {@link TemplateSpec.parts}: the art this node wears. */
  part?: string;
  /**
   * For a `Button2D`: the part for each of its four texture slots. Additive to §9.3's
   * `part` — a button needs four pictures, and `part` alone cannot say so. `part` still
   * carries the `normal` one, so a host that ignores this field renders a correct button.
   */
  states?: Partial<Record<ButtonSkinState, string>>;
  /** Position and size in the template's own space (design units), origin top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which edges of the parent this node sticks to — maps onto `Node2D.layout`. */
  anchor?: TemplateAnchor;
  /** Container flow — maps onto `Node2D.flow`. Only a container carries one. */
  flow?: TemplateFlow;
  /**
   * Caption size in DESIGN px, derived from this node's own height by
   * {@link TEMPLATE_TYPE_SCALE}. Present on every node that can carry a caption; the family,
   * weight, outline and shadow come from {@link TemplateSpec.typography}.
   */
  fontSize?: number;
  /** A caption the ENGINE draws (never baked into the art). */
  label?: string;
  children?: TemplateNode[];
}

export type TemplateId = 'dialog' | 'settings';

export interface TemplateSpec {
  id: TemplateId;
  /** Every picture the tree references, by key. */
  parts: Record<string, SkinPart>;
  /** How every caption in this tree is drawn. */
  typography: TemplateTypography;
  root: TemplateNode;
}

export interface TemplateOptions {
  width?: number;
  height?: number;
  title?: string;
  lang?: ForgeLang;
  /** The dialog's colour role. */
  colorRole?: PaletteId;
}

/** Geometry shared by both templates, in the dialog's own space. */
const LAYOUT = {
  headerH: 70,
  /** The close button, and its inset from the top-right corner. */
  closeSize: 54,
  closeInset: 10,
  closeTop: 8,
  /** The OK / Cancel row. */
  actionW: 160,
  actionH: 68,
  actionMargin: 24,
  /** The first settings row, measured from the dialog's top (showcase: screen 142 − panel 38). */
  firstRowY: 104,
} as const;

const DEFAULT_SIZE: Record<TemplateId, { w: number; h: number }> = {
  // The showcase's panel is `SCREEN_W − 32` wide; its settings variant is `700 − 72` tall.
  dialog: { w: 398, h: 300 },
  settings: { w: 398, h: 628 },
};

/** The glyph the close control wears (`icons.ts`). */
const CLOSE_ICON = 'close';

/** The rows the settings template lays out — the same three the showcase draws. */
const SETTINGS_ROWS: readonly string[] = ['set_sounds', 'set_haptic', 'set_notify'];

/**
 * Add one button's four state parts under `<prefix>-<state>` and return the name map.
 *
 * `icon` switches the part to an `icon-button`: a dialog's close control is a GLYPH, not a
 * word — a captioned one has to fit "Close" into a 54 px square, where it either overflows the
 * face or shrinks to unreadable, and it would need translating on top of that.
 */
function addButtonParts(
  parts: Record<string, SkinPart>,
  prefix: string,
  colorRole: PaletteId,
  width: number,
  height: number,
  theme: ForgeTheme,
  icon?: string
): Partial<Record<ButtonSkinState, string>> {
  const map: Partial<Record<ButtonSkinState, string>> = {};
  for (const state of BUTTON_STATES) {
    const key = `${prefix}-${state}`;
    parts[key] = buildSkin(
      icon
        ? { component: 'icon-button', colorRole, width, height, state, icon }
        : { component: 'button', colorRole, width, height, state },
      theme
    );
    map[state] = key;
  }
  return map;
}

/**
 * Build a dialog or a settings window as parts plus a layout.
 *
 * Node names are unique and every `part` / `states` key exists in `parts` — a host can walk
 * the tree and resolve art without a lookup ever failing.
 */
export function buildTemplate(
  id: TemplateId,
  theme: ForgeTheme,
  opts: TemplateOptions = {}
): TemplateSpec {
  const size = DEFAULT_SIZE[id];
  const w = Math.max(120, Math.round(opts.width ?? size.w));
  const h = Math.max(120, Math.round(opts.height ?? size.h));
  const colorRole: PaletteId = opts.colorRole ?? 'sky';
  const L = LAYOUT;
  const R = SETTINGS_ROW;

  // Captions are resolved in the requested language — the engine draws them, so they travel
  // as data on the nodes and never reach the art.
  const captions = runBuild({ theme, lang: opts.lang }, () => ({
    title: opts.title ?? tx(id === 'settings' ? 'set_title' : 'dlg_title'),
    body: tx('dlg_body'),
    ok: tx('dlg_ok'),
    cancel: tx('dlg_cancel'),
    on: tx('dlg_on'),
    rows: SETTINGS_ROWS.map(key => tx(key)),
  }));

  const parts: Record<string, SkinPart> = {
    'panel-body': buildSkin({ component: 'panel-body', colorRole, width: w, height: h }, theme),
    'header-plate': buildSkin(
      { component: 'header-plate', colorRole, width: w, height: L.headerH },
      theme
    ),
  };
  const closeStates = addButtonParts(
    parts,
    'close',
    'red',
    L.closeSize,
    L.closeSize,
    theme,
    CLOSE_ICON
  );
  const okStates = addButtonParts(parts, 'ok', 'green', L.actionW, L.actionH, theme);
  const cancelStates = addButtonParts(parts, 'cancel', 'gray', L.actionW, L.actionH, theme);

  const children: TemplateNode[] = [
    {
      type: 'TiledSprite2D',
      name: 'Frame',
      part: 'panel-body',
      x: 0,
      y: 0,
      w,
      h,
    },
    {
      type: 'TiledSprite2D',
      name: 'Header',
      part: 'header-plate',
      x: 0,
      y: 0,
      w,
      h: L.headerH,
      anchor: { h: 'left', v: 'top' },
    },
    {
      type: 'Label2D',
      name: 'Title',
      x: 0,
      y: 0,
      w,
      h: L.headerH,
      anchor: { h: 'center', v: 'top' },
      fontSize: captionSize(L.headerH, TEMPLATE_TYPE_SCALE.headerTitle),
      label: captions.title,
    },
    {
      type: 'Button2D',
      name: 'CloseButton',
      part: closeStates.normal,
      states: closeStates,
      x: w - L.closeInset - L.closeSize,
      y: L.closeTop,
      w: L.closeSize,
      h: L.closeSize,
      anchor: { h: 'right', v: 'top' },
      // No caption: the glyph IS the label, and a word here would be drawn on top of it.
      label: '',
    },
  ];

  if (id === 'settings') {
    const toggleStates = addButtonParts(parts, 'toggle', 'blue', R.toggle, 60, theme);
    const rowW = Math.max(80, w - R.padX * 2);
    const rowH = Math.max(R.icon, 60);
    const labelW = Math.max(40, rowW - R.toggle - R.gap);
    // The rows are a COLUMN, not three nodes at three hard-coded y's. The container owns the
    // spacing (`flow`), so a fourth row dropped in by hand lands where it belongs instead of on
    // top of the third — which is the whole reason flow exists next to the anchors.
    const rows: TemplateNode[] = captions.rows.map((text, i) => ({
      type: 'Group2D' as const,
      name: `Row${i + 1}`,
      x: 0,
      y: i * R.step,
      w: rowW,
      h: rowH,
      children: [
        {
          type: 'Label2D' as const,
          name: `Row${i + 1}Label`,
          x: 0,
          y: 0,
          w: labelW,
          h: rowH,
          anchor: { h: 'left', v: 'center' },
          fontSize: captionSize(R.icon, TEMPLATE_TYPE_SCALE.rowLabel),
          label: text,
        },
        {
          type: 'Button2D' as const,
          name: `Row${i + 1}Toggle`,
          part: toggleStates.normal,
          states: toggleStates,
          x: rowW - R.toggle,
          y: (rowH - 60) / 2,
          w: R.toggle,
          h: 60,
          anchor: { h: 'right', v: 'center' },
          fontSize: captionSize(60, TEMPLATE_TYPE_SCALE.buttonCaption),
          label: captions.on,
        },
      ],
    }));

    children.push({
      type: 'Group2D',
      name: 'Rows',
      x: R.padX,
      y: L.firstRowY,
      w: rowW,
      h: Math.max(rowH, rows.length * R.step - (R.step - rowH)),
      anchor: { h: 'center', v: 'top' },
      flow: {
        enabled: true,
        direction: 'vertical',
        gap: Math.max(0, R.step - rowH),
        paddingX: 0,
        paddingY: 0,
        align: 'center',
        autoSize: false,
      },
      children: rows,
    });
  } else {
    children.push({
      type: 'Label2D',
      name: 'Message',
      x: R.padX,
      y: L.headerH + R.gap * 2,
      w: w - R.padX * 2,
      h: Math.max(40, h - L.headerH - L.actionH - L.actionMargin * 2 - R.gap * 2),
      anchor: { h: 'center', v: 'top' },
      fontSize: captionSize(L.actionH, TEMPLATE_TYPE_SCALE.bodyText),
      label: captions.body,
    });
  }

  const actionY = h - L.actionMargin - L.actionH;
  children.push({
    type: 'Button2D',
    name: 'CancelButton',
    part: cancelStates.normal,
    states: cancelStates,
    x: L.actionMargin,
    y: actionY,
    w: L.actionW,
    h: L.actionH,
    anchor: { h: 'left', v: 'bottom' },
    fontSize: captionSize(L.actionH, TEMPLATE_TYPE_SCALE.buttonCaption),
    label: captions.cancel,
  });
  children.push({
    type: 'Button2D',
    name: 'OkButton',
    part: okStates.normal,
    states: okStates,
    x: w - L.actionMargin - L.actionW,
    y: actionY,
    w: L.actionW,
    h: L.actionH,
    anchor: { h: 'right', v: 'bottom' },
    fontSize: captionSize(L.actionH, TEMPLATE_TYPE_SCALE.buttonCaption),
    label: captions.ok,
  });

  return {
    id,
    parts,
    typography: buildTypography(theme, colorRole, opts.lang),
    root: {
      type: 'Group2D',
      name: id === 'settings' ? 'SettingsDialog' : 'Dialog',
      x: 0,
      y: 0,
      w,
      h,
      children,
    },
  };
}

/** Walk a template's tree depth-first, root included. */
export function walkTemplate(node: TemplateNode, visit: (n: TemplateNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkTemplate(child, visit);
}
