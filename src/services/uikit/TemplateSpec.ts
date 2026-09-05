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
import type { ForgeTheme, PaletteId } from './ForgeTheme';
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
  /** A caption the ENGINE draws (never baked into the art). */
  label?: string;
  children?: TemplateNode[];
}

export type TemplateId = 'dialog' | 'settings';

export interface TemplateSpec {
  id: TemplateId;
  /** Every picture the tree references, by key. */
  parts: Record<string, SkinPart>;
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
    const labelX = R.padX + R.icon + R.gap;
    const ctrlX = w - R.padX - R.toggle;
    captions.rows.forEach((text, i) => {
      const rowY = L.firstRowY + i * R.step;
      children.push({
        type: 'Label2D',
        name: `Row${i + 1}Label`,
        x: labelX,
        y: rowY,
        w: Math.max(40, ctrlX - R.gap - labelX),
        h: R.icon,
        anchor: { h: 'left', v: 'top' },
        label: text,
      });
      children.push({
        type: 'Button2D',
        name: `Row${i + 1}Toggle`,
        part: toggleStates.normal,
        states: toggleStates,
        x: ctrlX,
        y: rowY - 4,
        w: R.toggle,
        h: 60,
        anchor: { h: 'right', v: 'top' },
        label: captions.on,
      });
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
    label: captions.ok,
  });

  return {
    id,
    parts,
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
