import { injectable, inject, injectLazy, type LazyService } from '@/fw/di';
import { appState } from '@/state';
import { AssetGenService } from '@/services/image-gen/AssetGenService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { rasterizeSvg, type SvgRasterSize } from '@/services/image-gen/svg-render';
import {
  BUTTON_STATES,
  PALETTE,
  buildSkin,
  buildTypography,
  engineLaneTheme,
  frameMeta,
  isNineSliceable,
  normalizeTheme,
  resolveIconName,
  skinBuildTheme,
  type ButtonSkinState,
  type ForgeTheme,
  type PaletteId,
  type RgbaBuffer,
  type SkinComponent,
  type SkinPart,
  type SkinSpec,
  type TemplateTypography,
} from '@/services/uikit';
import {
  UI_KIT_MANIFEST_PATH,
  UI_THEME_GENERATOR,
  UiKitThemeService,
} from '@/services/uikit-editor/UiKitThemeService';
import { iconPartKey, partKey } from '@/services/uikit-editor/skin-planner';
import {
  fetchGoogleFontFiles,
  fontFilePath,
  type FetchedFontFile,
  type FontFetchResult,
} from '@/services/uikit-editor/google-fonts';
import { loadProjectFonts } from '@pix3/runtime';
import type { ProjectService } from '@/services/project/ProjectService';
import type { ProjectFontFace } from '@/core/ProjectManifest';

/** Raster nine-slice insets, in pixels of the written PNG. */
export interface KitSliceBorder {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** One written picture, as `design/ui-kit.json` records it. */
export interface KitPartRecord {
  /** Project-relative path (no `res://`), e.g. `sprites/ui/1a2b3c4d/btn_green_normal_250x88.png`. */
  path: string;
  /** Raster size. */
  w: number;
  h: number;
  /** Insets in RASTER px, or `null` when the theme's silhouette is not nine-sliceable. */
  sliceBorder: KitSliceBorder | null;
  role: PaletteId | null;
  component: SkinComponent;
  state: ButtonSkinState | null;
  /** `icon-button` only: which glyph the picture carries. */
  icon?: string;
}

export interface KitManifest {
  version: string;
  generator: string;
  /** First 8 hex of a stable hash of the normalized theme — the folder name and the dedupe key. */
  kitId: string;
  /** Design units → raster px. */
  scale: number;
  createdAt: string;
  theme: ForgeTheme;
  /**
   * How captions are drawn on top of this kit's art — face, weight, outline, drop and tracking.
   *
   * Recorded here so applying a kit never has to rebuild the theme: the PNGs carry no text (the
   * engine draws every caption), and without this block a skinned button reverted to 16 px
   * Arial — a different kit from the one the page showed.
   */
  typography: TemplateTypography;
  parts: Record<string, KitPartRecord>;
  warnings: string[];
}

/**
 * How many parts are rasterized and written at once.
 *
 * Eight is where the win flattens on this workload: the work is I/O-shaped (an `<img>` decode
 * and a file write), so a handful in flight hides the waiting, while a much larger batch only
 * competes for the same decoder and makes the progress read jumpy.
 */
const BAKE_BATCH_SIZE = 8;

export interface KitWriteOptions {
  /** Design units → raster px. Defaults to the project manifest's `quality.maxPixelRatio`. */
  scale?: number;
  /** Which palette roles get buttons / panels / bar fills. Defaults to every role. */
  colorRoles?: readonly PaletteId[];
  /** Extra button sizes beyond {@link DEFAULT_BUTTON_SIZE}, in design units. */
  buttonSizes?: readonly { w: number; h: number }[];
  /**
   * Also download the theme's typefaces into `fonts/` and declare them in `pix3project.yaml`.
   * Default true — without the files the engine has only a family NAME and substitutes a system
   * face, which is the whole gap between the forge's preview and the game.
   */
  fonts?: boolean;
  /** Bake the glyph buttons of {@link ICON_BUTTON_GLYPHS}. Default true. */
  iconButtons?: boolean;
  /**
   * Bake only these glyphs (names or aliases of {@link ICON_BUTTON_GLYPHS}) instead of all of
   * them. Ignored when `iconButtons` is false.
   *
   * The middle ground the T0 expander needs: a recipe's HUD references no glyph at all, so the
   * expander bakes with `iconButtons: false` — but the dialog PREFAB it now also writes wears a
   * glyph close button, and one glyph is 4 pictures where the full set is 28.
   */
  iconButtonGlyphs?: readonly string[];
  /** Extra colour roles for EVERY glyph, beyond each glyph's own semantic role. */
  iconButtonRoles?: readonly PaletteId[];
  /** Progress ticks, so a panel can show "17 / 76" without polling. */
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface KitWriteResult {
  kitId: string;
  scale: number;
  /** Every project-relative path written, PNGs first, then the two JSON documents. */
  paths: string[];
  manifest: KitManifest;
  warnings: string[];
  /** Wall-clock time spent rasterizing and writing the parts, ms — the number a user feels. */
  elapsedMs: number;
}

export const KIT_MANIFEST_VERSION = '1.0';
export const UI_SPRITE_ROOT = 'sprites/ui';

/**
 * The size buttons are baked at.
 *
 * `Button2D` DOES carry `sliceBorder*` on this branch, so one source could in principle cover
 * every button size. It is still baked at a real size rather than a 64×64 stamp because the
 * gloss band's height is a PERCENT of the face (`ForgeTheme.glossH`) and the bevel lip is an
 * absolute number: stretching a tiny source vertically would smear both. 250×88 is the forge's
 * own default button, so what the preview shows is what the project gets.
 */
export const DEFAULT_BUTTON_SIZE = { w: 250, h: 88 } as const;

/**
 * The canonical design size of every non-button part. Each is nine-sliced onto whatever the node
 * is actually sized to, so these numbers decide texel density, not layout.
 */
const PART_SIZES: Record<
  Exclude<SkinComponent, 'button' | 'icon-button' | 'panel'>,
  { w: number; h: number }
> = {
  'panel-body': { w: 256, h: 256 },
  'header-plate': { w: 256, h: 70 },
  slot: { w: 320, h: 56 },
  checkbox: { w: 64, h: 64 },
  'checkbox-mark': { w: 64, h: 64 },
  'slider-track': { w: 240, h: 24 },
  'slider-thumb': { w: 48, h: 48 },
  'bar-trough': { w: 240, h: 36 },
  'bar-fill': { w: 240, h: 36 },
};

/**
 * The size a glyph button is baked at.
 *
 * Square, and NOT nine-sliced (`buildSkin` returns a null border for an icon button — the glyph
 * lives in the region a nine-slice stretches), so a node of another size scales this uniformly.
 */
export const ICON_BUTTON_SIZE = { w: 64, h: 64 } as const;

/**
 * The glyph buttons a kit ships, each with the role it means.
 *
 * One role per glyph rather than the full ten: the meaning is in the glyph (a close is red, a
 * plus is green), and 7 glyphs x 10 roles x 4 states would more than triple a bake for pictures
 * nothing asks for. `KitWriteOptions.iconButtonRoles` widens it when a caller wants more.
 *
 * Names are the ones `icons.ts` registers — "settings" is the `gear` glyph, and
 * `resolveIconName` accepts either spelling.
 */
export const ICON_BUTTON_GLYPHS: Readonly<Record<string, PaletteId>> = {
  close: 'red',
  gear: 'bluegray',
  plus: 'green',
  minus: 'red',
  left: 'blue',
  right: 'blue',
  check: 'green',
};

/** The parts that carry no colour role — one copy serves every role. */
const NEUTRAL_PARTS: readonly Exclude<SkinComponent, 'button' | 'icon-button' | 'panel'>[] = [
  'slot',
  'checkbox',
  'checkbox-mark',
  'slider-track',
  'slider-thumb',
  'bar-trough',
];

/** The parts baked once per colour role. */
const ROLE_PARTS: readonly Exclude<SkinComponent, 'button' | 'icon-button' | 'panel'>[] = [
  'panel-body',
  'header-plate',
  'bar-fill',
];

/**
 * A stable 32-bit FNV-1a over the theme's canonical JSON, as 8 lowercase hex.
 *
 * Stable across machines and sessions is the whole point (plan §7): the kit id is the folder
 * name, so re-baking an UNCHANGED theme overwrites the same files instead of littering the
 * project, while a re-theme writes a NEW folder and leaves the old skins in place — which is
 * exactly what makes Ctrl+Z on the property edit still show the previous art, and what
 * `export.pruneUnusedAssets` later collects.
 */
export function kitIdForTheme(theme: ForgeTheme): string {
  const canonical = canonicalJson(normalizeTheme(theme));
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** JSON with object keys sorted, so key order cannot change the hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

// The two key helpers live with the planner that consumes them; re-exported here because the
// manifest they address is this module's shape.
export { iconPartKey, partKey };

/**
 * Decode a PNG blob back to RGBA so `frameMeta` can measure it. Browser-only; returns `null`
 * wherever there is no canvas (a happy-dom spec), and the caller then falls back to scaling the
 * generator's own design-unit border.
 */
async function readRasterPixels(blob: Blob, w: number, h: number): Promise<RgbaBuffer | null> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    } finally {
      bitmap.close?.();
    }
  } catch {
    return null;
  }
}

/**
 * Bakes the engine lane of a {@link ForgeTheme} into the open project: PNG skins under
 * `sprites/ui/<kitId>/`, the manifest `design/ui-kit.json`, and the theme `design/ui-theme.json`.
 *
 * Two things are deliberately NOT here. There is no undo: binary writes are not reversible in
 * this editor and inventing a bulk-asset undo would be a worse trade than hash-named files that
 * simply stay on disk (plan §7). And there is no atlas packing: the project's own
 * `TextureAtlasService` packs at launch, and the kit has no business duplicating its caps.
 */
@injectable()
export class UiKitProjectWriter {
  @inject(AssetGenService)
  private readonly assets!: AssetGenService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(UiKitThemeService)
  private readonly themeService!: UiKitThemeService;

  // Lazy: the writer is constructed from the panel and from the T0 expander, and a static
  // dependency on the project service closes an initialisation cycle through the theme service.
  @injectLazy(async () => (await import('@/services/project/ProjectService')).ProjectService)
  private readonly projectService!: LazyService<ProjectService>;

  /**
   * Rasterization and pixel read-back are instance fields rather than imports so a spec can swap
   * them for stubs — both need a real browser canvas, and neither is what these tests are about.
   */
  rasterize: (svg: string, size: SvgRasterSize) => Promise<Blob> = rasterizeSvg;
  readPixels: (blob: Blob, w: number, h: number) => Promise<RgbaBuffer | null> = readRasterPixels;
  /** The typeface download — a network call a spec must be able to answer without one. */
  fetchFonts: (family: string, weight: number) => Promise<FontFetchResult> = fetchGoogleFontFiles;

  /**
   * Decode each baked PNG and check it for an empty frame.
   *
   * Off by default: it is one image decode per part — a hundred of them, for a check that only
   * fires when a generator is broken. A spec that wants the reading turns it on.
   */
  verifyPixels = false;

  /** The default raster scale: the quality preset's pixel-ratio ceiling, clamped to 1…4. */
  defaultScale(): number {
    const ratio = appState.project.manifest?.quality?.maxPixelRatio;
    const n = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 2;
    return Math.min(4, Math.max(1, Math.round(n)));
  }

  async writeKit(theme: ForgeTheme, options: KitWriteOptions = {}): Promise<KitWriteResult> {
    if (appState.project.status !== 'ready') {
      throw new Error('No project is open — cannot write the UI kit.');
    }

    const normalized = normalizeTheme(theme);
    const engineTheme = engineLaneTheme(normalized);
    const kitId = kitIdForTheme(normalized);
    const scale = options.scale ?? this.defaultScale();
    const roles: readonly PaletteId[] = options.colorRoles ?? PALETTE.map(entry => entry.id);
    const buttonSizes = [DEFAULT_BUTTON_SIZE, ...(options.buttonSizes ?? [])];

    const jobs = this.planJobs(roles, buttonSizes, normalized, options);
    const parts: Record<string, KitPartRecord> = {};
    const paths: string[] = [];
    const warnings: string[] = [];

    // Baked in BATCHES, not one at a time: a part is an SVG rasterization plus a file write, and
    // both spend most of their time waiting — the browser decodes one image while the next is
    // being handed to it. A hundred parts in sequence took 20-30 s of an editor session; the
    // batch keeps the same deterministic ORDER in the manifest (the results are written back by
    // index) while overlapping the waiting.
    const started = performance.now();
    let done = 0;
    const records: (KitPartRecord | null)[] = new Array(jobs.length).fill(null);
    for (let offset = 0; offset < jobs.length; offset += BAKE_BATCH_SIZE) {
      const batch = jobs.slice(offset, offset + BAKE_BATCH_SIZE);
      options.onProgress?.(done, jobs.length, batch[0]?.fileName ?? '');
      await Promise.all(
        batch.map(async (job, index) => {
          records[offset + index] = await this.writePart(job, kitId, scale, engineTheme, warnings);
          done += 1;
        })
      );
    }
    for (let index = 0; index < jobs.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      parts[jobs[index].key] = record;
      paths.push(record.path);
    }
    const elapsedMs = Math.round(performance.now() - started);
    options.onProgress?.(done, jobs.length, 'manifest');

    const manifest: KitManifest = {
      version: KIT_MANIFEST_VERSION,
      generator: UI_THEME_GENERATOR,
      kitId,
      scale,
      createdAt: new Date().toISOString(),
      theme: normalized,
      // The kit's own ground is the first requested role, so ink is judged against the colour
      // most of its captions actually sit on.
      typography: buildTypography(normalized, roles[0] ?? 'blue', undefined),
      parts,
      warnings,
    };

    await this.writeJson(UI_KIT_MANIFEST_PATH, manifest);
    paths.push(UI_KIT_MANIFEST_PATH);
    paths.push(await this.themeService.save());

    if (options.fonts !== false) {
      const fontPaths = await this.writeThemeFonts(manifest.typography, warnings);
      paths.push(...fontPaths);
    }

    return { kitId, scale, paths, manifest, warnings, elapsedMs };
  }

  /** Read back the manifest the last bake wrote, or `null` when the project has no kit yet. */
  async readManifest(): Promise<KitManifest | null> {
    try {
      const text = await this.storage.readTextFile(UI_KIT_MANIFEST_PATH);
      const parsed = JSON.parse(text) as KitManifest;
      return parsed && typeof parsed === 'object' && parsed.parts ? parsed : null;
    } catch {
      return null;
    }
  }

  // -- internals -------------------------------------------------------------

  private planJobs(
    roles: readonly PaletteId[],
    buttonSizes: readonly { w: number; h: number }[],
    theme: ForgeTheme,
    options: KitWriteOptions
  ): PartJob[] {
    const jobs: PartJob[] = [];

    for (const role of roles) {
      for (const size of buttonSizes) {
        for (const state of BUTTON_STATES) {
          const isDefaultSize =
            size.w === DEFAULT_BUTTON_SIZE.w && size.h === DEFAULT_BUTTON_SIZE.h;
          jobs.push({
            // Extra sizes get their own key so the default one stays addressable as
            // `button/<role>/<state>` — the key `ApplyUiKitSkinOperation` resolves.
            key: isDefaultSize
              ? partKey('button', role, state)
              : `${partKey('button', role, state)}@${size.w}x${size.h}`,
            component: 'button',
            role,
            state,
            width: size.w,
            height: size.h,
            fileName: `btn_${role}_${state}_${size.w}x${size.h}.png`,
            theme,
          });
        }
      }
      for (const component of ROLE_PARTS) {
        const size = PART_SIZES[component];
        jobs.push({
          key: partKey(component, role),
          component,
          role,
          state: null,
          width: size.w,
          height: size.h,
          fileName: `${component}_${role}_${size.w}x${size.h}.png`,
          theme,
        });
      }
    }

    if (options.iconButtons !== false) {
      const wanted = options.iconButtonGlyphs
        ? new Set(options.iconButtonGlyphs.map(name => resolveIconName(name)))
        : null;
      for (const [icon, semanticRole] of Object.entries(ICON_BUTTON_GLYPHS)) {
        if (wanted && !wanted.has(resolveIconName(icon))) continue;
        const iconRoles = [...new Set([semanticRole, ...(options.iconButtonRoles ?? [])])];
        for (const role of iconRoles) {
          for (const state of BUTTON_STATES) {
            jobs.push({
              key: iconPartKey(icon, role, state),
              component: 'icon-button',
              role,
              state,
              icon,
              width: ICON_BUTTON_SIZE.w,
              height: ICON_BUTTON_SIZE.h,
              fileName: `icon_${icon}_${role}_${state}_${ICON_BUTTON_SIZE.w}x${ICON_BUTTON_SIZE.h}.png`,
              theme,
            });
          }
        }
      }
    }

    for (const component of NEUTRAL_PARTS) {
      const size = PART_SIZES[component];
      jobs.push({
        key: partKey(component),
        component,
        role: null,
        state: null,
        width: size.w,
        height: size.h,
        fileName: `${component}_${size.w}x${size.h}.png`,
        theme,
      });
    }

    return jobs;
  }

  private async writePart(
    job: PartJob,
    kitId: string,
    scale: number,
    engineTheme: ForgeTheme,
    warnings: string[]
  ): Promise<KitPartRecord> {
    const spec: SkinSpec = {
      component: job.component,
      // The neutral parts ignore the role; `sky` is simply what the generator defaults to.
      colorRole: job.role ?? 'sky',
      width: job.width,
      height: job.height,
      ...(job.state ? { state: job.state } : {}),
      ...(job.icon ? { icon: job.icon } : {}),
    };
    const part: SkinPart = buildSkin(spec, job.theme);
    // The theme this PART was drawn with, which is the author's minus the gloss cap on a
    // stretchable shape. `frameMeta` re-derives the insets from it below, and handing it the
    // uncapped one is how a 256 px panel came back with a 228 px top inset (and squashed).
    const partTheme = skinBuildTheme(spec, engineTheme);

    const rasterW = Math.max(1, Math.round(part.w * scale));
    const rasterH = Math.max(1, Math.round(part.h * scale));
    const blob = await this.rasterize(part.svg, { width: rasterW, height: rasterH });

    const relativePath = `${UI_SPRITE_ROOT}/${kitId}/${job.fileName}`;
    const handle = await this.assets.importBlob(blob, 'image/png', part.svg);
    try {
      await this.assets.save(handle.id, relativePath);
    } finally {
      this.assets.discard(handle.id);
    }

    return {
      path: relativePath,
      w: rasterW,
      h: rasterH,
      sliceBorder: await this.measureBorder(
        blob,
        part,
        rasterW,
        rasterH,
        scale,
        partTheme,
        job,
        warnings
      ),
      role: job.role,
      component: job.component,
      state: job.state,
      ...(job.icon ? { icon: job.icon } : {}),
    };
  }

  /**
   * The nine-slice insets in RASTER px.
   *
   * The GENERATOR's own numbers, scaled — not a re-derivation from the theme. `buildSkin` knows
   * which shape it drew and answers accordingly: a `bevelRect` part through the general formula,
   * a recess or a fill (`slot`, `slider-track`, `bar-trough`, `bar-fill`) through the one that
   * matches how those are actually painted. Re-deriving here threw that away and handed a
   * 240x36 trough `{52, 52, 35, 35}` — insets that meet in the middle, so `Bar2D` squashed the
   * trough instead of extending it.
   *
   * The raster reading is still used for what only pixels can say: the frame is checked for a
   * body at all, and the insets are clamped so opposite caps cannot meet (the same
   * "a cap may not take more than half a side" rule the runtime slicer applies). Without a
   * canvas (a spec) the clamp is arithmetic on the frame size, which comes to the same thing.
   */
  private async measureBorder(
    blob: Blob,
    part: SkinPart,
    rasterW: number,
    rasterH: number,
    scale: number,
    partTheme: ForgeTheme,
    job: PartJob,
    warnings: string[]
  ): Promise<KitSliceBorder | null> {
    if (part.sliceBorder === null) {
      // Two different reasons, and only one is worth telling anyone about. A glyph button is
      // never sliced BY CONSTRUCTION — its icon sits in the middle, which is the region a
      // nine-slice stretches — so saying so once per state would bury the real message under 28
      // identical lines. A theme with `skew` or `puffy`, on the other hand, silently costs every
      // panel its nine-slice, and that the user has to know.
      if (job.component !== 'icon-button' && !isNineSliceable(partTheme)) {
        warnings.push(
          `${job.key}: the theme's skew/puffy bulges an edge, so this skin cannot be ` +
            'nine-sliced — it scales as a whole and its corners stretch with it.'
        );
      }
      return null;
    }

    const maxX = Math.max(0, Math.floor((rasterW - 1) / 2));
    const maxY = Math.max(0, Math.floor((rasterH - 1) / 2));
    const border: KitSliceBorder = {
      left: Math.min(Math.round(part.sliceBorder.left * scale), maxX),
      right: Math.min(Math.round(part.sliceBorder.right * scale), maxX),
      top: Math.min(Math.round(part.sliceBorder.top * scale), maxY),
      bottom: Math.min(Math.round(part.sliceBorder.bottom * scale), maxY),
    };

    if (this.verifyPixels) {
      // No `caps`: those belonged to another game's atlas, and this project's
      // TextureAtlasService applies its own (plan §9.1).
      const rgba = await this.readPixels(blob, rasterW, rasterH);
      if (rgba) {
        const meta = frameMeta({
          rgba,
          w: rasterW,
          h: rasterH,
          theme: partTheme,
          comp: { name: job.key, kind: job.component, w: part.w, h: part.h },
          scale,
        });
        // Only the findings a bitmap can make: an empty frame, or a shape with no opaque body.
        // The cap arithmetic is the generator's own answer above, not this one.
        for (const warning of meta.warnings) {
          if (/^empty|^no body/.test(warning)) warnings.push(`${job.key}: ${warning}`);
        }
      }
    }

    return border;
  }

  /**
   * Ship the kit's typefaces with the project: download each subset, write it under `fonts/`,
   * and merge the faces into `pix3project.yaml` so the runtime registers them before the first
   * frame. Idempotent by family+weight+style — re-baking never grows the list.
   *
   * Failures are warnings, not errors: a kit without its font files still applies, it just draws
   * in a system face until the fonts are added.
   */
  private async writeThemeFonts(
    typography: TemplateTypography,
    warnings: string[]
  ): Promise<string[]> {
    const wanted = [
      { family: typography.family, weight: typography.weight },
      { family: typography.cyrFamily, weight: typography.cyrWeight },
    ].filter(
      (entry, index, all) =>
        entry.family.length > 0 &&
        all.findIndex(o => o.family === entry.family && o.weight === entry.weight) === index
    );

    const written: string[] = [];
    const faces: ProjectFontFace[] = [];
    for (const entry of wanted) {
      const result = await this.fetchFonts(entry.family, entry.weight);
      warnings.push(...result.warnings);
      for (const file of result.files) {
        const path = fontFilePath(file);
        try {
          await this.writeFontFile(path, file);
          written.push(path);
          faces.push({
            family: file.family,
            path,
            weight: file.weight,
            style: 'normal',
            ...(file.unicodeRange ? { unicodeRange: file.unicodeRange } : {}),
          });
        } catch (error) {
          warnings.push(
            `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    if (faces.length > 0) {
      try {
        await this.mergeManifestFonts(faces);
      } catch (error) {
        warnings.push(
          `Fonts were written but pix3project.yaml could not be updated: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
      // Register the new faces with the editor's document right away: the project-open path
      // only loads what the manifest named at the time, so without this the viewport would keep
      // drawing the kit's captions in a substitute until the project was reopened.
      await loadProjectFonts(faces, {
        readBlob: resourcePath => this.storage.readBlob(resourcePath.replace(/^res:\/\//, '')),
      });
    }
    return written;
  }

  private async writeFontFile(path: string, file: FetchedFontFile): Promise<void> {
    const directory = path.slice(0, path.lastIndexOf('/'));
    if (directory) {
      try {
        await this.storage.createDirectory(directory);
      } catch {
        // already there
      }
    }
    await this.storage.writeBinaryFile(path, file.data);
  }

  /**
   * Merge faces into the manifest's `fonts` list, keyed by family+weight+style: a re-bake of the
   * same theme replaces its own entries and leaves anything the user added alone.
   */
  private async mergeManifestFonts(faces: readonly ProjectFontFace[]): Promise<void> {
    const project = await this.projectService();
    const manifest = await project.loadProjectManifest();
    const key = (face: ProjectFontFace): string => `${face.family}|${face.weight}|${face.style}`;
    const merged = new Map<string, ProjectFontFace>();
    for (const face of manifest.fonts ?? []) merged.set(key(face), face);
    for (const face of faces) merged.set(key(face), face);
    await project.saveProjectManifest({ ...manifest, fonts: [...merged.values()] });
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const directory = path.slice(0, path.lastIndexOf('/'));
    if (directory) {
      try {
        await this.storage.createDirectory(directory);
      } catch {
        // Already there; a genuine problem surfaces on the write below.
      }
    }
    await this.storage.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }
}

interface PartJob {
  key: string;
  component: SkinComponent;
  role: PaletteId | null;
  state: ButtonSkinState | null;
  icon?: string;
  width: number;
  height: number;
  fileName: string;
  theme: ForgeTheme;
}
