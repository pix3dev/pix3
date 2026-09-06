/**
 * UI Kit Forge — the STYLE CONTRACT: the kit's design tokens as JSON and the style guide as
 * Markdown.
 *
 * WHY. A sprite sheet plus a packer manifest tells a reader WHERE a picture is, not WHAT the
 * style is: which green means "the single main action", how thick the sticker outline is,
 * which rules a new call site must not break. Two artefacts carry that:
 *
 *   {@link buildTokensJson}      the tokens, resolved through `C()` — the theme's hue/sat/light
 *                                shift and the `palette` override applied, so the JSON says
 *                                what was actually painted;
 *   {@link buildStyleMarkdown}   the human-and-agent-readable guide: roles, tokens, the sprite
 *                                table (when frame metadata is passed in), the invariants and
 *                                the import steps.
 *
 * Both builders are PURE: no DOM, no download wrappers — writing a file is a host's job
 * (plan §4). The jam-august version also emitted a `game` section mirroring that project's
 * constants; it does not travel, and the invariants below are pix3's own (§9.1).
 */
import {
  C,
  DARK,
  DEFAULT_THEME,
  LABEL_EDGE,
  NAVY,
  PALETTE,
  faceSpecs,
  fontFamilies,
  fontW,
  hasCyr,
  ink,
  type ForgeTheme,
  type PaletteId,
} from './ForgeTheme';
import { runBuild } from './build-context';
import { TABS, listAll } from './registry';
import type { FrameMeta } from './slices';

/** The generator's name and the contract version a manifest records. */
export const GENERATOR = 'UI Kit Forge';
export const CONTRACT_VERSION = '3.0';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** `#rrggbb` + alpha (0..1) → a CSS `rgba()` string. */
function rgbaCss(hex: string, a: number): string {
  let h = String(hex).replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map(c => c + c)
      .join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.round(a * 100) / 100})`;
}

/** Escape a value for a Markdown table cell: pipes and line breaks would split the row. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Wrap a value in backticks for a table cell (with the pipe escape). */
function code(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return '`' + cell(v).replace(/`/g, "'") + '`';
}

function table(head: readonly string[], rows: readonly string[][]): string {
  const line = (cols: readonly string[]): string => '| ' + cols.join(' | ') + ' |';
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// 1. The tokens as JSON
// ---------------------------------------------------------------------------

export interface StyleDocOptions {
  /** The preset name the theme came from. */
  preset?: string | null;
  /** Timestamp override (tests); default: now. */
  now?: string | Date;
  /** The export scale the art was rasterized at, if known. */
  scale?: string | number;
}

export interface PaletteTokens {
  /** What the kit actually painted. */
  hex: string;
  /** The generator's generic hex, before the shift and the override. */
  base: string;
  /** `theme.palette[id]`, when the theme pinned it. */
  override: string | null;
  label: string;
  role: string;
  use: string | null;
}

export interface ForgeTokens {
  meta: {
    generator: string;
    version: string;
    generatedAt: string;
    preset: string | null;
    scale: string | null;
    /** Paste back into the tool to reproduce this exact kit. */
    theme: ForgeTheme;
    themeDefaults: ForgeTheme;
  };
  roles: Record<string, { palette: PaletteId; hex: string; use: string | null }>;
  palette: Record<string, PaletteTokens>;
  tones: {
    DARK: string;
    NAVY: string;
    ink: string;
    inkOnLight: string;
    txtColor: string;
  };
  shape: {
    radius: number;
    outline: number;
    bevel: number;
    pad: number;
    skew: number;
    puffy: number;
  };
  gloss: { on: boolean; type: string; heightPct: number; alphaPct: number };
  gradient: { on: boolean; k: number };
  shadow: {
    mode: number;
    dx: number;
    dy: number;
    blur: number;
    alphaPct: number;
    css: string | null;
  };
  label: {
    fill: string;
    edge: string;
    /** DOUBLED: `txtOut` is the visible band OUTSIDE the letter, while a centred stroke shows half of its width. */
    edgeW: number;
    drop: number;
    track: number;
    font: string;
    fontCyr: string;
    fontStack: string[];
    weight: number;
    faces: { family: string; weight: number; cyrillic: boolean }[];
  };
  components: { name: string; tab: string }[];
}

/** The kit's design tokens as a plain serializable object. */
export function buildTokensJson(theme: ForgeTheme, opts: StyleDocOptions = {}): ForgeTokens {
  const now = opts.now ? new Date(opts.now) : new Date();
  return runBuild({ theme }, () => {
    const roles: ForgeTokens['roles'] = {};
    for (const p of PALETTE) {
      roles[p.role] = { palette: p.id, hex: C(p.id), use: p.use ?? null };
    }

    const palette: Record<string, PaletteTokens> = {};
    for (const p of PALETTE) {
      palette[p.id] = {
        hex: C(p.id),
        base: p.hex,
        override: theme.palette?.[p.id] ?? null,
        label: p.label,
        role: p.role,
        use: p.use ?? null,
      };
    }

    const shadowMode = num(theme.shadowMode);
    const shadowA = num(theme.shadowA) / 100;

    return {
      meta: {
        generator: GENERATOR,
        version: CONTRACT_VERSION,
        generatedAt: now.toISOString(),
        preset: opts.preset ?? null,
        scale: opts.scale !== undefined ? String(opts.scale) : null,
        theme: { ...theme },
        themeDefaults: { ...DEFAULT_THEME },
      },
      roles,
      palette,
      tones: {
        DARK: DARK(),
        NAVY: NAVY(),
        ink: ink(DARK()),
        inkOnLight: ink('#ffffff'),
        txtColor: theme.txtColor,
      },
      shape: {
        radius: num(theme.radius),
        outline: num(theme.outline),
        bevel: num(theme.bevel),
        pad: num(theme.pad),
        skew: num(theme.skew),
        puffy: num(theme.puffy),
      },
      gloss: {
        on: !!num(theme.glossOn),
        type: theme.glossType,
        heightPct: num(theme.glossH),
        alphaPct: num(theme.glossA),
      },
      gradient: { on: !!num(theme.gradOn), k: num(theme.gradK) },
      shadow: {
        mode: shadowMode,
        dx: num(theme.shadowDx),
        dy: num(theme.shadowDy),
        blur: shadowMode === 2 ? num(theme.shadowBlur) : 0,
        alphaPct: num(theme.shadowA),
        css: shadowMode ? rgbaCss(NAVY(), shadowA) : null,
      },
      // The sticker recipe. `edge` is LABEL_EDGE(), not DARK(): the caption's outline is kept
      // apart from the shape's, and this table has to report what is drawn.
      label: {
        fill: ink(DARK()),
        edge: LABEL_EDGE(),
        edgeW: num(theme.txtOut) * 2,
        drop: num(theme.txtDrop),
        track: num(theme.track),
        font: theme.font,
        fontCyr: theme.fontCyr,
        fontStack: fontFamilies(),
        weight: fontW(),
        // Per-face weights, because a caption is drawn in ONE family chosen by its own
        // characters — not in a stack sharing the primary's weight (ForgeTheme: faceFor).
        faces: faceSpecs().map(sp => ({
          family: sp.family,
          weight: sp.weight,
          cyrillic: sp.cyr,
        })),
      },
      components: listAll().map(d => ({ name: d.name, tab: d.tab })),
    };
  });
}

// ---------------------------------------------------------------------------
// 2. The style guide as Markdown
// ---------------------------------------------------------------------------

/** What a host knows about one rasterized frame — a {@link FrameMeta}, or part of one. */
export type StyleDocFrame = Partial<FrameMeta> & { frame?: { w: number; h: number } };

function rolesTable(tokens: ForgeTokens): string {
  const rows = Object.values(tokens.palette).map(p => [
    code(p.role),
    code(p.label),
    code(p.hex),
    cell(p.use ?? `${p.label} — no assigned use`),
    p.override ? code(p.override) : '—',
  ]);
  return table(['role', 'palette id', 'resolved hex', 'used for', 'override'], rows);
}

function tokensTable(tok: ForgeTokens): string {
  const rows: [string, unknown, string][] = [
    ['radius', tok.shape.radius, 'corner radius of a button; a panel uses max(10, radius*1.6)'],
    ['outline', tok.shape.outline, 'the dark ring; a panel is drawn at outline+1'],
    ['bevel', tok.shape.bevel, 'the lip under the face — and how far a `pressed` button drops'],
    [
      'pad',
      tok.shape.pad,
      'transparent margin around each frame; the ENGINE lane forces 0 (a Button2D hit box counts it)',
    ],
    [
      'skew / puffy',
      `${tok.shape.skew} / ${tok.shape.puffy}`,
      'either above 0.1 means NOT nine-sliceable',
    ],
    [
      'gloss',
      tok.gloss.on
        ? `${tok.gloss.type}, h ${tok.gloss.heightPct}%, a ${tok.gloss.alphaPct}%`
        : 'off',
      "a 'strip'/'dome' band must stay inside the TOP nine-slice inset",
    ],
    ['gradient', tok.gradient.on ? `on, k ${tok.gradient.k}` : 'off', 'a vertical body gradient'],
    [
      'shadow',
      tok.shadow.mode
        ? `mode ${tok.shadow.mode}, dx ${tok.shadow.dx}, dy ${tok.shadow.dy}, blur ${tok.shadow.blur}, ${tok.shadow.css}`
        : 'off',
      'mode 1 = hard slab, 2 = blurred; the ENGINE lane draws none (blur is not byte-reproducible)',
    ],
    ['DARK (outline tone)', tok.tones.DARK, 'shape outlines and dark panels'],
    ['NAVY (recess tone)', tok.tones.NAVY, 'recesses, troughs, the inside of a slot'],
    ['label fill', tok.label.fill, "the caption colour on the kit's own dark ground"],
    ['label edge', tok.label.edge, 'the caption outline tone — separate from DARK'],
    ['label edgeW', tok.label.edgeW, 'absolute px at any caption or icon size (twice `txtOut`)'],
    ['label drop', tok.label.drop, 'the caption shadow offset, absolute px'],
    ['label track', tok.label.track, 'letter spacing, px'],
    [
      'font (latin)',
      `${tok.label.font} ${tok.label.weight}`,
      'the primary family, at its own declared weight',
    ],
    ['font (cyrillic)', tok.label.fontCyr, hasCyrLine(tok)],
  ];
  return table(
    ['token', 'kit value', 'what it means'],
    rows.map(r => [cell(r[0]), code(r[1]), cell(r[2])])
  );
}

function hasCyrLine(tok: ForgeTokens): string {
  // The face is chosen per CAPTION: a Cyrillic one is drawn in the supplier at the supplier's
  // OWN weight, because a CSS stack carries only one.
  return hasCyr(tok.label.font)
    ? `${tok.label.font} carries Cyrillic itself — one family for both`
    : `${tok.label.font} is Latin-only; Cyrillic comes from ${tok.label.fontCyr}. Faces: ` +
        tok.label.faces.map(sp => `${sp.family} ${sp.weight}`).join(' + ');
}

function anchorsCell(anchors: StyleDocFrame['anchors']): string {
  if (!Array.isArray(anchors) || !anchors.length) return '—';
  return cell(
    anchors
      .map(a => {
        const s = a.sample !== undefined ? ` "${a.sample}"` : '';
        return `${a.role || 'label'}@${a.x},${a.y} ${a.size}px ${a.align || 'center'}${s}`;
      })
      .join('; ')
  );
}

function spritesTable(frames: Record<string, StyleDocFrame>): string {
  const names = Object.keys(frames).sort();
  const rows = names.map(n => {
    const f = frames[n] || {};
    const fr = f.frame || f.sourceSize;
    const size = fr ? `${fr.w}×${fr.h}` : '—';
    const border = f.border;
    const insets = border ? `${border.left}/${border.right}/${border.top}/${border.bottom}` : null;
    return [
      code(n),
      cell(size),
      insets ? code(insets) : '—',
      f.midY !== undefined ? code(f.midY) : '—',
      anchorsCell(f.anchors),
      Array.isArray(f.warnings) && f.warnings.length ? cell(f.warnings.join('; ')) : '—',
    ];
  });
  return table(['name', 'frame', 'border L/R/T/B', 'midY', 'caption anchors', 'warnings'], rows);
}

function componentsSection(tokens: ForgeTokens): string {
  const out: string[] = [];
  for (const t of TABS) {
    if (t.noExport) continue;
    const names = tokens.components.filter(d => d.tab === t.id).map(d => d.name);
    if (!names.length) continue;
    out.push(`- **${t.id}** (${names.length}): ${names.map(n => '`' + n + '`').join(', ')}`);
  }
  return out.join('\n');
}

/**
 * The style guide as a Markdown string.
 *
 * Sections: title and statement; Roles; Tokens; Sprites (only when `frames` is given);
 * Components; Invariants; How to use the kit in a pix3 project; Reproduce.
 */
export function buildStyleMarkdown(
  theme: ForgeTheme,
  frames?: Record<string, StyleDocFrame> | null,
  opts: StyleDocOptions = {}
): string {
  const tok = buildTokensJson(theme, opts);
  const presetName = opts.preset ?? null;
  const hasFrames = !!frames && typeof frames === 'object' && Object.keys(frames).length > 0;

  const s: string[] = [];
  s.push(`# ${presetName ? presetName + ' — ' : ''}UI kit style contract`);
  s.push('');
  s.push(
    `Generated by ${GENERATOR} ${CONTRACT_VERSION} on ${tok.meta.generatedAt}` +
      (presetName ? ` from the **${presetName}** preset` : '') +
      (tok.meta.scale ? ` (scale ${tok.meta.scale})` : '') +
      '.'
  );
  s.push('');
  s.push(
    'This kit is a parametric set of chunky glossy UI backings (buttons, square and hex icon ' +
      'buttons, panels, bars, cards, toggles) drawn as SVG from ONE theme object. Captions are ' +
      'never baked into the art: the engine draws them at runtime, so every stripped caption is ' +
      'recorded as an anchor. This document is the style contract that the pictures alone cannot ' +
      'carry — the colours by role, the shape numbers, the per-sprite slicing facts, and the ' +
      'rules a new call site must not break. The tokens JSON carries the same numbers ' +
      'machine-readably.'
  );
  s.push('');

  s.push('## Roles');
  s.push('');
  s.push(
    'The colour carries the STATE; the caption is always the same sticker. Hex values are what ' +
      'the current theme actually produced (the hue/sat/light shift and the absolute `palette` ' +
      'override applied).'
  );
  s.push('');
  s.push(rolesTable(tok));
  s.push('');

  s.push('## Tokens');
  s.push('');
  s.push(
    'Kit values are design px of the SVG space; a rasterizing host multiplies them by its export scale.'
  );
  s.push('');
  s.push(tokensTable(tok));
  s.push('');

  s.push('## Sprites');
  s.push('');
  if (hasFrames) {
    s.push(
      'One row per frame. `border` is the nine-slice inset from each edge — it maps directly onto ' +
        "`TiledSprite2D.sliceBorderLeft/Right/Top/Bottom`; `midY` is the body's optical centre as " +
        'a fraction of the frame height; anchors are where stripped captions belonged.'
    );
    s.push('');
    s.push(spritesTable(frames));
  } else {
    s.push(
      '_No frame metadata was passed to this build — rasterize the kit first and hand the ' +
        '`frameMeta()` records to `buildStyleMarkdown(theme, frames)` to get the per-sprite table._'
    );
  }
  s.push('');

  s.push('## Components');
  s.push('');
  s.push(
    'The exportable inventory by tab (the showcase screens are specification only and never ship ' +
      'as sprites):'
  );
  s.push('');
  s.push(componentsSection(tok));
  s.push('');

  s.push('## Invariants');
  s.push('');
  s.push('Rules of the pix3 engine an integrator MUST keep.');
  s.push('');
  const inv = [
    '**Captions are drawn by the ENGINE, never baked.** A `Button2D` / `UIControl2D` draws its ' +
      'own label (`label` / `labelKey` / `labelFontSize` / `labelColor` / `labelAlign`), and a ' +
      '`Label2D` is the node with a text outline. So every PNG this kit produces for the engine ' +
      'carries NO text: the kit is built with `stripText` on, and each frame reports `anchors` — ' +
      'the position, size, alignment and role of each caption it skipped — so a host knows where ' +
      'to put the real, localizable label.',

    "**Engine-lane skins use `pad: 0`.** The kit's default 24 px transparent margin lands INSIDE " +
      'the frame, and a `Button2D` computes its hit box from `width`/`height` — roughly 20 % of ' +
      'the button would be a dead border. `buildSkin()` forces `pad: 0`; the padding stays a ' +
      'default of the human preview and of a loose SVG export only.',

    '**Nine-slice insets come from the manifest, not from a guess.** The generator knows its own ' +
      '`radius`, `bevel`, `outline`, gloss band and shadow, so it reports the four insets rather ' +
      'than leaving a consumer to measure them. They map one-to-one onto ' +
      '`TiledSprite2D.sliceBorderLeft/Right/Top/Bottom`, which is what lets ONE 64×64 frame cover ' +
      'a window of any size. A theme with `skew` or `puffy` above 0.1 reports `sliceBorder: null` ' +
      '— those silhouettes are not nine-sliceable by construction and must be rendered per size.',

    '**The four button states share one silhouette.** `normal` / `hover` / `pressed` / `disabled` ' +
      'differ only in the face colour, the face offset and the ink; the outer shell is drawn from ' +
      'the same rectangle. A `Button2D` can therefore swap `textureNormal` / `textureHover` / ' +
      '`texturePressed` / `textureDisabled` without the button jumping.',

    '**No `feDropShadow` in the engine lane.** Filter blur differs by GPU and browser, so two ' +
      'collaborators regenerating the same theme would produce different bytes — different files ' +
      'to sync and a missed atlas-cache hit. `buildSkin()` forces `shadowMode: 0`; a shadow that ' +
      'has to be there belongs in the art of the shape, not in a filter.',

    '**The theme JSON reproduces the kit.** `meta.theme` below is the whole input: the same theme ' +
      'and the same component name give a byte-identical SVG, because the id counter is reset per ' +
      'top-level build. Store it (a project keeps it in `design/ui-theme.json`) rather than ' +
      'storing only the pictures.',
  ];
  inv.forEach((txt, i) => {
    s.push(`${i + 1}. ${txt}`);
    s.push('');
  });

  s.push('## How to use the kit in a pix3 project');
  s.push('');
  const steps = [
    'Rasterize each part and save it under `sprites/ui/` with a name derived from the spec ' +
      '(component, role, size, state), so identical requests deduplicate and a re-theme writes new ' +
      'files rather than mutating old ones.',
    "A window frame is a `TiledSprite2D` wearing the `panel-body` part with the manifest's four " +
      '`sliceBorder*` values; it then stretches to any size. The header plate is a second ' +
      '`TiledSprite2D` anchored to the top.',
    'A button is a `Button2D` with all four state textures set. Its caption is a node property, ' +
      'not part of the picture.',
    'A dialog or a settings window is a `TemplateSpec`: parts plus a layout. Turn it into a ' +
      '`.pix3scene` and instance it — pix3 has no separate prefab format, an instanced scene IS ' +
      'the prefab.',
    'Keep the theme in `design/ui-theme.json` next to `design/style.md`, and regenerate rather ' +
      'than hand-editing a PNG.',
  ];
  steps.forEach((txt, i) => s.push(`${i + 1}. ${txt}`));
  s.push('');

  s.push('## Reproduce');
  s.push('');
  s.push('Paste this theme back into the forge to regenerate this exact kit:');
  s.push('');
  s.push('```json');
  s.push(JSON.stringify(tok.meta.theme, null, 2));
  s.push('```');
  s.push('');
  return s.join('\n');
}
